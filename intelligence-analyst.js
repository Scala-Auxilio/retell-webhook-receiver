/**
 * Scala Auxilio — Intelligence Analyst (Agent B)
 *
 * Two responsibilities:
 *   1. Weekly digest — every Sunday 18:00 Europe/London. Surfaces top/bottom calls,
 *      score trends per dimension, failure-mode patterns. Sent to petrusc@adsum-auxilio.com.
 *   2. Threshold-triggered diagnostic — daily check at 17:00. When 5+ Learning-Opportunity
 *      calls share a key_failure_mode in the last 7 days, calls Claude Haiku to propose a
 *      prompt change. Email is suggest-only — Petrus reviews + applies manually.
 *
 * Suggest-only mode. No prompt changes ever auto-deploy.
 * Email delivery: petrusc@adsum-auxilio.com.
 * Disable crons by setting INTELLIGENCE_ANALYST_CRON=off.
 */

const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY || null;
const HAIKU_MODEL = "claude-haiku-4-5-20251001";
const ANALYST_EMAIL_TO = process.env.ANALYST_EMAIL_TO || "petrusc@adsum-auxilio.com";
const ANALYST_EMAIL_FROM = process.env.ANALYST_EMAIL_FROM || "notifications@adsum-auxilio.com";
const DIAGNOSTIC_THRESHOLD = parseInt(process.env.DIAGNOSTIC_THRESHOLD || "5", 10);
const DIAGNOSTIC_LOOKBACK_DAYS = 7;

let _anthropicClient = null;
function getAnthropicClient() {
  if (_anthropicClient) return _anthropicClient;
  if (!ANTHROPIC_API_KEY) {
    throw new Error("ANTHROPIC_API_KEY not configured");
  }
  const Anthropic = require("@anthropic-ai/sdk");
  _anthropicClient = new Anthropic({ apiKey: ANTHROPIC_API_KEY });
  return _anthropicClient;
}

// ─── Schema migration ───────────────────────────────────────────────────────
async function initAnalystTables(pool) {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS prompt_change_proposals (
      id              SERIAL PRIMARY KEY,
      proposal_type   VARCHAR(32) NOT NULL,         -- 'diagnostic' | 'refresh'
      failure_mode    VARCHAR(64),                   -- only for 'diagnostic'
      cluster_size    INTEGER,                       -- # calls that triggered it
      lookback_days   INTEGER,
      sample_call_ids JSONB,                         -- array of call_id strings
      diagnosis       TEXT,
      proposed_change TEXT,                          -- human-readable diff
      cited_exemplar_ids JSONB,                      -- Strong-tier calls used as anti-regression
      confidence      VARCHAR(16),                   -- 'low' | 'medium' | 'high'
      expected_impact TEXT,
      status          VARCHAR(16) DEFAULT 'pending', -- 'pending' | 'approved' | 'rejected' | 'applied' | 'expired'
      created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      decided_at      TIMESTAMPTZ,
      email_sent_at   TIMESTAMPTZ
    );
  `);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_pcp_status ON prompt_change_proposals (status);`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_pcp_failure_mode ON prompt_change_proposals (failure_mode);`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_pcp_created ON prompt_change_proposals (created_at);`);
  console.log("Database table prompt_change_proposals ready.");
}

// ─── Aggregate queries ──────────────────────────────────────────────────────

async function getDigestAggregates(pool, sinceDate, untilDate) {
  // sinceDate / untilDate are JS Date objects bracketing the period
  const q = async (sql, params) => (await pool.query(sql, params)).rows;

  const overall = await q(`
    SELECT
      COUNT(*)                                   AS total_calls,
      AVG(total_score)                           AS avg_score,
      MIN(total_score)                           AS min_score,
      MAX(total_score)                           AS max_score,
      SUM(CASE WHEN tier = 'Strong' THEN 1 ELSE 0 END)               AS strong_count,
      SUM(CASE WHEN tier = 'Solid'  THEN 1 ELSE 0 END)               AS solid_count,
      SUM(CASE WHEN tier = 'Learning Opportunity' THEN 1 ELSE 0 END) AS learning_count,
      SUM(CASE WHEN tier = 'Incident' THEN 1 ELSE 0 END)             AS incident_count,
      SUM(CASE WHEN fault_attribution = 'aria' THEN 1 ELSE 0 END)    AS aria_fault_count
    FROM interaction_scores
    WHERE scored_at >= $1 AND scored_at < $2
      AND rubric_version = '2.0'
  `, [sinceDate, untilDate]);

  // Top 3 (Strong tier or highest scores)
  const top3 = await q(`
    SELECT call_id, total_score, tier, key_failure_mode, what_went_well, exemplar_snippets, dimension_scores
    FROM interaction_scores
    WHERE scored_at >= $1 AND scored_at < $2 AND rubric_version = '2.0'
    ORDER BY total_score DESC NULLS LAST
    LIMIT 3
  `, [sinceDate, untilDate]);

  // Bottom 3 (lowest scores)
  const bottom3 = await q(`
    SELECT call_id, total_score, tier, fault_attribution, key_failure_mode, what_went_wrong, dimension_scores
    FROM interaction_scores
    WHERE scored_at >= $1 AND scored_at < $2 AND rubric_version = '2.0'
    ORDER BY total_score ASC NULLS LAST
    LIMIT 3
  `, [sinceDate, untilDate]);

  // Failure-mode clusters
  const clusters = await q(`
    SELECT key_failure_mode, COUNT(*) AS count
    FROM interaction_scores
    WHERE scored_at >= $1 AND scored_at < $2
      AND rubric_version = '2.0'
      AND key_failure_mode IS NOT NULL
    GROUP BY key_failure_mode
    HAVING COUNT(*) >= 2
    ORDER BY count DESC, key_failure_mode
    LIMIT 10
  `, [sinceDate, untilDate]);

  // Per-dimension averages
  const dims = await q(`
    SELECT
      AVG((dimension_scores->>'connection_quality')::numeric)   AS connection_quality,
      AVG((dimension_scores->>'opener_execution')::numeric)     AS opener_execution,
      AVG((dimension_scores->>'discovery_adaptation')::numeric) AS discovery_adaptation,
      AVG((dimension_scores->>'outcome_closure')::numeric)      AS outcome_closure
    FROM interaction_scores
    WHERE scored_at >= $1 AND scored_at < $2 AND rubric_version = '2.0'
  `, [sinceDate, untilDate]);

  // Pending proposals
  const pending = await q(`
    SELECT id, proposal_type, failure_mode, cluster_size, created_at
    FROM prompt_change_proposals
    WHERE status = 'pending'
    ORDER BY created_at DESC
  `);

  return { overall: overall[0], top3, bottom3, clusters, dims: dims[0], pending };
}

// ─── Email formatting (markdown → HTML) ─────────────────────────────────────

function fmtScore(v) { return v == null ? "n/a" : Number(v).toFixed(1); }
function fmtDelta(curr, prev) {
  if (curr == null || prev == null) return "";
  const d = Number(curr) - Number(prev);
  if (Math.abs(d) < 0.1) return " (flat)";
  return d > 0 ? ` (▲ +${d.toFixed(1)})` : ` (▼ ${d.toFixed(1)})`;
}
function escapeHtml(s) {
  return String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function formatDigestEmail({ thisWeek, lastWeek, weekStart, weekEnd }) {
  const o = thisWeek.overall || {};
  const oPrev = lastWeek?.overall || {};
  const dim = thisWeek.dims || {};
  const dimPrev = lastWeek?.dims || {};

  const totalCalls = parseInt(o.total_calls || 0, 10);
  const lastTotal = parseInt(oPrev.total_calls || 0, 10);
  const callsDelta = lastTotal > 0 ? ` (vs ${lastTotal} last week)` : " (no prior data)";

  const formatCallCard = (c, isTop) => {
    const dim = (typeof c.dimension_scores === 'string') ? JSON.parse(c.dimension_scores) : c.dimension_scores || {};
    const detail = isTop
      ? (c.what_went_well ? `<p style="margin:4px 0;color:#374151;"><strong>What worked:</strong> ${escapeHtml(c.what_went_well)}</p>` : "")
      : `<p style="margin:4px 0;color:#374151;"><strong>What didn't:</strong> ${escapeHtml(c.what_went_wrong || 'n/a')}</p>
         <p style="margin:4px 0;color:#6b7280;font-size:0.9em;"><strong>Failure mode:</strong> <code>${escapeHtml(c.key_failure_mode||'')}</code> &nbsp; <strong>Fault:</strong> ${escapeHtml(c.fault_attribution||'')}</p>`;
    let snippets = "";
    if (isTop && c.exemplar_snippets) {
      const exs = (typeof c.exemplar_snippets === 'string') ? JSON.parse(c.exemplar_snippets) : c.exemplar_snippets;
      if (Array.isArray(exs) && exs.length > 0) {
        snippets = '<div style="margin:6px 0;padding:8px 12px;background:#f9fafb;border-left:3px solid #16a34a;font-style:italic;color:#374151;font-size:0.92em;">' +
          exs.map(s => escapeHtml(typeof s === "string" ? s : (s.snippet || JSON.stringify(s)))).join('<br/><br/>') +
          '</div>';
      }
    }
    const tierColor = c.tier === "Strong" ? "#16a34a" : c.tier === "Solid" ? "#2563eb" : c.tier === "Incident" ? "#dc2626" : "#ea580c";
    return `
      <div style="border:1px solid #e5e7eb;border-radius:8px;padding:14px;margin:10px 0;">
        <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:6px;">
          <strong style="font-size:1.05em;">${fmtScore(c.total_score)}/100</strong>
          <span style="background:${tierColor};color:white;padding:2px 10px;border-radius:12px;font-size:0.8em;">${escapeHtml(c.tier||'')}</span>
        </div>
        ${detail}
        ${snippets}
        <p style="margin:8px 0 0;color:#9ca3af;font-size:0.8em;">call_id: <code>${escapeHtml(c.call_id)}</code></p>
      </div>
    `;
  };

  const clustersHtml = thisWeek.clusters && thisWeek.clusters.length
    ? '<table style="width:100%;border-collapse:collapse;font-size:0.9em;">' +
      thisWeek.clusters.map(c => `<tr><td style="padding:4px 8px;border-bottom:1px solid #f3f4f6;"><code>${escapeHtml(c.key_failure_mode)}</code></td><td style="padding:4px 8px;border-bottom:1px solid #f3f4f6;text-align:right;">${c.count} calls</td></tr>`).join('') +
      '</table>'
    : '<p style="color:#6b7280;font-style:italic;">No recurring failure modes this week.</p>';

  const pendingHtml = thisWeek.pending && thisWeek.pending.length
    ? '<ul>' + thisWeek.pending.map(p => `<li>Proposal #${p.id}: ${escapeHtml(p.proposal_type)} for <code>${escapeHtml(p.failure_mode || 'n/a')}</code> (${p.cluster_size} calls) — sent ${new Date(p.created_at).toLocaleDateString('en-GB')}</li>`).join('') + '</ul>'
    : '<p style="color:#6b7280;font-style:italic;">No pending proposals awaiting review.</p>';

  const html = `<!DOCTYPE html>
<html><head><meta charset="UTF-8"></head>
<body style="font-family:-apple-system,BlinkMacSystemFont,Segoe UI,Roboto,sans-serif;color:#1f2937;line-height:1.6;max-width:680px;margin:0 auto;padding:20px;">
  <h1 style="color:#2E5090;margin-bottom:4px;">Aria — Weekly Digest</h1>
  <p style="color:#6b7280;margin:0 0 24px;font-size:0.9em;">Week of ${weekStart.toLocaleDateString('en-GB')} → ${weekEnd.toLocaleDateString('en-GB')} · Sent by Paperclip Intelligence Analyst</p>

  <div style="background:#eff6ff;border-left:4px solid #2563eb;padding:14px 18px;margin-bottom:24px;border-radius:6px;">
    <h2 style="margin:0 0 8px;color:#2E5090;font-size:1.1em;">TL;DR</h2>
    <ul style="margin:4px 0;padding-left:20px;">
      <li><strong>${totalCalls}</strong> calls scored${callsDelta}</li>
      <li>Average score: <strong>${fmtScore(o.avg_score)}/100</strong>${fmtDelta(o.avg_score, oPrev.avg_score)}</li>
      <li>Tier breakdown: ${o.strong_count||0} Strong · ${o.solid_count||0} Solid · ${o.learning_count||0} Learning · ${o.incident_count||0} Incident</li>
      <li>Aria-fault calls: <strong>${o.aria_fault_count||0}</strong></li>
    </ul>
  </div>

  <h2 style="color:#2E5090;border-bottom:2px solid #e5e7eb;padding-bottom:6px;font-size:1.15em;">📈 Score trend</h2>
  <table style="width:100%;border-collapse:collapse;font-size:0.95em;margin:8px 0 24px;">
    <thead><tr style="background:#f3f4f6;"><th style="padding:6px 10px;text-align:left;">Dimension</th><th style="padding:6px 10px;text-align:right;">This week</th><th style="padding:6px 10px;text-align:right;">Δ</th></tr></thead>
    <tbody>
      <tr><td style="padding:6px 10px;border-bottom:1px solid #f3f4f6;">Connection Quality</td><td style="padding:6px 10px;text-align:right;border-bottom:1px solid #f3f4f6;">${fmtScore(dim.connection_quality)}</td><td style="padding:6px 10px;text-align:right;border-bottom:1px solid #f3f4f6;color:#6b7280;font-size:0.9em;">${fmtDelta(dim.connection_quality, dimPrev.connection_quality)}</td></tr>
      <tr><td style="padding:6px 10px;border-bottom:1px solid #f3f4f6;">Opener Execution</td><td style="padding:6px 10px;text-align:right;border-bottom:1px solid #f3f4f6;">${fmtScore(dim.opener_execution)}</td><td style="padding:6px 10px;text-align:right;border-bottom:1px solid #f3f4f6;color:#6b7280;font-size:0.9em;">${fmtDelta(dim.opener_execution, dimPrev.opener_execution)}</td></tr>
      <tr><td style="padding:6px 10px;border-bottom:1px solid #f3f4f6;">Discovery & Adaptation</td><td style="padding:6px 10px;text-align:right;border-bottom:1px solid #f3f4f6;">${fmtScore(dim.discovery_adaptation)}</td><td style="padding:6px 10px;text-align:right;border-bottom:1px solid #f3f4f6;color:#6b7280;font-size:0.9em;">${fmtDelta(dim.discovery_adaptation, dimPrev.discovery_adaptation)}</td></tr>
      <tr><td style="padding:6px 10px;">Outcome & Closure</td><td style="padding:6px 10px;text-align:right;">${fmtScore(dim.outcome_closure)}</td><td style="padding:6px 10px;text-align:right;color:#6b7280;font-size:0.9em;">${fmtDelta(dim.outcome_closure, dimPrev.outcome_closure)}</td></tr>
    </tbody>
  </table>

  <h2 style="color:#16a34a;border-bottom:2px solid #e5e7eb;padding-bottom:6px;font-size:1.15em;">🌟 Top 3 calls</h2>
  ${thisWeek.top3.length ? thisWeek.top3.map(c => formatCallCard(c, true)).join("") : '<p style="color:#6b7280;">No calls this week.</p>'}

  <h2 style="color:#ea580c;border-bottom:2px solid #e5e7eb;padding-bottom:6px;font-size:1.15em;">🔍 Bottom 3 calls</h2>
  ${thisWeek.bottom3.length ? thisWeek.bottom3.map(c => formatCallCard(c, false)).join("") : '<p style="color:#6b7280;">No calls this week.</p>'}

  <h2 style="color:#2E5090;border-bottom:2px solid #e5e7eb;padding-bottom:6px;font-size:1.15em;">🔁 Recurring failure modes</h2>
  ${clustersHtml}

  <h2 style="color:#2E5090;border-bottom:2px solid #e5e7eb;padding-bottom:6px;font-size:1.15em;margin-top:28px;">📋 Pending diagnostic proposals</h2>
  ${pendingHtml}

  <hr style="border:none;border-top:1px solid #e5e7eb;margin:32px 0 16px;"/>
  <p style="color:#9ca3af;font-size:0.8em;text-align:center;">— Paperclip Intelligence Analyst · suggest-only mode · v1.0</p>
</body></html>`;

  const text = `Aria Weekly Digest — Week of ${weekStart.toLocaleDateString('en-GB')} → ${weekEnd.toLocaleDateString('en-GB')}

TL;DR
- ${totalCalls} calls scored${callsDelta}
- Average score: ${fmtScore(o.avg_score)}/100${fmtDelta(o.avg_score, oPrev.avg_score)}
- Tier: ${o.strong_count||0} Strong · ${o.solid_count||0} Solid · ${o.learning_count||0} Learning · ${o.incident_count||0} Incident
- Aria-fault calls: ${o.aria_fault_count||0}

(Open this email in HTML for the full digest.)
`;

  return { html, text, subject: `Aria Weekly Digest — week ending ${weekEnd.toLocaleDateString('en-GB')}` };
}

// ─── Weekly digest runner ──────────────────────────────────────────────────
async function runWeeklyDigest({ pool, sendEmail, dryRun = false }) {
  const now = new Date();
  // This week = last 7 days. Next week's email will roll over.
  const weekEnd = new Date(now);
  const weekStart = new Date(now); weekStart.setDate(weekStart.getDate() - 7);
  const lastWeekEnd = new Date(weekStart);
  const lastWeekStart = new Date(weekStart); lastWeekStart.setDate(lastWeekStart.getDate() - 7);

  const thisWeek = await getDigestAggregates(pool, weekStart, weekEnd);
  const lastWeek = await getDigestAggregates(pool, lastWeekStart, lastWeekEnd);

  const email = formatDigestEmail({ thisWeek, lastWeek, weekStart, weekEnd });
  console.log(`[ANALYST-DIGEST] period=${weekStart.toISOString().split('T')[0]}→${weekEnd.toISOString().split('T')[0]} calls=${thisWeek.overall.total_calls} avg=${fmtScore(thisWeek.overall.avg_score)} dryRun=${dryRun}`);

  if (dryRun) return { ok: true, dryRun: true, email_preview: email, aggregates: thisWeek };

  if (!sendEmail) throw new Error("sendEmail not configured");
  await sendEmail({
    from: ANALYST_EMAIL_FROM,
    to: ANALYST_EMAIL_TO,
    subject: email.subject,
    text: email.text,
    html: email.html,
  });
  return { ok: true, sent_to: ANALYST_EMAIL_TO, calls_scored: thisWeek.overall.total_calls };
}

// ─── Threshold-triggered diagnostic ────────────────────────────────────────
async function runDiagnosticPatternCheck({ pool, sendEmail, dryRun = false }) {
  const now = new Date();
  const since = new Date(now); since.setDate(since.getDate() - DIAGNOSTIC_LOOKBACK_DAYS);

  // Find failure modes that occurred ≥ DIAGNOSTIC_THRESHOLD times in Learning Opportunity tier
  const clusters = (await pool.query(`
    SELECT key_failure_mode, COUNT(*)::int AS count, ARRAY_AGG(call_id) AS sample_call_ids
    FROM interaction_scores
    WHERE scored_at >= $1 AND scored_at < $2
      AND rubric_version = '2.0'
      AND tier = 'Learning Opportunity'
      AND key_failure_mode IS NOT NULL
    GROUP BY key_failure_mode
    HAVING COUNT(*) >= $3
    ORDER BY count DESC
  `, [since, now, DIAGNOSTIC_THRESHOLD])).rows;

  if (clusters.length === 0) {
    console.log(`[ANALYST-DIAGNOSTIC] no failure-mode clusters >=${DIAGNOSTIC_THRESHOLD} in last ${DIAGNOSTIC_LOOKBACK_DAYS}d`);
    return { ok: true, clusters_found: 0, proposals_sent: 0 };
  }

  let proposalsSent = 0;
  for (const cluster of clusters) {
    // Skip if a proposal for this failure_mode was sent in last 14 days (avoid spam)
    const recent = await pool.query(`
      SELECT id FROM prompt_change_proposals
      WHERE failure_mode = $1 AND created_at > NOW() - INTERVAL '14 days'
        AND status IN ('pending', 'rejected')
    `, [cluster.key_failure_mode]);
    if (recent.rowCount > 0) {
      console.log(`[ANALYST-DIAGNOSTIC] skipping ${cluster.key_failure_mode}: recent proposal already pending/rejected`);
      continue;
    }

    // Pull sample transcripts for the cluster
    const sampleIds = cluster.sample_call_ids.slice(0, 3);
    const samples = (await pool.query(`
      SELECT call_id, total_score, what_went_wrong, dimension_scores
      FROM interaction_scores
      WHERE call_id = ANY($1::text[])
      LIMIT 3
    `, [sampleIds])).rows;

    // Pull Strong-tier exemplars (any time, regardless of date)
    const exemplars = (await pool.query(`
      SELECT call_id, total_score, what_went_well, exemplar_snippets
      FROM interaction_scores
      WHERE tier = 'Strong' AND rubric_version = '2.0'
      ORDER BY scored_at DESC LIMIT 3
    `)).rows;

    let proposal;
    try {
      proposal = await proposeChangeForCluster({
        failureMode: cluster.key_failure_mode,
        clusterSize: cluster.count,
        sampleCalls: samples,
        exemplars,
      });
    } catch (err) {
      console.error(`[ANALYST-DIAGNOSTIC] LLM proposal failed for ${cluster.key_failure_mode}: ${err.message}`);
      continue;
    }

    // Persist proposal
    const insertRes = await pool.query(`
      INSERT INTO prompt_change_proposals
        (proposal_type, failure_mode, cluster_size, lookback_days, sample_call_ids,
         diagnosis, proposed_change, cited_exemplar_ids, confidence, expected_impact,
         status, email_sent_at)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, 'pending', $11)
      RETURNING id
    `, [
      'diagnostic',
      cluster.key_failure_mode,
      cluster.count,
      DIAGNOSTIC_LOOKBACK_DAYS,
      JSON.stringify(sampleIds),
      proposal.diagnosis,
      proposal.proposed_change,
      JSON.stringify(exemplars.map(e => e.call_id)),
      proposal.confidence,
      proposal.expected_impact,
      dryRun ? null : new Date(),
    ]);
    const proposalId = insertRes.rows[0].id;

    if (dryRun) {
      console.log(`[ANALYST-DIAGNOSTIC] (dry) proposal #${proposalId} for ${cluster.key_failure_mode}`);
      continue;
    }

    // Send email
    const emailContent = formatDiagnosticEmail({ proposalId, cluster, sampleCalls: samples, exemplars, proposal });
    if (!sendEmail) {
      console.warn(`[ANALYST-DIAGNOSTIC] sendEmail not configured — proposal #${proposalId} stored but not emailed`);
      continue;
    }
    await sendEmail({
      from: ANALYST_EMAIL_FROM,
      to: ANALYST_EMAIL_TO,
      subject: emailContent.subject,
      text: emailContent.text,
      html: emailContent.html,
    });
    console.log(`[ANALYST-DIAGNOSTIC] proposal #${proposalId} emailed for ${cluster.key_failure_mode} (${cluster.count} calls)`);
    proposalsSent++;
  }

  return { ok: true, clusters_found: clusters.length, proposals_sent: proposalsSent };
}

async function proposeChangeForCluster({ failureMode, clusterSize, sampleCalls, exemplars }) {
  const client = getAnthropicClient();
  const prompt = `You are diagnosing a recurring failure mode in Aria, an AI SDR for Sendsteps.

FAILURE MODE: ${failureMode}
OCCURRENCES: ${clusterSize} calls in the last ${DIAGNOSTIC_LOOKBACK_DAYS} days, all classified Learning Opportunity tier.

SAMPLE CALLS (3 of the affected ones):
${JSON.stringify(sampleCalls, null, 2)}

STRONG-TIER EXEMPLARS (calls that scored well — your proposed change must NOT regress these):
${JSON.stringify(exemplars, null, 2)}

YOUR TASK:
1. Diagnose: What pattern in Aria's behaviour is causing this failure mode? Be specific.
2. Hypothesize: Why isn't her current prompt preventing this?
3. Propose a concrete change: a sentence or short paragraph that should be ADDED or MODIFIED in Aria's global_prompt or in a specific node instruction. Be precise. Cite the section to edit.
4. Confidence: low / medium / high
5. Expected impact: how many of these failure-mode calls would the change prevent?

OUTPUT: JSON only, no markdown:
{
  "diagnosis": "<2-4 sentences identifying the pattern>",
  "hypothesis": "<1-2 sentences on why current prompt fails>",
  "proposed_change": "<concrete prompt edit, including which section to edit>",
  "confidence": "low" | "medium" | "high",
  "expected_impact": "<short estimate, e.g. 'Should prevent ~3 of 5 weekly occurrences'>"
}`;

  const response = await client.messages.create({
    model: HAIKU_MODEL,
    max_tokens: 1500,
    messages: [{ role: "user", content: prompt }],
  });
  const text = response.content[0].text;
  const cleaned = text.replace(/^```(json)?\s*/m, "").replace(/```\s*$/m, "").trim();
  return JSON.parse(cleaned);
}

function formatDiagnosticEmail({ proposalId, cluster, sampleCalls, exemplars, proposal }) {
  const sampleList = sampleCalls.map(c => `<li><code>${c.call_id}</code> (score ${fmtScore(c.total_score)})</li>`).join("");
  const exemplarList = exemplars.length
    ? exemplars.map(e => `<li><code>${e.call_id}</code> (score ${fmtScore(e.total_score)}): ${escapeHtml((e.what_went_well || '').slice(0, 140))}</li>`).join("")
    : "<li><em>No Strong-tier exemplars yet — proposal is unverified against good-call regression.</em></li>";

  const html = `<!DOCTYPE html>
<html><head><meta charset="UTF-8"></head>
<body style="font-family:-apple-system,BlinkMacSystemFont,Segoe UI,Roboto,sans-serif;color:#1f2937;line-height:1.6;max-width:680px;margin:0 auto;padding:20px;">
  <h1 style="color:#dc2626;margin-bottom:4px;">⚠️ Diagnostic suggestion #${proposalId}</h1>
  <p style="color:#6b7280;margin:0 0 24px;font-size:0.9em;">Failure mode <code>${escapeHtml(cluster.key_failure_mode)}</code> seen in ${cluster.count} calls (last ${DIAGNOSTIC_LOOKBACK_DAYS} days).</p>

  <h2 style="color:#2E5090;font-size:1.05em;">Diagnosis</h2>
  <p>${escapeHtml(proposal.diagnosis)}</p>

  <h2 style="color:#2E5090;font-size:1.05em;">Hypothesis</h2>
  <p>${escapeHtml(proposal.hypothesis || "")}</p>

  <h2 style="color:#2E5090;font-size:1.05em;">Proposed change</h2>
  <div style="background:#fefce8;border:1px solid #fde68a;border-radius:6px;padding:14px;font-family:monospace;font-size:0.9em;white-space:pre-wrap;">${escapeHtml(proposal.proposed_change)}</div>

  <h2 style="color:#2E5090;font-size:1.05em;">Sample affected calls</h2>
  <ul>${sampleList}</ul>

  <h2 style="color:#16a34a;font-size:1.05em;">Strong-tier exemplars (regression check)</h2>
  <ul>${exemplarList}</ul>

  <h2 style="color:#2E5090;font-size:1.05em;">Confidence: ${escapeHtml(proposal.confidence)}</h2>
  <p style="color:#6b7280;">Expected impact: ${escapeHtml(proposal.expected_impact)}</p>

  <hr style="border:none;border-top:1px solid #e5e7eb;margin:32px 0 16px;"/>
  <h3 style="color:#2E5090;">Next steps</h3>
  <p>This is a suggestion only. To apply:</p>
  <ol>
    <li>Open the Retell conversation flow (id <code>conversation_flow_ca432d5b12c4</code>).</li>
    <li>Apply the proposed change above to the indicated section.</li>
    <li>The change goes live on the next call.</li>
  </ol>
  <p>If you'd rather not apply this change, no action is needed. The same suggestion will only re-send if the pattern persists for another ≥ ${DIAGNOSTIC_LOOKBACK_DAYS} days after a 14-day cooldown.</p>

  <p style="color:#9ca3af;font-size:0.8em;text-align:center;margin-top:24px;">— Paperclip Intelligence Analyst · suggest-only mode · proposal #${proposalId}</p>
</body></html>`;

  const text = `Diagnostic suggestion #${proposalId}

Failure mode: ${cluster.key_failure_mode}
Occurrences: ${cluster.count} in last ${DIAGNOSTIC_LOOKBACK_DAYS} days

Diagnosis: ${proposal.diagnosis}

Hypothesis: ${proposal.hypothesis || ''}

Proposed change:
${proposal.proposed_change}

Confidence: ${proposal.confidence}
Expected impact: ${proposal.expected_impact}

(Open this email in HTML for sample calls + exemplars.)
`;

  return { html, text, subject: `[Aria] Diagnostic — ${cluster.key_failure_mode} (${cluster.count} calls)` };
}

// ─── Express routes (manual triggers + status) ─────────────────────────────
function registerAnalystRoutes(app, { pool, sendEmail, requireAuth = (req, res, next) => next() }) {
  // POST /analyst/digest-now — manual trigger for weekly digest
  app.post("/analyst/digest-now", requireAuth, async (req, res) => {
    try {
      const dryRun = req.query.dry_run === "1" || req.body?.dry_run === true;
      const result = await runWeeklyDigest({ pool, sendEmail, dryRun });
      if (dryRun) {
        // Trim email_preview.html for response brevity
        const trimmed = { ...result };
        if (trimmed.email_preview) {
          trimmed.email_preview = {
            subject: trimmed.email_preview.subject,
            text: trimmed.email_preview.text,
            html_length: (trimmed.email_preview.html || "").length,
          };
        }
        res.json(trimmed);
      } else {
        res.json(result);
      }
    } catch (err) {
      console.error("[ANALYST-DIGEST] Error:", err.message);
      res.status(500).json({ error: err.message });
    }
  });

  // POST /analyst/diagnostic-check — manual trigger for diagnostic pattern detection
  app.post("/analyst/diagnostic-check", requireAuth, async (req, res) => {
    try {
      const dryRun = req.query.dry_run === "1" || req.body?.dry_run === true;
      const result = await runDiagnosticPatternCheck({ pool, sendEmail, dryRun });
      res.json(result);
    } catch (err) {
      console.error("[ANALYST-DIAGNOSTIC] Error:", err.message);
      res.status(500).json({ error: err.message });
    }
  });

  // GET /analyst/proposals — list pending proposals
  app.get("/analyst/proposals", requireAuth, async (req, res) => {
    try {
      const status = req.query.status || 'pending';
      const result = await pool.query(`
        SELECT id, proposal_type, failure_mode, cluster_size, status,
               diagnosis, proposed_change, confidence, expected_impact,
               created_at, decided_at
        FROM prompt_change_proposals
        WHERE status = $1
        ORDER BY created_at DESC
        LIMIT 50
      `, [status]);
      res.json({ proposals: result.rows });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });
}

module.exports = {
  registerAnalystRoutes,
  initAnalystTables,
  runWeeklyDigest,
  runDiagnosticPatternCheck,
};
