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

// v1.0 retained for historical reference only — no longer used for new scoring.
const ARIA_RUBRIC_V1 = {
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


// ─── ACTIVE Rubric (Sendsteps Aria SDR) — v2.0 ─────────────────────────────
// 4 dimensions × 25 points = 100 total. Canonical reference document:
// /AI Sales/Aria_Scoring_Rubric_v1.md (note: doc filename says "v1" but
// content describes the v2.0 rubric — naming preserved for the user's bookmarks).
// Replaces v1.0 (which used 6 dimensions × 0-3 scoring).

const ARIA_RUBRIC_V2 = {
  version: "2.0",
  total_points: 100,
  framing: "Growth-oriented. Low scores are learning gradients, not malfunctions. Critical Incident tier requires score ≤ 25 AND fault_attribution=aria AND a recognised incident type.",
  dimensions: [
    {
      id: "connection_quality",
      name: "Connection Quality",
      weight: 25,
      description: "How Aria handled the phone-line reality (IVR, voicemail, switchboard, hold)",
      anchors: [
        { points: 25, criteria: "Reached the named prospect directly within 30 seconds" },
        { points: 20, criteria: "Reached a competent gatekeeper (PA, dept secretary) within 45 seconds" },
        { points: 15, criteria: "Reached switchboard/reception. Navigated cleanly" },
        { points: 10, criteria: "Hit IVR. Pressed correct digits. Reached a human (even if not the right one)" },
        { points: 5,  criteria: "Hit IVR. Got stuck or escaped on time-out, but did not speak over the recording" },
        { points: 0,  criteria: "Spoke OVER the IVR. OR narrated her own state out loud. OR rang voicemail without detecting it" },
      ],
    },
    {
      id: "opener_execution",
      name: "Opener Execution",
      weight: 25,
      description: "How well she executed the opening 30 seconds when she got a human. Score null if no human reached.",
      anchors: [
        { points: 25, criteria: "Full opener with personalisation (name, university, value prop). Natural. AI disclosure handled confidently if asked" },
        { points: 20, criteria: "Opener delivered cleanly but slightly robotic or rushed" },
        { points: 15, criteria: "Opener delivered but missed personalisation OR fumbled AI disclosure" },
        { points: 10, criteria: "Skipped opener and went straight to qualifying — works but loses email anchor" },
        { points: 5,  criteria: "Confused, repeated herself, or asked identity-confirmation after IVR (which she shouldn't)" },
        { points: 0,  criteria: "Stayed silent when a human spoke, OR opened with narration ('I am calling on behalf of...')" },
      ],
      n_a_when: "no_human_reached",
    },
    {
      id: "discovery_adaptation",
      name: "Discovery & Adaptation",
      weight: 25,
      description: "How she handled what the human said. Score null if no human reached.",
      anchors: [
        { points: 25, criteria: "Asked the right qualifying question (faculty vs procurement). Listened. Adapted with relevant follow-up" },
        { points: 20, criteria: "Asked qualifying but follow-up was generic / scripted" },
        { points: 15, criteria: "Asked qualifying but ignored prospect's response and pushed next script step" },
        { points: 10, criteria: "Got an objection and handled it acceptably" },
        { points: 5,  criteria: "Got an objection and either argued OR collapsed too fast" },
        { points: 0,  criteria: "Didn't ask any question, OR asked the same thing twice" },
      ],
      n_a_when: "no_human_reached",
    },
    {
      id: "outcome_closure",
      name: "Outcome & Closure",
      weight: 25,
      description: "Whether the call ended with the right disposition for what happened",
      anchors: [
        { points: 25, criteria: "Booking made (Calendly slot confirmed) OR genuine callback scheduled with time+number captured OR referral email/extension captured cleanly" },
        { points: 20, criteria: "Lead expressed clear interest, end-of-call set up follow-up by email/note appropriately" },
        { points: 15, criteria: "Polite 'not now' close OR voicemail correctly hung up for retry OR not-interested with valid prospect-side reason (see rejection_reason_scores)" },
        { points: 10, criteria: "Wrong-person but Aria captured gatekeeper's name + tried for redirect" },
        { points: 5,  criteria: "Wrong-person and Aria hung up without trying to capture a referral" },
        { points: 0,  criteria: "Hung up mid-conversation OR ended a productive call abruptly OR booked into nothing" },
      ],
    },
  ],

  // When call_outcome is "not_interested", score the Outcome dimension based on REASON
  rejection_reason_scores: {
    "already_have_solution":   20, // clean prospect-side reason
    "wrong_role_department":   15, // should have captured referral
    "bad_timing":              20, // budget freeze / mid-semester / restructure
    "dont_want_ai":            10, // track frequency — pivot may need work
    "aria_couldnt_explain":     0, // Aria's fault — flag for prompt review
    "aria_unclear_voice":       0, // TTS/pace issue
    "aria_pushy":               0, // behaviour issue
    "no_reason_given":         10, // default
  },

  tiers: [
    { range: [76, 100], name: "Strong",                 action: "Capture as exemplar. Cite in prompt-change proposals to protect against regression. Eligible for periodic prompt-refresh inclusion." },
    { range: [51,  75], name: "Solid",                  action: "Aggregate weekly. Surface what went well in digest." },
    { range: [26,  50], name: "Learning Opportunity",   action: "Track. Pattern of 5+ same-failure-mode in 7 days triggers diagnostic prompt-improvement email." },
    { range: [ 0,  25], name: "Incident",               action: "Email Petrus within 1h IF fault_attribution=aria AND incident_type set. Otherwise treat as Learning Opportunity (low scores from external factors are not Incidents)." },
  ],

  incident_types: [
    "fabricated_facts",
    "ai_disclosure_refused",
    "offensive_or_pushy",
    "compliance_violation",
    "prompt_breakage_loop_or_garbled",
  ],

  fault_attribution_values: ["aria", "external", "mixed"],
};

// Convenience alias — code path that imports `ARIA_RUBRIC` should resolve to v2.
const ARIA_RUBRIC = ARIA_RUBRIC_V2;

// ─── LLM-based auto-scorer (uses Anthropic Claude Haiku 4.5) ────────────────
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY || null;
const HAIKU_MODEL = "claude-haiku-4-5-20251001";

let _anthropicClient = null;
function getAnthropicClient() {
  if (_anthropicClient) return _anthropicClient;
  if (!ANTHROPIC_API_KEY) {
    throw new Error("ANTHROPIC_API_KEY not configured. Add it to Railway env vars to enable auto-scoring.");
  }
  const Anthropic = require("@anthropic-ai/sdk");
  _anthropicClient = new Anthropic({ apiKey: ANTHROPIC_API_KEY });
  return _anthropicClient;
}

function buildScoringSystemPrompt() {
  return `You are a sales call quality analyst. You score calls made by Aria, an AI SDR for Sendsteps (an interactive presentation platform for universities).

RUBRIC (v2.0):
${JSON.stringify(ARIA_RUBRIC_V2, null, 2)}

INSTRUCTIONS:
1. Read the call transcript carefully.
2. Score each of the 4 dimensions (0-25). If no human was reached, set Opener Execution and Discovery & Adaptation to null (NOT 0).
3. For Outcome & Closure, if disposition is "not_interested", classify the rejection_reason and use the corresponding score from rejection_reason_scores.
4. Set fault_attribution: "aria" if Aria's behaviour caused the failure, "external" if it was the IVR/switchboard/data quality, "mixed" if both.
5. Set tier based on total score AND fault_attribution: Incident requires score ≤ 25 AND fault_attribution=aria AND a recognised incident_type. Otherwise low scores fall in Learning Opportunity.
6. Identify key_failure_mode in 2-4 words (e.g., "spoke_over_ivr", "gatekeeper_pivot_missed", "ai_disclosure_fumbled").
7. Provide what_went_well and what_went_wrong in 1-2 sentences each, drawing from specific transcript moments.
8. For Strong-tier calls (≥76), include 1-3 exemplar_snippets — short transcript excerpts (max 200 chars each) demonstrating the specific behaviour worth amplifying.

OUTPUT: ONLY a single JSON object. No prose before or after. No markdown code fences. Just the raw JSON.

Schema:
{
  "scores": {
    "connection_quality": <0-25 or null>,
    "opener_execution":   <0-25 or null>,
    "discovery_adaptation": <0-25 or null>,
    "outcome_closure":    <0-25>
  },
  "score_total": <sum of non-null scores; if some are null, scale to 100 proportionally>,
  "tier": "Strong" | "Solid" | "Learning Opportunity" | "Incident",
  "fault_attribution": "aria" | "external" | "mixed",
  "incident_type": <one of incident_types or null>,
  "key_failure_mode": "<short_snake_case>",
  "what_went_well": "<1-2 sentences>",
  "what_went_wrong": "<1-2 sentences>",
  "rejection_reason": <one of rejection_reason_scores keys, or null>,
  "exemplar_snippets": [<up to 3 short strings>]
}`;
}

function buildScoringUserPrompt({ transcript, callMetadata }) {
  const meta = {
    call_id: callMetadata.call_id,
    duration_seconds: Math.round((callMetadata.duration_ms || 0) / 1000),
    disconnection_reason: callMetadata.disconnection_reason,
    to_number: callMetadata.to_number,
    prospect_first_name: callMetadata.prospect_first_name,
    university_name: callMetadata.university_name,
    persona_type: callMetadata.persona_type,
    retell_call_outcome: callMetadata.call_outcome,
    retell_call_summary: callMetadata.call_summary,
  };
  return `CALL METADATA:
${JSON.stringify(meta, null, 2)}

TRANSCRIPT:
${transcript || "(empty)"}`;
}

async function scoreCallWithLLM({ transcript, callMetadata }) {
  const client = getAnthropicClient();
  const response = await client.messages.create({
    model: HAIKU_MODEL,
    max_tokens: 2000,
    system: buildScoringSystemPrompt(),
    messages: [{ role: "user", content: buildScoringUserPrompt({ transcript, callMetadata }) }],
  });
  const text = response.content[0].text;
  // Strip code fences if Claude added them despite instruction
  const cleaned = text.replace(/^```(json)?\s*/m, "").replace(/```\s*$/m, "").trim();
  let parsed;
  try {
    parsed = JSON.parse(cleaned);
  } catch (err) {
    throw new Error(`LLM returned non-JSON: ${cleaned.slice(0, 200)}`);
  }
  parsed.rubric_version = "2.0";
  parsed.scored_at = new Date().toISOString();
  parsed.model = HAIKU_MODEL;
  return parsed;
}


// ─── Deterministic tier classifier ─────────────────────────────────────────
// We override Claude's tier output with a code-side classifier because:
//   - Strict rule: Incident requires score≤25 AND fault=aria AND a recognised
//     incident pattern. Claude was too liberal (flagged "silent_on_ivr_*" as
//     Incident even though those are internal/learning issues, not external
//     embarrassments worth paging Petrus about).
//   - Code-side classification is deterministic, predictable, and easy to
//     adjust without re-prompting the LLM.
const INCIDENT_FAILURE_MODE_PATTERNS = [
  /fabricat|hallucin|false[_ ]fact|made[_ ]up|invent/,
  /disclosure[_ ]refus|denied[_ ]ai|pretended[_ ]human|lied[_ ]about[_ ]ai/,
  /pushy|aggressive|interrupt(ed|ing)|offensive|rude/,
  /gdpr|pecr|compliance[_ ]violation/,
  /loop(ed|ing)?[_ ]?(forever|endless)?|garbled|prompt[_ ]?broke|repeat[_ ]?endless/,
];
function classifyTier(scoreTotal, faultAttribution, keyFailureMode) {
  if (scoreTotal === null || scoreTotal === undefined) return null;
  const score = Number(scoreTotal);
  if (score >= 76) return "Strong";
  if (score >= 51) return "Solid";
  if (score >= 26) return "Learning Opportunity";
  // Score 0-25 — Incident requires aria-fault AND an actual incident pattern
  if (faultAttribution !== "aria") return "Learning Opportunity";
  const fm = String(keyFailureMode || "").toLowerCase();
  const isIncident = INCIDENT_FAILURE_MODE_PATTERNS.some(p => p.test(fm));
  return isIncident ? "Incident" : "Learning Opportunity";
}

// ─── Public scoring function — used by endpoint AND webhook hook ───────────
// Wraps fetch-call + LLM-score + DB-persist into one reusable function.
// Idempotent: returns existing score if call already scored unless force=true.
async function scoreAndPersist({ pool, call_id, force = false }) {
  if (!call_id) throw new Error("scoreAndPersist: call_id required");

  // Skip if already scored (unless forced)
  if (!force) {
    const existing = await pool.query(
      `SELECT id, total_score, tier, scored_at FROM interaction_scores WHERE call_id = $1`,
      [call_id]
    );
    if (existing.rowCount > 0) {
      return { ok: true, already_scored: true, ...existing.rows[0] };
    }
  }

  const RETELL_API_KEY = process.env.RETELL_API_KEY;
  if (!RETELL_API_KEY) throw new Error("RETELL_API_KEY not configured");
  const callRes = await fetch(`https://api.retellai.com/v2/get-call/${encodeURIComponent(call_id)}`, {
    headers: { Authorization: `Bearer ${RETELL_API_KEY}` },
  });
  if (!callRes.ok) {
    const errText = await callRes.text().catch(() => "");
    throw new Error(`Retell fetch failed (${callRes.status}): ${errText}`);
  }
  const callData = await callRes.json();
  const dvs = callData.retell_llm_dynamic_variables || {};
  const ca = callData.call_analysis || {};
  const cad = ca.custom_analysis_data || {};

  const score = await scoreCallWithLLM({
    transcript: callData.transcript || "",
    callMetadata: {
      call_id: callData.call_id,
      duration_ms: callData.duration_ms,
      disconnection_reason: callData.disconnection_reason,
      to_number: callData.to_number,
      prospect_first_name: dvs.prospect_first_name,
      university_name: dvs.university_name,
      persona_type: dvs.persona_type,
      call_outcome: cad.call_outcome || cad.call_disposition,
      call_summary: ca.call_summary,
    },
  });

  // Pull score_total from various possible shapes Claude may return
  const scoresObj = score.scores || score.dimensions || {};
  const dimScores = {};
  let totalScore = null;
  if (typeof score.score_total === "number") totalScore = score.score_total;
  else if (typeof score.total_score === "number") totalScore = score.total_score;
  // Normalise dimension scores into flat shape: {connection_quality: 15, ...}
  for (const k of Object.keys(scoresObj)) {
    const v = scoresObj[k];
    dimScores[k] = (typeof v === "object" && v !== null && "score" in v) ? v.score : v;
  }
  // If totalScore not given, sum the dim scores
  if (totalScore === null) {
    totalScore = Object.values(dimScores)
      .filter(v => typeof v === "number")
      .reduce((a, b) => a + b, 0);
  }

  // Override Claude's tier with deterministic classification
  const finalTier = classifyTier(totalScore, score.fault_attribution, score.key_failure_mode);

  const insert = await pool.query(`
    INSERT INTO interaction_scores
      (call_id, agent_id, agent_type, rubric_version, dimension_scores,
       total_score, max_score, pct_score, outcome, flags, notes, scored_at,
       tier, fault_attribution, incident_type, rejection_reason,
       what_went_well, what_went_wrong, key_failure_mode, exemplar_snippets, scored_by)
    VALUES
      ($1, $2, $3, '2.0', $4,
       $5, 100, $6, $7, $8, $9, NOW(),
       $10, $11, $12, $13, $14, $15, $16, $17, 'auto-haiku')
    ON CONFLICT (call_id) DO UPDATE SET
       dimension_scores = EXCLUDED.dimension_scores,
       total_score      = EXCLUDED.total_score,
       pct_score        = EXCLUDED.pct_score,
       outcome          = EXCLUDED.outcome,
       tier             = EXCLUDED.tier,
       fault_attribution= EXCLUDED.fault_attribution,
       incident_type    = EXCLUDED.incident_type,
       rejection_reason = EXCLUDED.rejection_reason,
       what_went_well   = EXCLUDED.what_went_well,
       what_went_wrong  = EXCLUDED.what_went_wrong,
       key_failure_mode = EXCLUDED.key_failure_mode,
       exemplar_snippets= EXCLUDED.exemplar_snippets,
       rubric_version   = '2.0',
       scored_by        = 'auto-haiku',
       scored_at        = NOW()
    RETURNING id
  `, [
    call_id,
    callData.agent_id || null,
    "aria",
    JSON.stringify(dimScores),
    totalScore,
    totalScore,
    cad.call_outcome || cad.call_disposition || null,
    JSON.stringify({}),
    score.what_went_wrong || null,
    finalTier,
    score.fault_attribution,
    score.incident_type || null,
    score.rejection_reason || null,
    score.what_went_well,
    score.what_went_wrong,
    score.key_failure_mode,
    JSON.stringify(score.exemplar_snippets || []),
  ]);

  console.log(`[SCORER-AUTO] call=${call_id} score=${totalScore}/100 tier=${finalTier} fault=${score.fault_attribution} mode=${score.key_failure_mode}`);
  return { ok: true, score_id: insert.rows[0].id, score: { ...score, tier: finalTier, score_total: totalScore } };
}

// ─── Sweep: catch any unscored Aria calls in the last N hours ──────────────
async function runScorerSweep({ pool, hoursBack = 24, agentIds = ["agent_aa56b68b02f6de4ac5725a829b"] }) {
  const RETELL_API_KEY = process.env.RETELL_API_KEY;
  if (!RETELL_API_KEY) throw new Error("RETELL_API_KEY not configured");
  const since = Date.now() - hoursBack * 60 * 60 * 1000;

  // Fetch recent Aria calls from Retell
  const listRes = await fetch("https://api.retellai.com/v2/list-calls", {
    method: "POST",
    headers: { Authorization: `Bearer ${RETELL_API_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      limit: 100,
      filter_criteria: { agent_id: agentIds, start_timestamp: { lower_threshold: since } },
      sort_order: "descending",
    }),
  });
  if (!listRes.ok) throw new Error(`list-calls failed (${listRes.status})`);
  const calls = await listRes.json();

  // Filter to call_analyzed-eligible (have a transcript / completed)
  const candidates = calls.filter(c =>
    c.call_status === "ended" &&
    c.transcript && c.transcript.length > 50 &&
    c.disconnection_reason !== "dial_no_answer"
  );

  // Find which already have scores
  const ids = candidates.map(c => c.call_id);
  if (ids.length === 0) return { ok: true, candidates: 0, scored: 0, errors: 0 };
  const existingRes = await pool.query(
    `SELECT call_id FROM interaction_scores WHERE call_id = ANY($1::text[])`,
    [ids]
  );
  const alreadyScored = new Set(existingRes.rows.map(r => r.call_id));
  const toScore = candidates.filter(c => !alreadyScored.has(c.call_id));

  console.log(`[SCORER-SWEEP] hoursBack=${hoursBack} candidates=${candidates.length} alreadyScored=${alreadyScored.size} toScore=${toScore.length}`);

  let scored = 0, errors = 0;
  for (const c of toScore) {
    try {
      await scoreAndPersist({ pool, call_id: c.call_id });
      scored++;
    } catch (err) {
      console.error(`[SCORER-SWEEP] failed call_id=${c.call_id}: ${err.message}`);
      errors++;
    }
  }
  return { ok: errors === 0, candidates: candidates.length, scored, errors, skipped: alreadyScored.size };
}

// ─── Database table for scores ──────────────────────────────────────────────

async function initScorerTable(pool) {
  // Base table — v1.0 schema, unchanged for backward compat with human scoring
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
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_interaction_scores_agent_id ON interaction_scores (agent_id);`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_interaction_scores_scored_at ON interaction_scores (scored_at);`);

  // v2.0 additive columns — auto-scoring fields. Idempotent: ADD COLUMN IF NOT EXISTS.
  await pool.query(`
    ALTER TABLE interaction_scores
      ADD COLUMN IF NOT EXISTS tier              VARCHAR(32),
      ADD COLUMN IF NOT EXISTS fault_attribution VARCHAR(16),
      ADD COLUMN IF NOT EXISTS incident_type     VARCHAR(48),
      ADD COLUMN IF NOT EXISTS rejection_reason  VARCHAR(48),
      ADD COLUMN IF NOT EXISTS what_went_well    TEXT,
      ADD COLUMN IF NOT EXISTS what_went_wrong   TEXT,
      ADD COLUMN IF NOT EXISTS key_failure_mode  VARCHAR(64),
      ADD COLUMN IF NOT EXISTS exemplar_snippets JSONB,
      ADD COLUMN IF NOT EXISTS scored_by         VARCHAR(32) DEFAULT 'human'
  `);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_interaction_scores_tier ON interaction_scores (tier);`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_interaction_scores_fault ON interaction_scores (fault_attribution);`);
  console.log("Database table interaction_scores ready (v2.0 schema).");
}

// ─── Express route handlers ─────────────────────────────────────────────────

function registerRoutes(app, pool, { requireAuth = (req, res, next) => next() } = {}) {
  // ─── Auto-scoring endpoint (LLM-driven) ──────────────────────────────────
  // POST /scorer/auto-score
  //   Body: { call_id: "call_xxx", force?: bool }
  //   Fetches the call from Retell, scores it with Claude Haiku 4.5, writes
  //   the result to interaction_scores. Idempotent: returns existing score
  //   if already scored unless force=true.
  app.post("/scorer/auto-score", async (req, res) => {
    try {
      const { call_id, force } = req.body || {};
      if (!call_id) return res.status(400).json({ error: "Missing call_id" });
      const result = await scoreAndPersist({ pool, call_id, force: !!force });
      res.json(result);
    } catch (err) {
      console.error("[SCORER-AUTO] Error:", err.message);
      res.status(500).json({ error: err.message });
    }
  });

  // POST /scorer/sweep — backfill scoring for any unscored Aria calls
  // Auth-gated. Body: { hoursBack?: 24 }
  app.post("/scorer/sweep", requireAuth, async (req, res) => {
    try {
      const hoursBack = Number(req.body?.hoursBack ?? req.query?.hoursBack ?? 24);
      const result = await runScorerSweep({ pool, hoursBack });
      res.json(result);
    } catch (err) {
      console.error("[SCORER-SWEEP] Error:", err.message);
      res.status(500).json({ error: err.message });
    }
  });




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
  ARIA_RUBRIC,         // alias for V2 (for backward-compat imports)
  ARIA_RUBRIC_V1,      // deprecated; kept for historical reference
  ARIA_RUBRIC_V2,      // active
  ECONOWIND_RUBRIC,
  scoreCallWithLLM,
  scoreAndPersist,     // exported so the main webhook can fire-and-forget
  runScorerSweep,      // exported for use in scheduled cron
  classifyTier,
  HAIKU_MODEL,
};
