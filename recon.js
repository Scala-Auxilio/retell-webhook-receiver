// ─── Reconciliation counts ───────────────────────────────────────────────────
// Read-only aggregates for the Paperclip Reconciliation Checker, so it can
// compare what the receiver stored with what Retell reports without holding a
// database login. Every route needs the x-notify-secret header. Responses hold
// counts and timestamps only: no transcript, phone number, name or payload.
"use strict";

const MAX_WINDOW_MS = 31 * 24 * 60 * 60 * 1000;
const DEFAULT_WINDOW_MS = 24 * 60 * 60 * 1000;

// Parses ?since=&until= (ISO 8601). Defaults: until = now, since = until - 24h.
function parseWindow(query = {}) {
  const until = query.until ? new Date(query.until) : new Date();
  if (Number.isNaN(until.getTime())) return { error: "until must be an ISO 8601 timestamp" };
  const since = query.since ? new Date(query.since) : new Date(until.getTime() - DEFAULT_WINDOW_MS);
  if (Number.isNaN(since.getTime())) return { error: "since must be an ISO 8601 timestamp" };
  if (since >= until) return { error: "since must be before until" };
  if (until - since > MAX_WINDOW_MS) return { error: "window must be 31 days or shorter" };
  return { since, until };
}

const int = (v) => parseInt(v, 10) || 0;

function registerRoutes(app, pool, { requireAuth } = {}) {
  // No default: registering these routes without auth must fail loudly, not open them.
  if (typeof requireAuth !== "function") throw new Error("recon registerRoutes: requireAuth is required");

  /**
   * GET /recon/counts?since=<ISO>&until=<ISO>
   *
   * Per Retell agent id, within [since, until):
   *   events, call_started, call_ended, call_analyzed, distinct_calls,
   *   calls_with_transcript, scored_calls (distinct call ids that have a row
   *   in interaction_scores, whenever that row was written)
   * Plus notifications sent and failed in the window.
   */
  app.get("/recon/counts", requireAuth, async (req, res) => {
    const w = parseWindow(req.query);
    if (w.error) return res.status(400).json({ error: w.error });
    try {
      const events = await pool.query(`
        SELECT agent_id,
               COUNT(*)                                             AS events,
               COUNT(*) FILTER (WHERE event_type = 'call_started')  AS call_started,
               COUNT(*) FILTER (WHERE event_type = 'call_ended')    AS call_ended,
               COUNT(*) FILTER (WHERE event_type = 'call_analyzed') AS call_analyzed,
               COUNT(DISTINCT call_id)                              AS distinct_calls,
               COUNT(DISTINCT call_id) FILTER (WHERE transcript IS NOT NULL AND transcript <> '') AS calls_with_transcript
        FROM retell_events
        WHERE received_at >= $1 AND received_at < $2
        GROUP BY agent_id
        ORDER BY agent_id
      `, [w.since, w.until]);

      const scored = await pool.query(`
        SELECT e.agent_id, COUNT(DISTINCT e.call_id) AS scored_calls
        FROM retell_events e
        JOIN interaction_scores s ON s.call_id = e.call_id
        WHERE e.received_at >= $1 AND e.received_at < $2
        GROUP BY e.agent_id
      `, [w.since, w.until]);
      const scoredByAgent = new Map(scored.rows.map(r => [r.agent_id, int(r.scored_calls)]));

      const notifications = await pool.query(`
        SELECT COUNT(*) FILTER (WHERE status = 'sent')   AS sent,
               COUNT(*) FILTER (WHERE status = 'failed') AS failed
        FROM notifications
        WHERE sent_at >= $1 AND sent_at < $2
      `, [w.since, w.until]);
      const n = notifications.rows[0] || {};

      const agents = events.rows.map(r => ({
        agent_id: r.agent_id,
        events: int(r.events),
        call_started: int(r.call_started),
        call_ended: int(r.call_ended),
        call_analyzed: int(r.call_analyzed),
        distinct_calls: int(r.distinct_calls),
        calls_with_transcript: int(r.calls_with_transcript),
        scored_calls: scoredByAgent.get(r.agent_id) || 0,
      }));

      res.json({
        window: { since: w.since.toISOString(), until: w.until.toISOString() },
        totals: {
          events: agents.reduce((s, a) => s + a.events, 0),
          distinct_calls: agents.reduce((s, a) => s + a.distinct_calls, 0),
          scored_calls: agents.reduce((s, a) => s + a.scored_calls, 0),
        },
        agents,
        notifications: { sent: int(n.sent), failed: int(n.failed) },
      });
    } catch (err) {
      console.error("[RECON] counts failed:", err.message);
      res.status(500).json({ error: err.message });
    }
  });

  /**
   * GET /recon/scores-by-source?since=<ISO>&until=<ISO>
   *
   * How many rows in interaction_scores came from which writer: grouped by
   * scored_by (human, auto-haiku, interaction_scorer_agent, ...),
   * rubric_version and agent_type, with the first and last scored_at.
   * Without since/until it covers all time.
   */
  app.get("/recon/scores-by-source", requireAuth, async (req, res) => {
    let w = null;
    if (req.query.since || req.query.until) {
      w = parseWindow(req.query);
      if (w.error) return res.status(400).json({ error: w.error });
    }
    try {
      const where = w ? "WHERE scored_at >= $1 AND scored_at < $2" : "";
      const params = w ? [w.since, w.until] : [];
      const result = await pool.query(`
        SELECT scored_by, rubric_version, agent_type,
               COUNT(*)      AS scores,
               MIN(scored_at) AS first_scored_at,
               MAX(scored_at) AS last_scored_at
        FROM interaction_scores
        ${where}
        GROUP BY scored_by, rubric_version, agent_type
        ORDER BY scores DESC, scored_by, rubric_version, agent_type
      `, params);
      res.json({
        window: w ? { since: w.since.toISOString(), until: w.until.toISOString() } : "all",
        total: result.rows.reduce((s, r) => s + int(r.scores), 0),
        sources: result.rows.map(r => ({
          scored_by: r.scored_by,
          rubric_version: r.rubric_version,
          agent_type: r.agent_type,
          scores: int(r.scores),
          first_scored_at: r.first_scored_at,
          last_scored_at: r.last_scored_at,
        })),
      });
    } catch (err) {
      console.error("[RECON] scores-by-source failed:", err.message);
      res.status(500).json({ error: err.message });
    }
  });
}

module.exports = { registerRoutes, parseWindow };
