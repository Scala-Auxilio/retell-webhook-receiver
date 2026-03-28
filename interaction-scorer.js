/**
 * Scala Auxilium — Interaction Scorer Module
 *
 * Provides endpoints for the Paperclip Interaction Scorer agent to:
 *   1. Fetch unscored call transcripts
 *   2. Submit interaction scores
 *   3. Retrieve score history and trends
 *
 * Scoring rubric is based on the Aria SDR Performance Rubric for Sendsteps
 * and the EconoWind Lead Prioritization Dashboard.
 *
 * Environment variables:
 *   (uses existing DATABASE_URL from index.js — pool passed via init())
 */

// ─── Scoring Rubric (Sendsteps Aria SDR) ──────────────────────────────────────

const ARIA_RUBRIC = {
  dimensions: [
    {
      id: "opening",
      name: "Opening & Introduction",
      weight: 15,
      criteria: [
        "Greeted the prospect by name",
        "Identified self and Sendsteps clearly",
        "Included GDPR recording disclosure",
        "Confirmed they reached the right person",
      ],
      scoring: "0-3: 0=skipped, 1=partial, 2=good, 3=excellent",
    },
    {
      id: "qualification",
      name: "Qualification & Discovery",
      weight: 20,
      criteria: [
        "Asked about current presentation tools/workflows",
        "Identified pain points or needs",
        "Adapted to prospect's role (faculty vs procurement)",
        "Showed genuine curiosity (not just reading a script)",
      ],
      scoring: "0-3: 0=skipped, 1=partial, 2=good, 3=excellent",
    },
    {
      id: "value_proposition",
      name: "Value Proposition & Pitch",
      weight: 20,
      criteria: [
        "Communicated Sendsteps value clearly",
        "Tailored pitch to prospect's specific needs",
        "Mentioned relevant features (interactive presentations, AI, audience engagement)",
        "Used concrete examples or use cases",
      ],
      scoring: "0-3: 0=skipped, 1=partial, 2=good, 3=excellent",
    },
    {
      id: "objection_handling",
      name: "Objection Handling",
      weight: 15,
      criteria: [
        "Acknowledged objections without dismissing them",
        "Provided relevant counterpoints or clarifications",
        "Remained calm and professional when challenged",
        "Pivoted appropriately when prospect was not interested",
      ],
      scoring: "0-3: 0=skipped/NA, 1=poor, 2=good, 3=excellent",
    },
    {
      id: "meeting_cta",
      name: "Meeting CTA & Closing",
      weight: 20,
      criteria: [
        "Proposed a clear next step (demo meeting)",
        "Offered specific time slots or booking path",
        "Collected/confirmed email address",
        "Confirmed meeting details before ending",
      ],
      scoring: "0-3: 0=no attempt, 1=weak, 2=good, 3=excellent (booked)",
    },
    {
      id: "conversation_quality",
      name: "Conversation Quality",
      weight: 10,
      criteria: [
        "Natural conversational flow (not robotic)",
        "Appropriate pacing — paused for prospect to speak",
        "Did not talk over the prospect",
        "Handled interruptions gracefully",
      ],
      scoring: "0-3: 0=very poor, 1=below average, 2=good, 3=excellent",
    },
  ],
  outcomes: [
    "meeting_booked",
    "callback_requested",
    "not_interested",
    "wrong_person",
    "voicemail",
    "no_answer",
    "technical_issue",
    "gatekeeper_block",
  ],
};

// ─── EconoWind VentoBot Rubric ──────────────────────────────────────────────

const ECONOWIND_RUBRIC = {
  dimensions: [
    {
      id: "fleet_discovery",
      name: "Fleet & Vessel Discovery",
      weight: 25,
      criteria: [
        "Identified company/fleet name",
        "Asked about vessel types and fleet size",
        "Inquired about CII rating or regulatory pressure",
        "Explored current wind-assist awareness",
      ],
      scoring: "0-3: 0=skipped, 1=partial, 2=good, 3=excellent",
    },
    {
      id: "need_qualification",
      name: "Need Qualification",
      weight: 25,
      criteria: [
        "Identified timeline (drydock, retrofit window)",
        "Explored route patterns (wind exposure potential)",
        "Discussed fuel cost or emission reduction goals",
        "Assessed decision-making authority and process",
      ],
      scoring: "0-3: 0=skipped, 1=partial, 2=good, 3=excellent",
    },
    {
      id: "product_education",
      name: "Product Education",
      weight: 20,
      criteria: [
        "Explained EnergySail concept clearly",
        "Provided relevant performance data or case studies",
        "Addressed technical feasibility questions",
        "Adapted complexity to prospect's knowledge level",
      ],
      scoring: "0-3: 0=skipped, 1=partial, 2=good, 3=excellent",
    },
    {
      id: "lead_capture",
      name: "Lead Capture & Handoff",
      weight: 20,
      criteria: [
        "Collected contact information (name, email, phone)",
        "Summarized key needs before offering next steps",
        "Offered appropriate next step (brochure, call with sales manager, ROI calculation)",
        "Routed to correct regional sales manager",
      ],
      scoring: "0-3: 0=no capture, 1=partial, 2=good, 3=excellent",
    },
    {
      id: "conversation_quality",
      name: "Conversation Quality",
      weight: 10,
      criteria: [
        "Professional and knowledgeable tone",
        "Natural conversational flow",
        "Handled tangential questions gracefully",
        "Provided accurate technical information",
      ],
      scoring: "0-3: 0=very poor, 1=below average, 2=good, 3=excellent",
    },
  ],
  outcomes: [
    "p1_hot_lead",
    "p2_warm_lead",
    "p3_nurture",
    "p4_informational",
    "not_relevant",
    "incomplete_conversation",
  ],
};

// ─── Database table for scores ──────────────────────────────────────────────

async function initScorerTable(pool) {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS interaction_scores (
      id              SERIAL PRIMARY KEY,
      call_id         VARCHAR(128) NOT NULL,
      agent_id        VARCHAR(128),
      agent_type      VARCHAR(32),
      rubric_version  VARCHAR(16) DEFAULT '1.0',
      dimension_scores JSONB NOT NULL,
      total_score     NUMERIC(5,2),
      max_score       NUMERIC(5,2),
      pct_score       NUMERIC(5,2),
      outcome         VARCHAR(64),
      flags           JSONB,
      notes           TEXT,
      scored_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE(call_id)
    );
  `);
  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_interaction_scores_agent_id ON interaction_scores (agent_id);
  `);
  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_interaction_scores_scored_at ON interaction_scores (scored_at);
  `);
  console.log("Database table interaction_scores ready.");
}

// ─── Express route handlers ─────────────────────────────────────────────────

function registerRoutes(app, pool) {

  /**
   * GET /scorer/rubric
   *
   * Returns the scoring rubric for a given agent type.
   * The Paperclip Interaction Scorer agent reads this to know how to score calls.
   *
   * Query: ?agent_type=aria|econowind
   */
  app.get("/scorer/rubric", (_req, res) => {
    const agentType = (_req.query.agent_type || "aria").toLowerCase();
    if (agentType === "econowind" || agentType === "ventobot") {
      return res.json({ agent_type: "econowind", rubric: ECONOWIND_RUBRIC });
    }
    res.json({ agent_type: "aria", rubric: ARIA_RUBRIC });
  });

  /**
   * GET /scorer/unscored
   *
   * Returns call events that have transcripts but haven't been scored yet.
   * The Interaction Scorer calls this on each heartbeat to find work.
   *
   * Query:
   *   limit      - Max calls to return (default: 10)
   *   agent_type - "aria" or "econowind" (filters by agent_id)
   */
  app.get("/scorer/unscored", async (req, res) => {
    try {
      const limit = Math.min(parseInt(req.query.limit) || 10, 50);
      const agentType = (req.query.agent_type || "").toLowerCase();

      // Map agent_type to agent_id filter
      let agentFilter = "";
      const params = [limit];

      if (agentType === "aria" || agentType === "aria_en") {
        agentFilter = "AND e.agent_id IN ('agent_aa56b68b02f6de4ac5725a829b', 'agent_e1e1f763101db5abe0df281891')";
      } else if (agentType === "econowind" || agentType === "ventobot") {
        agentFilter = "AND e.agent_id = 'agent_760482429951f50e816c47b55a'";
      }

      const result = await pool.query(`
        SELECT e.id, e.call_id, e.agent_id, e.event_type, e.transcript, e.call_analysis, e.received_at
        FROM retell_events e
        LEFT JOIN interaction_scores s ON e.call_id = s.call_id
        WHERE e.event_type = 'call_ended'
          AND e.transcript IS NOT NULL
          AND e.transcript != ''
          AND s.id IS NULL
          ${agentFilter}
        ORDER BY e.received_at DESC
        LIMIT $1
      `, params);

      res.json({
        unscored_count: result.rows.length,
        calls: result.rows.map(row => ({
          call_id: row.call_id,
          agent_id: row.agent_id,
          event_type: row.event_type,
          transcript: row.transcript,
          call_analysis: row.call_analysis,
          received_at: row.received_at,
        })),
      });
    } catch (err) {
      console.error("[SCORER] Error fetching unscored calls:", err.message);
      res.status(500).json({ error: err.message });
    }
  });

  /**
   * POST /scorer/score
   *
   * Submit a score for a call. Called by the Interaction Scorer agent.
   *
   * Body:
   *   call_id          - Retell call ID
   *   agent_id         - Retell agent ID
   *   agent_type       - "aria" or "econowind"
   *   dimension_scores - { dimension_id: { score: 0-12, criteria_scores: [...], notes: "" } }
   *   outcome          - Outcome classification
   *   flags            - Array of flags (e.g., ["gdpr_disclosure_missing", "rushed_closing"])
   *   notes            - Free-text notes
   */
  app.post("/scorer/score", async (req, res) => {
    try {
      const { call_id, agent_id, agent_type, dimension_scores, outcome, flags, notes } = req.body;

      if (!call_id) return res.status(400).json({ error: "Missing call_id" });
      if (!dimension_scores) return res.status(400).json({ error: "Missing dimension_scores" });

      // Select rubric to calculate totals
      const rubric = (agent_type === "econowind" || agent_type === "ventobot") ? ECONOWIND_RUBRIC : ARIA_RUBRIC;

      // Calculate weighted total
      let totalScore = 0;
      let maxScore = 0;
      for (const dim of rubric.dimensions) {
        const ds = dimension_scores[dim.id];
        if (ds) {
          const dimMax = dim.criteria.length * 3; // Max 3 per criterion
          const dimScore = ds.score || 0;
          // Weighted contribution = (score/max) * weight
          totalScore += (dimScore / dimMax) * dim.weight;
          maxScore += dim.weight;
        }
      }
      const pctScore = maxScore > 0 ? (totalScore / maxScore) * 100 : 0;

      await pool.query(`
        INSERT INTO interaction_scores (call_id, agent_id, agent_type, dimension_scores, total_score, max_score, pct_score, outcome, flags, notes)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
        ON CONFLICT (call_id) DO UPDATE SET
          dimension_scores = $4, total_score = $5, max_score = $6, pct_score = $7, outcome = $8, flags = $9, notes = $10, scored_at = NOW()
      `, [call_id, agent_id, agent_type || "aria", JSON.stringify(dimension_scores), totalScore.toFixed(2), maxScore.toFixed(2), pctScore.toFixed(2), outcome, JSON.stringify(flags || []), notes]);

      console.log(`[SCORER] Scored call ${call_id}: ${pctScore.toFixed(1)}% (${outcome})`);

      res.json({
        success: true,
        call_id,
        total_score: parseFloat(totalScore.toFixed(2)),
        max_score: parseFloat(maxScore.toFixed(2)),
        pct_score: parseFloat(pctScore.toFixed(2)),
        outcome,
      });
    } catch (err) {
      console.error("[SCORER] Error submitting score:", err.message);
      res.status(500).json({ error: err.message });
    }
  });

  /**
   * GET /scorer/scores
   *
   * Query scored interactions for reporting.
   *
   * Query:
   *   agent_type - "aria" or "econowind"
   *   since      - ISO date (default: 7 days ago)
   *   limit      - Max results (default: 50)
   */
  app.get("/scorer/scores", async (req, res) => {
    try {
      const limit = Math.min(parseInt(req.query.limit) || 50, 200);
      const since = req.query.since || new Date(Date.now() - 7 * 86400000).toISOString();
      const agentType = req.query.agent_type;

      let query = `SELECT * FROM interaction_scores WHERE scored_at >= $1`;
      const params = [since];

      if (agentType) {
        params.push(agentType);
        query += ` AND agent_type = $${params.length}`;
      }

      params.push(limit);
      query += ` ORDER BY scored_at DESC LIMIT $${params.length}`;

      const result = await pool.query(query, params);

      // Calculate summary stats
      const scores = result.rows;
      const avgScore = scores.length > 0 ? scores.reduce((sum, s) => sum + parseFloat(s.pct_score), 0) / scores.length : 0;
      const outcomes = {};
      scores.forEach(s => { outcomes[s.outcome] = (outcomes[s.outcome] || 0) + 1; });

      res.json({
        total: scores.length,
        avg_pct_score: parseFloat(avgScore.toFixed(1)),
        outcome_distribution: outcomes,
        scores: scores.map(s => ({
          call_id: s.call_id,
          agent_id: s.agent_id,
          agent_type: s.agent_type,
          pct_score: parseFloat(s.pct_score),
          outcome: s.outcome,
          flags: s.flags,
          scored_at: s.scored_at,
        })),
      });
    } catch (err) {
      console.error("[SCORER] Error querying scores:", err.message);
      res.status(500).json({ error: err.message });
    }
  });

  /**
   * GET /scorer/summary
   *
   * Aggregate scoring summary for the Intelligence Analyst weekly report.
   *
   * Query:
   *   period - "day", "week", "month" (default: "week")
   */
  app.get("/scorer/summary", async (req, res) => {
    try {
      const period = req.query.period || "week";
      const daysBack = period === "day" ? 1 : period === "month" ? 30 : 7;
      const since = new Date(Date.now() - daysBack * 86400000).toISOString();

      const result = await pool.query(`
        SELECT
          agent_type,
          COUNT(*) as total_calls,
          AVG(pct_score) as avg_score,
          MIN(pct_score) as min_score,
          MAX(pct_score) as max_score,
          COUNT(CASE WHEN outcome = 'meeting_booked' OR outcome = 'p1_hot_lead' THEN 1 END) as high_value_outcomes,
          COUNT(CASE WHEN pct_score < 50 THEN 1 END) as below_threshold
        FROM interaction_scores
        WHERE scored_at >= $1
        GROUP BY agent_type
      `, [since]);

      // Also get flag frequency
      const flagResult = await pool.query(`
        SELECT f.flag, COUNT(*) as count
        FROM interaction_scores, jsonb_array_elements_text(flags) AS f(flag)
        WHERE scored_at >= $1
        GROUP BY f.flag
        ORDER BY count DESC
        LIMIT 10
      `, [since]);

      res.json({
        period,
        since,
        by_agent_type: result.rows.map(r => ({
          agent_type: r.agent_type,
          total_calls: parseInt(r.total_calls),
          avg_score: parseFloat(parseFloat(r.avg_score).toFixed(1)),
          min_score: parseFloat(parseFloat(r.min_score).toFixed(1)),
          max_score: parseFloat(parseFloat(r.max_score).toFixed(1)),
          high_value_outcomes: parseInt(r.high_value_outcomes),
          below_threshold: parseInt(r.below_threshold),
        })),
        top_flags: flagResult.rows.map(r => ({ flag: r.flag, count: parseInt(r.count) })),
      });
    } catch (err) {
      console.error("[SCORER] Error generating summary:", err.message);
      res.status(500).json({ error: err.message });
    }
  });
}

module.exports = {
  registerRoutes,
  initScorerTable,
  ARIA_RUBRIC,
  ECONOWIND_RUBRIC,
};
