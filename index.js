const express = require("express");
const crypto = require("crypto");
const { Pool } = require("pg");
const calendly = require("./calendly");
const scorer = require("./interaction-scorer");
const odooProxy = require("./odoo-proxy");
const { createBatchCall, validateProspect, mapZohoLead, agentFromAriaStatus, AGENTS } = require("./batch-caller");

// ─── Config ───────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
const DATABASE_URL = process.env.DATABASE_URL;
const RETELL_WEBHOOK_SECRET = process.env.RETELL_WEBHOOK_SECRET || null;

// ─── Email Config (Resend HTTP API) ─────────────────────────────────────────
const RESEND_API_KEY = process.env.RESEND_API_KEY || null;
const NOTIFY_FROM = process.env.NOTIFY_FROM || "notifications@adsum-auxilio.com";
const NOTIFY_TO = process.env.NOTIFY_TO || null;
const NOTIFY_SECRET = process.env.NOTIFY_SECRET || null;

// ─── Zoho CRM Direct API (Aria End Call) ─────────────────────────────────────
const ZOHO_CLIENT_ID     = process.env.ZOHO_CLIENT_ID     || null;
const ZOHO_CLIENT_SECRET = process.env.ZOHO_CLIENT_SECRET || null;
const ZOHO_REFRESH_TOKEN = process.env.ZOHO_REFRESH_TOKEN || null;
const ZOHO_CRM_BASE      = "https://www.zohoapis.eu/crm/v2";
const ZOHO_OAUTH_BASE    = "https://accounts.zoho.eu/oauth/v2";

// In-memory token cache (refreshed automatically when expired)
let zohoTokenCache = { token: null, expiresAt: 0 };

// ─── EconoWind Lead Routing Config ──────────────────────────────────────────
const ECONOWIND_MANAGERS = {
  "southern_europe": { name: "Willem Stam", email: "stam@econowind.nl", region: "Southern Europe & Turkey" },
  "turkey":          { name: "Willem Stam", email: "stam@econowind.nl", region: "Southern Europe & Turkey" },
  "northern_europe": { name: "Stijn Engelage", email: "engelage@econowind.nl", region: "Northern Europe, Americas, ME & Africa" },
  "americas":        { name: "Stijn Engelage", email: "engelage@econowind.nl", region: "Northern Europe, Americas, ME & Africa" },
  "middle_east":     { name: "Stijn Engelage", email: "engelage@econowind.nl", region: "Northern Europe, Americas, ME & Africa" },
  "africa":          { name: "Stijn Engelage", email: "engelage@econowind.nl", region: "Northern Europe, Americas, ME & Africa" },
  "asia":            { name: "Philippe Brands", email: "brands@econowind.nl", region: "Asia" },
  "se_asia":         { name: "Naomi Vernimmen", email: "vernimmen@econowind.nl", region: "SE Asia & Singapore" },
  "singapore":       { name: "Naomi Vernimmen", email: "vernimmen@econowind.nl", region: "SE Asia & Singapore" },
};
const ECONOWIND_FALLBACK_MANAGER = { name: "Willem Stam", email: "stam@econowind.nl", region: "Fallback (unmapped region)" };
// Also CC Piet on all P1 leads
const ECONOWIND_CC_P1 = process.env.ECONOWIND_CC_P1 || "coelewijp@gmail.com";

if (!DATABASE_URL) {
  console.error("FATAL: DATABASE_URL environment variable is not set.");
  process.exit(1);
}

// ─── PostgreSQL ───────────────────────────────────────────────────────────────
const pool = new Pool({
  connectionString: DATABASE_URL,
  ssl: process.env.DB_SSL === "false" ? false : { rejectUnauthorized: false },
  max: 5,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 5000,
});

// ─── Table creation on startup ────────────────────────────────────────────────
async function initDatabase() {
  const client = await pool.connect();
  try {
    await client.query(`
      CREATE TABLE IF NOT EXISTS retell_events (
        id              SERIAL PRIMARY KEY,
        event_type      VARCHAR(64) NOT NULL,
        agent_id        VARCHAR(128),
        call_id         VARCHAR(128),
        transcript      TEXT,
        call_analysis   JSONB,
        full_payload    JSONB NOT NULL,
        received_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
    `);

    // Indexes for fast lookups by the Paperclip agents
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_retell_events_agent_id    ON retell_events (agent_id);
    `);
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_retell_events_event_type  ON retell_events (event_type);
    `);
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_retell_events_received_at ON retell_events (received_at);
    `);
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_retell_events_call_id     ON retell_events (call_id);
    `);

    // Notifications log table
    await client.query(`
      CREATE TABLE IF NOT EXISTS notifications (
        id          SERIAL PRIMARY KEY,
        subject     VARCHAR(255) NOT NULL,
        body        TEXT,
        priority    VARCHAR(32) DEFAULT 'normal',
        source      VARCHAR(128),
        status      VARCHAR(32) NOT NULL DEFAULT 'sent',
        error       TEXT,
        sent_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
    `);

    console.log("Database table retell_events ready with indexes.");
    console.log("Database table notifications ready.");

    // EconoWind leads table
    await client.query(`
      CREATE TABLE IF NOT EXISTS econowind_leads (
        id                SERIAL PRIMARY KEY,
        company_name      VARCHAR(255),
        contact_name      VARCHAR(255),
        contact_email     VARCHAR(255),
        contact_phone     VARCHAR(64),
        job_title         VARCHAR(255),
        fleet_size        VARCHAR(64),
        vessel_types      TEXT,
        region            VARCHAR(128),
        timeline          VARCHAR(128),
        decision_authority VARCHAR(128),
        awareness_level   VARCHAR(128),
        specific_interest TEXT,
        conversation_summary TEXT,
        revenue_score     INTEGER,
        conversion_score  INTEGER,
        total_score       INTEGER,
        priority          VARCHAR(4),
        assigned_manager  VARCHAR(255),
        manager_email     VARCHAR(255),
        notification_sent BOOLEAN DEFAULT FALSE,
        received_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
    `);
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_econowind_leads_priority ON econowind_leads (priority);
    `);
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_econowind_leads_received ON econowind_leads (received_at);
    `);
    console.log("Database table econowind_leads ready.");

    // Interaction scores table (for Paperclip Interaction Scorer agent)
    await scorer.initScorerTable(pool);
  } finally {
    client.release();
  }
}

// ─── Email via Resend HTTP API ───────────────────────────────────────────────
if (RESEND_API_KEY) {
  console.log(`Email configured via Resend API (from: ${NOTIFY_FROM}, to: ${NOTIFY_TO})`);
} else {
  console.log("Email not configured (set RESEND_API_KEY to enable)");
}

async function sendEmail({ from, to, subject, text, html }) {
  if (!RESEND_API_KEY) {
    throw new Error("Resend API key not configured");
  }
  const resp = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${RESEND_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      from: from,
      to: Array.isArray(to) ? to : [to],
      subject: subject,
      text: text,
      html: html || undefined,
    }),
  });
  if (!resp.ok) {
    const err = await resp.json().catch(() => ({}));
    throw new Error(`Resend API error ${resp.status}: ${err.message || resp.statusText}`);
  }
  const data = await resp.json();
  return { id: data.id, status: "sent" };
}

// ─── Business Hours Check (for Retell custom functions) ─────────────────────
function isBusinessHours() {
  const now = new Date();
  // Convert to CET/CEST
  const cetStr = now.toLocaleString("en-US", { timeZone: "Europe/Amsterdam" });
  const cet = new Date(cetStr);
  const day = cet.getDay(); // 0=Sun, 1=Mon...6=Sat
  const hour = cet.getHours();
  const minute = cet.getMinutes();
  const totalMinutes = hour * 60 + minute;
  // Mon-Fri (1-5), 09:00 (540) to 17:00 (1020)
  return day >= 1 && day <= 5 && totalMinutes >= 540 && totalMinutes < 1020;
}

// ─── Webhook signature verification (optional) ───────────────────────────────
function verifySignature(rawBody, signature) {
  if (!RETELL_WEBHOOK_SECRET) return true; // skip if no secret configured
  if (!signature) {
    console.warn("[WARN] No x-retell-signature header present — skipping verification.");
    return true; // allow through but log warning
  }
  try {
    const hmac = crypto.createHmac("sha256", RETELL_WEBHOOK_SECRET);
    hmac.update(rawBody);
    const expected = hmac.digest("hex");
    return crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expected));
  } catch (err) {
    console.error("Signature verification error:", err.message);
    return false;
  }
}

// ─── Express app ──────────────────────────────────────────────────────────────
const app = express();

// Capture raw body for signature verification, then parse JSON
app.use(
  express.json({
    limit: "5mb",
    verify: (req, _res, buf) => {
      req.rawBody = buf.toString("utf-8");
    },
  })
);

// ─── Auth middleware (reusable across protected endpoints) ────────────────────
function requireAuth(req, res, next) {
  if (!NOTIFY_SECRET) return next(); // no secret configured, allow all
  const auth = req.headers["x-notify-secret"] || req.body.secret;
  if (auth !== NOTIFY_SECRET) {
    return res.status(401).json({ error: "Invalid or missing secret" });
  }
  next();
}

// ─── Business hours endpoint (for Retell custom functions / transfer logic) ──
app.get("/business-hours", (_req, res) => {
  const open = isBusinessHours();
  const now = new Date();
  const cetStr = now.toLocaleString("en-US", { timeZone: "Europe/Amsterdam" });
  res.json({
    is_open: open,
    timezone: "Europe/Amsterdam",
    window: "Mon-Fri 09:00-17:00 CET",
    current_time_cet: cetStr,
  });
});

// ─── Health check ─────────────────────────────────────────────────────────────
app.get("/", (_req, res) => {
  res.json({
    service: "retell-webhook-receiver",
    status: "ok",
    version: "1.8.0",
    description: "Scala Auxilium — Retell AI webhook ingestion for Paperclip monitoring agents",
  });
});

app.get("/health", async (_req, res) => {
  try {
    await pool.query("SELECT 1");
    res.json({ status: "healthy", database: "connected" });
  } catch (err) {
    res.status(503).json({ status: "unhealthy", database: err.message });
  }
});

// ─── Aria Call-Ended → Zoho Flow Disposition Mapping ─────────────────────────

/**
 * Map a Retell call_ended event to one of our 13 Zoho CRM dispositions.
 *
 * Priority order:
 *   1. call_analysis.call_outcome  (Retell Post-Call Analysis — most reliable)
 *   2. disconnection_reason        (Retell call metadata — fallback)
 *
 * Dispositions: no_answer, voicemail_left, meeting_booked, callback_requested,
 *               not_interested, wrong_person, referral_given, call_failed,
 *               email_followup, warm_nurture, internal_discussion,
 *               transfer_succeeded, transfer_failed_no_action, existing_customer
 */
function mapAriaDisposition(callData, callAnalysis) {
  // ── Method 1: Post-Call Analysis (if enabled on the Retell agent) ──────────
  if (callAnalysis) {
    const outcome = (callAnalysis.call_outcome || callAnalysis.outcome || "").toLowerCase().trim();
    // Direct match against our 13 dispositions
    const validDispositions = [
      "no_answer", "voicemail_left", "meeting_booked", "callback_requested",
      "not_interested", "wrong_person", "referral_given", "call_failed",
      "email_followup", "warm_nurture", "internal_discussion",
      "transfer_succeeded", "transfer_failed_no_action", "existing_customer",
    ];
    if (validDispositions.includes(outcome)) {
      return { disposition: outcome, method: "call_analysis", confidence: "high" };
    }
    // Fuzzy match common Retell analysis values
    if (/meeting|booked|demo|scheduled|appointment/i.test(outcome)) {
      return { disposition: "meeting_booked", method: "call_analysis_fuzzy", confidence: "high" };
    }
    if (/not.interested|declined|rejected|no.thanks/i.test(outcome)) {
      return { disposition: "not_interested", method: "call_analysis_fuzzy", confidence: "high" };
    }
    if (/callback|call.back|reschedule|later/i.test(outcome)) {
      return { disposition: "callback_requested", method: "call_analysis_fuzzy", confidence: "medium" };
    }
    if (/voicemail|vm|left.message/i.test(outcome)) {
      return { disposition: "voicemail_left", method: "call_analysis_fuzzy", confidence: "high" };
    }
    if (/wrong.person|wrong.number|not.the.right/i.test(outcome)) {
      return { disposition: "wrong_person", method: "call_analysis_fuzzy", confidence: "high" };
    }
    if (/referr|redirect|colleague|pass/i.test(outcome)) {
      return { disposition: "referral_given", method: "call_analysis_fuzzy", confidence: "medium" };
    }
    if (/no.answer|no.pickup|unanswered/i.test(outcome)) {
      return { disposition: "no_answer", method: "call_analysis_fuzzy", confidence: "high" };
    }
    if (/fail|error|technical/i.test(outcome)) {
      return { disposition: "call_failed", method: "call_analysis_fuzzy", confidence: "high" };
    }
    // New disposition fuzzy matchers (April 2026 structural fixes)
    if (/email.follow|send.email|just.email|email.info/i.test(outcome)) {
      return { disposition: "email_followup", method: "call_analysis_fuzzy", confidence: "high" };
    }
    if (/nurture|warm|not.ready|next.semester|revisit|think.about/i.test(outcome)) {
      return { disposition: "warm_nurture", method: "call_analysis_fuzzy", confidence: "medium" };
    }
    if (/internal.discussion|check.with|colleague|department|run.this.by|team.decision/i.test(outcome)) {
      return { disposition: "internal_discussion", method: "call_analysis_fuzzy", confidence: "medium" };
    }
    if (/transfer.success|handed.off|connected.to.human|human.took.over/i.test(outcome)) {
      return { disposition: "transfer_succeeded", method: "call_analysis_fuzzy", confidence: "high" };
    }
    if (/transfer.fail|could.not.connect|nobody.available/i.test(outcome)) {
      return { disposition: "transfer_failed_no_action", method: "call_analysis_fuzzy", confidence: "medium" };
    }
    if (/existing.customer|already.use|already.have|already.using|current.customer/i.test(outcome)) {
      return { disposition: "existing_customer", method: "call_analysis_fuzzy", confidence: "high" };
    }
  }

  // ── Method 2: Retell disconnection_reason (fallback) ──────────────────────
  const reason = (callData.disconnection_reason || "").toLowerCase();
  const durationMs = callData.duration_ms || 0;
  const hasTranscript = !!(callData.transcript && callData.transcript.length > 50);

  // Clear-cut cases from Retell's disconnection reasons
  if (reason === "dial_no_answer" || reason === "no_answer") {
    return { disposition: "no_answer", method: "disconnection_reason", confidence: "high" };
  }
  if (reason === "dial_busy") {
    return { disposition: "no_answer", method: "disconnection_reason", confidence: "high" };
  }
  if (reason === "machine_detected" || reason === "voicemail_reach") {
    return { disposition: "voicemail_left", method: "disconnection_reason", confidence: "medium" };
  }
  if (reason === "dial_failed" || reason === "line_busy") {
    return { disposition: "call_failed", method: "disconnection_reason", confidence: "high" };
  }
  if (reason.startsWith("error_") || reason === "unknown_error") {
    return { disposition: "call_failed", method: "disconnection_reason", confidence: "high" };
  }

  // Ambiguous cases — call connected but we don't know outcome
  if (reason === "user_hangup" || reason === "agent_hangup" || reason === "inactivity") {
    // Very short call with no meaningful transcript → likely no real contact
    if (durationMs < 15000 && !hasTranscript) {
      return { disposition: "no_answer", method: "short_call_heuristic", confidence: "low" };
    }
    // Call had real conversation but no call_analysis → can't determine outcome
    // Default to "call_failed" with review flag so human can check
    return { disposition: "call_failed", method: "no_analysis_fallback", confidence: "low" };
  }

  // Unknown disconnection reason
  return { disposition: "call_failed", method: "unknown", confidence: "low" };
}

// Maps Railway disposition codes → Zoho CRM Aria_Status picklist values
const DISPOSITION_TO_ARIA_STATUS = {
  "meeting_booked":            "Completed - Meeting Booked",
  "not_interested":            "Completed - Not Interested",
  "voicemail":                 "Completed - Voicemail",
  "no_answer":                 "Completed - No Answer",
  "call_failed":               "Failed",
  "email_followup":            "Completed - Email Follow-up",
  "warm_nurture":              "Completed - Warm Nurture",
  "internal_discussion":       "Completed - Internal Discussion",
  "transfer_succeeded":        "Completed - Transfer to Human",
  "transfer_failed_no_action": "Completed - Transfer Failed",
  "call_back_scheduled":       "Call back Scheduled",
  "existing_customer":         "Existing Customer",
  "referral_given":            "Completed - Referral Given",
  "wrong_person":              "Completed - Wrong Person",
};

/**
 * Return a valid Zoho CRM access token, refreshing via OAuth when expired.
 */
async function getZohoAccessToken() {
  if (zohoTokenCache.token && Date.now() < zohoTokenCache.expiresAt - 60_000) {
    return zohoTokenCache.token;
  }
  if (!ZOHO_CLIENT_ID || !ZOHO_CLIENT_SECRET || !ZOHO_REFRESH_TOKEN) {
    throw new Error("Zoho OAuth env vars not configured (ZOHO_CLIENT_ID / ZOHO_CLIENT_SECRET / ZOHO_REFRESH_TOKEN)");
  }
  const params = new URLSearchParams({
    grant_type:    "refresh_token",
    client_id:     ZOHO_CLIENT_ID,
    client_secret: ZOHO_CLIENT_SECRET,
    refresh_token: ZOHO_REFRESH_TOKEN,
  });
  const res = await fetch(`${ZOHO_OAUTH_BASE}/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: params.toString(),
  });
  const data = await res.json();
  if (!data.access_token) {
    throw new Error(`Zoho token refresh failed: ${JSON.stringify(data)}`);
  }
  zohoTokenCache = {
    token: data.access_token,
    expiresAt: Date.now() + (data.expires_in || 3600) * 1000,
  };
  console.log(`  [ZOHO] Access token refreshed (expires in ${data.expires_in}s)`);
  return data.access_token;
}

/**
 * Update a Zoho CRM Lead with the Aria call outcome.
 * Resolves the record by zohoLeadId first; falls back to email search.
 */
async function updateZohoCRMLead({ zohoLeadId, prospectEmail, ariaStatus, notes, callId }) {
  const token = await getZohoAccessToken();
  const headers = {
    Authorization: `Zoho-oauthtoken ${token}`,
    "Content-Type": "application/json",
  };

  let recordId = zohoLeadId;

  // 1. If no direct ID, search by email
  if (!recordId && prospectEmail) {
    const searchUrl = `${ZOHO_CRM_BASE}/Leads/search?criteria=(Email:equals:${encodeURIComponent(prospectEmail)})&fields=id`;
    const searchRes = await fetch(searchUrl, { headers });
    if (searchRes.ok) {
      const searchData = await searchRes.json();
      recordId = searchData?.data?.[0]?.id || null;
      if (recordId) {
        console.log(`  [ZOHO] Resolved lead by email ${prospectEmail} → id ${recordId}`);
      } else {
        console.warn(`  [ZOHO] No lead found for email ${prospectEmail}`);
      }
    } else {
      const errText = await searchRes.text().catch(() => "");
      console.warn(`  [ZOHO] Lead search failed (${searchRes.status}): ${errText}`);
    }
  }

  if (!recordId) {
    throw new Error(`Cannot update Zoho CRM: no lead resolved (call: ${callId}, email: ${prospectEmail})`);
  }

  // 2. Update the lead record with Aria fields
  const updateBody = {
    data: [{
      id: recordId,
      Aria_Status:         ariaStatus,
      Aria_Notes:          notes,
      Aria_Last_Call_Date: new Date().toISOString(),
    }],
  };
  const updateRes = await fetch(`${ZOHO_CRM_BASE}/Leads`, {
    method: "PUT",
    headers,
    body: JSON.stringify(updateBody),
  });
  const updateData = await updateRes.json();
  const result = updateData?.data?.[0];
  if (result?.status === "error") {
    throw new Error(`Zoho CRM update error: ${JSON.stringify(result)}`);
  }
  console.log(`  [ZOHO] Lead updated | id: ${recordId} | Aria_Status: ${ariaStatus} | status: ${result?.status}`);
  return { recordId, result };
}

/**
 * Handle an Aria call_ended event: extract disposition and update Zoho CRM directly.
 */
async function handleAriaCallEnded(callData, callAnalysis, callId, agentLabel, receivedAt) {
  const dynVars = callData.retell_llm_dynamic_variables || {};
  const zohoLeadId = dynVars.zoho_lead_id || null;
  const prospectName = dynVars.prospect_first_name || dynVars.contact_name || "";
  const universityName = dynVars.university_name || "";

  // Extract prospect email early — used as fallback CRM identifier when zoho_lead_id is null
  const prospectEmail = callAnalysis?.prospect_email || callAnalysis?.email || dynVars.prospect_email || "";

  console.log(`  [ARIA] Call ended for ${agentLabel} | lead: ${zohoLeadId || "(unknown)"} | prospect: ${prospectName}`);

  // We need at least zoho_lead_id OR prospect_email to identify and update the CRM record
  if (!zohoLeadId && !prospectEmail) {
    console.warn(`  [ARIA] No zoho_lead_id or prospect_email — cannot update Zoho CRM. Call: ${callId}`);
    console.warn(`  [ARIA] Dynamic variables received:`, JSON.stringify(dynVars));
    await pool.query(
      `INSERT INTO notifications (subject, body, priority, source, status)
       VALUES ($1, $2, 'high', 'aria_call_ended', 'skipped')`,
      [
        `Aria call missing zoho_lead_id and email: ${prospectName || callId}`,
        JSON.stringify({ call_id: callId, agent: agentLabel, dynamic_vars: dynVars }),
      ]
    );
    return;
  }

  if (!zohoLeadId) {
    console.warn(`  [ARIA] zoho_lead_id is null — will attempt CRM lookup by email (${prospectEmail})`);
  }

  // Map the disposition
  const { disposition, method, confidence } = mapAriaDisposition(callData, callAnalysis);

  // Build call summary for the notes field
  const durationSec = Math.round((callData.duration_ms || 0) / 1000);
  const disconnectReason = callData.disconnection_reason || "unknown";
  const analysisSummary = callAnalysis?.call_summary || callAnalysis?.summary || "";
  const notes = [
    analysisSummary,
    `Duration: ${durationSec}s`,
    `Disconnect: ${disconnectReason}`,
    `Disposition method: ${method} (${confidence})`,
  ].filter(Boolean).join(". ");

  console.log(`  [ARIA] Disposition: ${disposition} (${method}, ${confidence}) | lead: ${zohoLeadId || "(via email)"}`);

  // Resolve the final Zoho CRM Aria_Status picklist value
  const ariaStatus = DISPOSITION_TO_ARIA_STATUS[disposition] || "Failed";

  // Update Zoho CRM directly via API
  const crmResult = await updateZohoCRMLead({
    zohoLeadId,
    prospectEmail,
    ariaStatus,
    notes,
    callId,
  });

  // Log success to DB
  const zohoPayload = {
    lead_id:    zohoLeadId,
    record_id:  crmResult.recordId,
    disposition,
    aria_status: ariaStatus,
    notes,
    prospect_email: prospectEmail,
    call_id:    callId,
    agent:      agentLabel,
    confidence,
    method,
    duration_sec: durationSec,
    prospect_name: prospectName,
    university_name: universityName,
  };

  await pool.query(
    `INSERT INTO notifications (subject, body, priority, source, status)
     VALUES ($1, $2, 'normal', 'aria_call_ended', 'sent')`,
    [
      `Aria ${disposition}: ${prospectName} @ ${universityName}`,
      JSON.stringify(zohoPayload),
    ]
  );
}

// ─── Main webhook endpoint ────────────────────────────────────────────────────
app.post("/webhooks/retell", async (req, res) => {
  const receivedAt = new Date().toISOString();

  // Always return 200 immediately to Retell (10s timeout, 3 retries on non-2xx)
  res.status(200).json({ received: true });

  try {
    const payload = req.body;

    // Signature verification
    if (RETELL_WEBHOOK_SECRET) {
      const signature = req.headers["x-retell-signature"];
      if (!verifySignature(req.rawBody, signature)) {
        console.error(`[ERR] [${receivedAt}] INVALID SIGNATURE — event dropped.`);
        return;
      }
    }

    // Extract fields from payload
    const eventType = payload.event || "unknown";
    const callData = payload.call || {};
    const agentId = callData.agent_id || null;
    const callId = callData.call_id || null;
    const transcript = callData.transcript || null;
    const callAnalysis = callData.call_analysis || null;

    // Map agent IDs to friendly names for logging
    const agentNames = {
      agent_aa56b68b02f6de4ac5725a829b: "Aria EN (Sendsteps)",
      agent_e1e1f763101db5abe0df281891: "Aria NL (Sendsteps)",
      agent_760482429951f50e816c47b55a: "EconoWind Chat",
    };
    const agentLabel = agentNames[agentId] || agentId || "unknown";

    console.log(
      `→ [${receivedAt}] ${eventType} | agent: ${agentLabel} | call: ${callId || "n/a"} | transcript: ${
        transcript ? transcript.length + " chars" : "none"
      }`
    );

    // Write to PostgreSQL
    await pool.query(
      `INSERT INTO retell_events (event_type, agent_id, call_id, transcript, call_analysis, full_payload, received_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [eventType, agentId, callId, transcript, callAnalysis ? JSON.stringify(callAnalysis) : null, JSON.stringify(payload), receivedAt]
    );

    console.log(`  [OK] Stored in retell_events.`);

    // ─── EconoWind auto-routing: detect VentoBot chats and trigger lead scoring ──
    const ECONOWIND_AGENT_ID = "agent_760482429951f50e816c47b55a";
    if (agentId === ECONOWIND_AGENT_ID && eventType === "call_ended" && callAnalysis) {
      console.log(`  [EW] EconoWind chat ended — extracting lead data from post-chat analysis...`);
      try {
        const lead = mapRetellToEconowindLead(callAnalysis, transcript);
        if (lead) {
          await processEconowindLead(lead, receivedAt);
        } else {
          console.log(`  [EW] No actionable lead data extracted — skipping lead processing.`);
        }
      } catch (ewErr) {
        console.error(`  [ERR] EconoWind auto-routing failed:`, ewErr.message);
        // Don't throw — the main webhook already succeeded
        await pool.query(
          `INSERT INTO notifications (subject, body, priority, source, status, error)
           VALUES ($1, $2, $3, 'econowind_ventobot_auto', 'failed', $4)`,
          [`Auto-routing failed for chat ${callId}`, ewErr.message, "unknown", ewErr.message]
        ).catch(() => {});
      }
    }

    // ─── Aria (Sendsteps) call-end → update Zoho CRM directly ──────────────
    const ARIA_AGENT_IDS = [
      "agent_aa56b68b02f6de4ac5725a829b", // Aria EN
      "agent_e1e1f763101db5abe0df281891", // Aria NL
    ];
    if (ARIA_AGENT_IDS.includes(agentId) && eventType === "call_ended") {
      try {
        await handleAriaCallEnded(callData, callAnalysis, callId, agentLabel, receivedAt);
      } catch (ariaErr) {
        console.error(`  [ARIA] Zoho CRM update failed:`, ariaErr.message);
        await pool.query(
          `INSERT INTO notifications (subject, body, priority, source, status, error)
           VALUES ($1, $2, $3, 'aria_call_ended', 'failed', $4)`,
          [`Aria Zoho update failed for call ${callId}`, ariaErr.message, "high", ariaErr.message]
        ).catch(() => {});
      }
    }
  } catch (err) {
    // DB write failed — we already returned 200 to Retell so it won't retry.
    // Log the error and the full payload so nothing is silently lost.
    console.error(`  [ERR] DB write failed:`, err.message);
    console.error(`  [ERR] Payload that failed to store:`, JSON.stringify(req.body).substring(0, 500));
  }
});

// ─── Email notification endpoint (for Paperclip agents) ──────────────────────
app.post("/notify", requireAuth, async (req, res) => {
  if (!RESEND_API_KEY) {
    return res.status(503).json({ error: "Email not configured. Set RESEND_API_KEY." });
  }

  const { subject, body, html, priority, source } = req.body;
  if (!subject) {
    return res.status(400).json({ error: "Missing required field: subject" });
  }

  // Priority prefix for subject line
  const prefixes = { critical: "CRITICAL", high: "ALERT", normal: "", low: "FYI" };
  const prefix = prefixes[priority] || "";
  const fullSubject = prefix ? `[${prefix}] ${subject}` : subject;

  try {
    await sendEmail({
      from: NOTIFY_FROM,
      to: NOTIFY_TO,
      subject: fullSubject,
      text: body || subject,
      html: html || undefined,
    });

    // Log to database
    await pool.query(
      `INSERT INTO notifications (subject, body, priority, source, status) VALUES ($1, $2, $3, $4, 'sent')`,
      [fullSubject, body || subject, priority || "normal", source || "unknown"]
    );

    console.log(`Email sent: "${fullSubject}" from ${source || "unknown"}`);
    res.json({ sent: true, subject: fullSubject });
  } catch (err) {
    // Log failure
    await pool.query(
      `INSERT INTO notifications (subject, body, priority, source, status, error) VALUES ($1, $2, $3, $4, 'failed', $5)`,
      [fullSubject, body || subject, priority || "normal", source || "unknown", err.message]
    ).catch(() => {});

    console.error("Email send failed:", err.message);
    res.status(500).json({ error: "Failed to send email", details: err.message });
  }
});

// ─── Notification history endpoint ───────────────────────────────────────────
app.get("/notifications", async (req, res) => {
  try {
    const { limit = 50 } = req.query;
    const result = await pool.query(
      `SELECT * FROM notifications ORDER BY sent_at DESC LIMIT $1`,
      [Math.min(parseInt(limit) || 50, 200)]
    );
    res.json({ count: result.rows.length, notifications: result.rows });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── Stats endpoint (useful for Paperclip agents) ────────────────────────────
app.get("/stats", async (_req, res) => {
  try {
    const result = await pool.query(`
      SELECT
        event_type,
        agent_id,
        COUNT(*) as count,
        MIN(received_at) as earliest,
        MAX(received_at) as latest
      FROM retell_events
      GROUP BY event_type, agent_id
      ORDER BY latest DESC
    `);
    res.json({ total_events: result.rows.reduce((s, r) => s + parseInt(r.count), 0), breakdown: result.rows });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── Events query endpoint (for Paperclip agents to pull recent events) ──────
app.get("/events", async (req, res) => {
  try {
    const { agent_id, event_type, since, limit = 100 } = req.query;
    let query = "SELECT * FROM retell_events WHERE 1=1";
    const params = [];
    let paramIdx = 1;

    if (agent_id) {
      query += ` AND agent_id = $${paramIdx++}`;
      params.push(agent_id);
    }
    if (event_type) {
      query += ` AND event_type = $${paramIdx++}`;
      params.push(event_type);
    }
    if (since) {
      query += ` AND received_at >= $${paramIdx++}`;
      params.push(since);
    }

    query += ` ORDER BY received_at DESC LIMIT $${paramIdx}`;
    params.push(Math.min(parseInt(limit) || 100, 500));

    const result = await pool.query(query, params);
    res.json({ count: result.rows.length, events: result.rows });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── EconoWind Lead Scoring ──────────────────────────────────────────────────

function classifyPriority(revenueScore, conversionScore) {
  const rev = parseInt(revenueScore) || 0;
  const conv = parseInt(conversionScore) || 0;
  const total = rev + conv;

  if (rev >= 13 && conv >= 10) return { priority: "P1", label: "HOT LEAD", color: "#DC2626", sla: "Immediate" };
  if (rev >= 13 || conv >= 10) return { priority: "P2", label: "WARM LEAD", color: "#EA580C", sla: "Within 4 hours" };
  if (total >= 10)             return { priority: "P3", label: "NURTURE", color: "#2563EB", sla: "Same business day" };
  return { priority: "P4", label: "LONG-TERM", color: "#6B7280", sla: "Marketing nurture only" };
}

function routeToManager(region) {
  if (!region) return ECONOWIND_FALLBACK_MANAGER;
  const key = region.toLowerCase().replace(/[\s-]+/g, "_").replace(/[^a-z_]/g, "");
  // Try direct match first, then fuzzy
  if (ECONOWIND_MANAGERS[key]) return ECONOWIND_MANAGERS[key];
  // Check if region string contains any known key
  for (const [k, mgr] of Object.entries(ECONOWIND_MANAGERS)) {
    if (key.includes(k) || k.includes(key)) return mgr;
  }
  return ECONOWIND_FALLBACK_MANAGER;
}

function buildLeadEmailHtml(lead, priorityInfo, manager) {
  const { priority, label, color, sla } = priorityInfo;
  return `
<!DOCTYPE html>
<html>
<head><meta charset="utf-8"></head>
<body style="font-family: Arial, sans-serif; max-width: 640px; margin: 0 auto; padding: 20px;">
  <div style="background: ${color}; color: white; padding: 12px 20px; border-radius: 8px 8px 0 0;">
    <h2 style="margin: 0; font-size: 18px;">${priority} — ${label}</h2>
    <p style="margin: 4px 0 0; font-size: 13px; opacity: 0.9;">SLA: ${sla} | Assigned to: ${manager.name}</p>
  </div>
  <div style="border: 1px solid #ddd; border-top: none; border-radius: 0 0 8px 8px; padding: 20px;">
    <h3 style="margin: 0 0 16px; color: #1a1a1a;">New EconoWind Lead</h3>
    <table style="width: 100%; border-collapse: collapse; font-size: 14px;">
      <tr style="border-bottom: 1px solid #eee;">
        <td style="padding: 8px 0; font-weight: bold; color: #555; width: 140px;">Company</td>
        <td style="padding: 8px 0;">${lead.company_name || "—"}</td>
      </tr>
      <tr style="border-bottom: 1px solid #eee;">
        <td style="padding: 8px 0; font-weight: bold; color: #555;">Contact</td>
        <td style="padding: 8px 0;">${lead.contact_name || "—"} ${lead.job_title ? "(" + lead.job_title + ")" : ""}</td>
      </tr>
      <tr style="border-bottom: 1px solid #eee;">
        <td style="padding: 8px 0; font-weight: bold; color: #555;">Email</td>
        <td style="padding: 8px 0;">${lead.contact_email || "—"}</td>
      </tr>
      <tr style="border-bottom: 1px solid #eee;">
        <td style="padding: 8px 0; font-weight: bold; color: #555;">Phone</td>
        <td style="padding: 8px 0;">${lead.contact_phone || "—"}</td>
      </tr>
      <tr style="border-bottom: 1px solid #eee;">
        <td style="padding: 8px 0; font-weight: bold; color: #555;">Fleet Size</td>
        <td style="padding: 8px 0;">${lead.fleet_size || "—"}</td>
      </tr>
      <tr style="border-bottom: 1px solid #eee;">
        <td style="padding: 8px 0; font-weight: bold; color: #555;">Vessel Types</td>
        <td style="padding: 8px 0;">${lead.vessel_types || "—"}</td>
      </tr>
      <tr style="border-bottom: 1px solid #eee;">
        <td style="padding: 8px 0; font-weight: bold; color: #555;">Region</td>
        <td style="padding: 8px 0;">${lead.region || "—"}</td>
      </tr>
      <tr style="border-bottom: 1px solid #eee;">
        <td style="padding: 8px 0; font-weight: bold; color: #555;">Timeline</td>
        <td style="padding: 8px 0;">${lead.timeline || "—"}</td>
      </tr>
      <tr style="border-bottom: 1px solid #eee;">
        <td style="padding: 8px 0; font-weight: bold; color: #555;">Decision Authority</td>
        <td style="padding: 8px 0;">${lead.decision_authority || "—"}</td>
      </tr>
      <tr style="border-bottom: 1px solid #eee;">
        <td style="padding: 8px 0; font-weight: bold; color: #555;">Awareness</td>
        <td style="padding: 8px 0;">${lead.awareness_level || "—"}</td>
      </tr>
      <tr style="border-bottom: 1px solid #eee;">
        <td style="padding: 8px 0; font-weight: bold; color: #555;">Interest</td>
        <td style="padding: 8px 0;">${lead.specific_interest || "—"}</td>
      </tr>
    </table>

    <div style="margin-top: 16px; padding: 12px; background: #f8f9fa; border-radius: 6px;">
      <p style="margin: 0 0 4px; font-weight: bold; color: #555; font-size: 13px;">SCORES</p>
      <p style="margin: 0; font-size: 14px;">
        Revenue Potential: <strong>${lead.revenue_score || 0}/25</strong> &nbsp;|&nbsp;
        Conversion Likelihood: <strong>${lead.conversion_score || 0}/18</strong> &nbsp;|&nbsp;
        Total: <strong>${(parseInt(lead.revenue_score) || 0) + (parseInt(lead.conversion_score) || 0)}/43</strong>
      </p>
    </div>

    ${lead.conversation_summary ? `
    <div style="margin-top: 16px; padding: 12px; background: #f0f4ff; border-radius: 6px; border-left: 4px solid ${color};">
      <p style="margin: 0 0 4px; font-weight: bold; color: #555; font-size: 13px;">CONVERSATION SUMMARY</p>
      <p style="margin: 0; font-size: 14px; color: #333; line-height: 1.5;">${lead.conversation_summary}</p>
    </div>` : ""}

    <p style="margin: 16px 0 0; font-size: 12px; color: #999;">
      Sent by Scala Auxilium AI Sales Platform &bull; ${new Date().toISOString().split("T")[0]}
    </p>
  </div>
</body>
</html>`;
}

// ─── EconoWind Lead Processing (shared logic) ───────────────────────────────

// Maps Retell post-chat extraction (call_analysis) to econowind lead format
function mapRetellToEconowindLead(callAnalysis, transcript) {
  if (!callAnalysis) return null;

  // Retell post-chat extraction fields → econowind lead fields
  const lead = {
    company_name: callAnalysis.visitor_company || null,
    contact_name: callAnalysis.visitor_name || null,
    contact_email: callAnalysis.visitor_email || null,
    contact_phone: null, // Chat widget doesn't capture phone
    job_title: callAnalysis.visitor_role || null,
    fleet_size: callAnalysis.fleet_size || null,
    vessel_types: callAnalysis.vessel_types || null,
    region: callAnalysis.route_profile || null, // route_profile maps to sailing region
    timeline: callAnalysis.timeline_drydock || null,
    decision_authority: null, // Inferred from role if available
    awareness_level: callAnalysis.primary_motivation || null,
    specific_interest: callAnalysis.topics_discussed || null,
    conversation_summary: callAnalysis.qualification_summary || callAnalysis.chat_summary || null,
    // Scoring: use extracted scores if available, otherwise estimate from data
    revenue_score: parseInt(callAnalysis.revenue_score) || estimateRevenueScore(callAnalysis),
    conversion_score: parseInt(callAnalysis.conversion_score) || estimateConversionScore(callAnalysis),
  };

  // Skip if no meaningful data extracted
  if (!lead.company_name && !lead.contact_name && !lead.contact_email) {
    return null;
  }

  return lead;
}

// Estimate revenue score (0-25) from extracted chat data when explicit score not available
function estimateRevenueScore(data) {
  let score = 0;
  // Fleet size scoring (0-10)
  const fleet = (data.fleet_size || "").toLowerCase();
  if (fleet.includes("50") || fleet.includes("100") || fleet.includes("large")) score += 10;
  else if (fleet.includes("20") || fleet.includes("30") || fleet.includes("medium")) score += 7;
  else if (fleet.includes("10") || fleet.includes("15")) score += 5;
  else if (fleet.includes("5") || fleet.includes("small")) score += 3;
  else if (fleet) score += 2;

  // Vessel type fit (0-8)
  const fit = (data.vessel_type_fit || "").toLowerCase();
  if (fit.includes("excellent") || fit.includes("ideal") || fit.includes("perfect")) score += 8;
  else if (fit.includes("good") || fit.includes("suitable")) score += 6;
  else if (fit.includes("moderate") || fit.includes("possible")) score += 4;
  else if (fit) score += 2;

  // Vessel size DWT (0-7)
  const dwt = parseInt(data.vessel_size_dwt) || 0;
  if (dwt >= 40000) score += 7;
  else if (dwt >= 20000) score += 5;
  else if (dwt >= 5000) score += 3;
  else if (dwt > 0) score += 1;

  return Math.min(score, 25);
}

// Estimate conversion score (0-18) from extracted chat data when explicit score not available
function estimateConversionScore(data) {
  let score = 0;
  // CII pressure / regulatory urgency (0-5)
  const cii = (data.cii_pressure || "").toLowerCase();
  if (cii.includes("high") || cii.includes("urgent") || cii.includes("critical")) score += 5;
  else if (cii.includes("medium") || cii.includes("moderate")) score += 3;
  else if (cii) score += 1;

  // Timeline (0-5)
  const timeline = (data.timeline_drydock || "").toLowerCase();
  if (timeline.includes("immediate") || timeline.includes("now") || timeline.includes("month")) score += 5;
  else if (timeline.includes("quarter") || timeline.includes("6 month") || timeline.includes("soon")) score += 4;
  else if (timeline.includes("year") || timeline.includes("2026") || timeline.includes("2027")) score += 2;
  else if (timeline) score += 1;

  // Meeting requested (0-4)
  const meeting = (data.meeting_requested || "").toLowerCase();
  if (meeting === "true" || meeting === "yes" || meeting.includes("yes")) score += 4;
  else if (meeting.includes("maybe") || meeting.includes("interested")) score += 2;

  // Chat successful (0-4)
  const successful = (data.chat_successful || data.Chat_Successful || "").toLowerCase();
  if (successful === "true" || successful === "yes" || successful.includes("yes")) score += 4;
  else if (successful.includes("partial")) score += 2;

  return Math.min(score, 18);
}

// Core lead processing: scoring, routing, DB storage, email notification
async function processEconowindLead(lead, receivedAt) {
  const priorityInfo = classifyPriority(lead.revenue_score, lead.conversion_score);
  const manager = routeToManager(lead.region);
  const totalScore = (parseInt(lead.revenue_score) || 0) + (parseInt(lead.conversion_score) || 0);

  console.log(`  [EW] Lead: ${lead.company_name || lead.contact_name} | ${priorityInfo.priority} (${priorityInfo.label}) | → ${manager.name} (${manager.email})`);

  // Store lead in database
  await pool.query(
    `INSERT INTO econowind_leads
      (company_name, contact_name, contact_email, contact_phone, job_title,
       fleet_size, vessel_types, region, timeline, decision_authority,
       awareness_level, specific_interest, conversation_summary,
       revenue_score, conversion_score, total_score, priority,
       assigned_manager, manager_email, received_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20)`,
    [
      lead.company_name, lead.contact_name, lead.contact_email, lead.contact_phone, lead.job_title,
      lead.fleet_size, lead.vessel_types, lead.region, lead.timeline, lead.decision_authority,
      lead.awareness_level, lead.specific_interest, lead.conversation_summary,
      parseInt(lead.revenue_score) || 0, parseInt(lead.conversion_score) || 0, totalScore,
      priorityInfo.priority, manager.name, manager.email, receivedAt,
    ]
  );
  console.log(`  [OK] Lead stored in econowind_leads.`);

  // Send email notification for P1, P2, P3 (skip P4)
  if (priorityInfo.priority === "P4") {
    console.log(`  [SKIP] P4 lead — no sales notification. Logged for monthly marketing review.`);
    return { priorityInfo, manager, notification: "skipped_p4" };
  }

  if (!RESEND_API_KEY) {
    console.warn(`  [WARN] Email not configured — cannot send ${priorityInfo.priority} notification.`);
    return { priorityInfo, manager, notification: "email_not_configured" };
  }

  const subject = `[${priorityInfo.priority} - ${priorityInfo.label}] New EconoWind Lead: ${lead.company_name || lead.contact_name}`;
  const html = buildLeadEmailHtml(lead, priorityInfo, manager);
  const textBody = `${priorityInfo.priority} - ${priorityInfo.label}\n\nNew EconoWind Lead: ${lead.company_name}\nContact: ${lead.contact_name} (${lead.contact_email})\nRegion: ${lead.region}\nScores: Revenue ${lead.revenue_score}/25, Conversion ${lead.conversion_score}/18\nSLA: ${priorityInfo.sla}\nAssigned to: ${manager.name}`;

  const recipients = [manager.email];
  if (priorityInfo.priority === "P1" && ECONOWIND_CC_P1) {
    recipients.push(ECONOWIND_CC_P1);
  }

  await sendEmail({ from: NOTIFY_FROM, to: recipients, subject, text: textBody, html });

  await pool.query(
    `UPDATE econowind_leads SET notification_sent = TRUE WHERE company_name = $1 AND received_at = $2`,
    [lead.company_name, receivedAt]
  );
  await pool.query(
    `INSERT INTO notifications (subject, body, priority, source, status) VALUES ($1, $2, $3, 'econowind_ventobot', 'sent')`,
    [subject, textBody, priorityInfo.priority]
  );

  console.log(`  [OK] ${priorityInfo.priority} notification sent to ${recipients.join(", ")}`);
  return { priorityInfo, manager, notification: "sent" };
}

// ─── EconoWind Lead Notification Endpoint (direct API) ──────────────────────
app.post("/webhooks/econowind", requireAuth, async (req, res) => {
  const receivedAt = new Date().toISOString();
  const lead = req.body;

  if (!lead.company_name && !lead.contact_name) {
    return res.status(400).json({ error: "Missing required fields: company_name or contact_name" });
  }

  const priorityInfo = classifyPriority(lead.revenue_score, lead.conversion_score);
  const manager = routeToManager(lead.region);

  res.json({
    received: true,
    priority: priorityInfo.priority,
    label: priorityInfo.label,
    sla: priorityInfo.sla,
    assigned_to: manager.name,
    assigned_email: manager.email,
    notification: priorityInfo.priority !== "P4" ? "sending" : "skipped_p4",
  });

  try {
    await processEconowindLead(lead, receivedAt);
  } catch (err) {
    console.error(`  [ERR] EconoWind lead processing failed:`, err.message);
    await pool.query(
      `INSERT INTO notifications (subject, body, priority, source, status, error)
       VALUES ($1, $2, $3, 'econowind_ventobot', 'failed', $4)`,
      [`Lead notification failed: ${lead.company_name}`, err.message, priorityInfo.priority, err.message]
    ).catch(() => {});
  }
});

// ─── Calendly Integration (live booking for Retell agents) ──────────────────
calendly.registerRoutes(app);

// ─── Interaction Scorer (call quality scoring for Paperclip agents) ─────────
scorer.registerRoutes(app, pool);

// ─── Odoo CRM Proxy (pipeline monitoring for Paperclip agents) ──────────────
odooProxy.registerRoutes(app, pool);

// ─── Zoho CRM → Aria Pipeline Endpoint ──────────────────────────────────────

app.post("/batch-call", requireAuth, async (req, res) => {
  const { prospects, agent, dry_run, scheduled_time } = req.body;
  if (!prospects || !Array.isArray(prospects) || prospects.length === 0) {
    return res.status(400).json({ error: "Missing or empty 'prospects' array" });
  }
  if (prospects.length > 500) {
    return res.status(400).json({ error: "Max 500 prospects per batch. Split into multiple batches." });
  }

  try {
    const result = await createBatchCall(prospects, {
      agent: agent || "aria_en",
      dry_run: dry_run !== false, // Default to dry_run=true for safety
      scheduled_time,
    });
    console.log(`Batch call ${result.dry_run ? "(dry run)" : "DISPATCHED"}: ${result.total_calls} calls via ${result.agent}`);
    res.json(result);
  } catch (err) {
    console.error("Batch call error:", err.message);
    res.status(500).json({ error: err.message });
  }
});

app.get("/batch-call/agents", (_req, res) => {
  res.json({
    agents: Object.entries(AGENTS).map(([key, val]) => ({
      key,
      label: val.label,
      agent_id: val.agent_id,
      from_number_configured: !!val.from_number,
    })),
  });
});

// ─── Zoho Flow → Aria Pipeline (triggered when Aria_Status changes) ─────────
app.post("/zoho/aria-trigger", requireAuth, async (req, res) => {
  const zohoLead = req.body;
  const ariaStatus = zohoLead.Aria_Status || zohoLead.aria_status;

  if (!ariaStatus) {
    return res.status(400).json({ error: "Missing Aria_Status field" });
  }

  // Map Zoho lead to prospect format
  const prospect = mapZohoLead(zohoLead);
  const agentKey = agentFromAriaStatus(ariaStatus);

  if (!agentKey) {
    return res.status(400).json({ error: `Cannot determine agent from Aria_Status: '${ariaStatus}'. Expected 'Ready for Aria EN' or 'Ready for Aria NL'.` });
  }

  // Validate phone number
  const errors = validateProspect(prospect, 1);
  if (errors.length > 0) {
    console.log(`[ZOHO] Lead ${prospect.zoho_lead_id} rejected: ${errors.join(", ")}`);
    return res.status(400).json({ error: "Validation failed", details: errors, zoho_lead_id: prospect.zoho_lead_id });
  }

  if (!prospect.zoho_lead_id) {
    console.warn(`[ZOHO] WARNING: zoho_lead_id is null — Zoho Flow webhook body may not include 'ID', 'id', or 'lead_id'. Received keys: ${Object.keys(zohoLead).join(", ")}`);
  }
  console.log(`→ [ZOHO] Aria trigger: ${prospect.contact_name} @ ${prospect.university_name} → ${agentKey} | specialist: ${prospect.specialist || "UNMAPPED"} | owner: ${prospect.lead_owner_name || "unknown"} (lead: ${prospect.zoho_lead_id})`);

  try {
    const result = await createBatchCall([prospect], {
      agent: agentKey,
      dry_run: false,
      name: `Zoho → Aria: ${prospect.university_name} (${prospect.zoho_lead_id})`,
    });

    // Log to database
    await pool.query(
      `INSERT INTO notifications (subject, body, priority, source, status)
       VALUES ($1, $2, 'normal', 'zoho_aria_trigger', 'sent')`,
      [`Aria call dispatched: ${prospect.university_name}`, JSON.stringify({ zoho_lead_id: prospect.zoho_lead_id, agent: agentKey, contact: prospect.contact_name })]
    );

    console.log(`  [OK] Call dispatched via ${result.agent} for ${prospect.contact_name}`);
    res.json({
      success: true,
      zoho_lead_id: prospect.zoho_lead_id,
      agent: agentKey,
      contact_name: prospect.contact_name,
      university: prospect.university_name,
      batch_call_id: result.batch_call_id,
    });
  } catch (err) {
    console.error(`  [ERR] Zoho Aria trigger failed:`, err.message);
    res.status(500).json({ error: err.message, zoho_lead_id: prospect.zoho_lead_id });
  }
});

// ─── Zoho CRM Status Callback (legacy — kept for backward compat) ───────────
// NOTE: Aria call results are now handled automatically in /webhooks/retell
// (see handleAriaCallEnded). This endpoint is kept for any direct API callers.
app.post("/zoho/aria-result", requireAuth, async (req, res) => {
  const { zoho_lead_id, call_id, status, transcript_summary } = req.body;
  console.log(`→ [ZOHO] Aria result (legacy endpoint): lead=${zoho_lead_id} call=${call_id} status=${status}`);

  await pool.query(
    `INSERT INTO notifications (subject, body, priority, source, status)
     VALUES ($1, $2, 'normal', 'zoho_aria_result', 'logged')`,
    [`Aria call result: ${status}`, JSON.stringify({ zoho_lead_id, call_id, status, transcript_summary })]
  ).catch(() => {});

  res.json({ received: true, zoho_lead_id, status });
});

// ─── EconoWind Leads query endpoint ─────────────────────────────────────────
app.get("/econowind/leads", async (req, res) => {
  try {
    const { priority, since, limit = 50 } = req.query;
    let query = "SELECT * FROM econowind_leads WHERE 1=1";
    const params = [];
    let paramIdx = 1;

    if (priority) {
      query += ` AND priority = $${paramIdx++}`;
      params.push(priority.toUpperCase());
    }
    if (since) {
      query += ` AND received_at >= $${paramIdx++}`;
      params.push(since);
    }
    query += ` ORDER BY received_at DESC LIMIT $${paramIdx}`;
    params.push(Math.min(parseInt(limit) || 50, 200));

    const result = await pool.query(query, params);
    res.json({ count: result.rows.length, leads: result.rows });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── Start ────────────────────────────────────────────────────────────────────
async function start() {
  try {
    await initDatabase();
    app.listen(PORT, "0.0.0.0", () => {
      console.log(`Retell Webhook Receiver v1.7.0 listening on port ${PORT}`);
      console.log(`   POST /webhooks/retell     - Retell webhook ingestion`);
      console.log(`   POST /webhooks/econowind  - EconoWind lead notification routing`);
      console.log(`   POST /notify              - Send email notification`);
      console.log(`   GET  /health              - Health check`);
      console.log(`   GET  /stats               - Event statistics`);
      console.log(`   GET  /events              - Query stored events`);
      console.log(`   GET  /notifications       - Notification history`);
      console.log(`   GET  /econowind/leads     - EconoWind lead history`);
      console.log(`   POST /batch-call          - Dispatch Retell batch calls`);
      console.log(`   GET  /batch-call/agents   - Available batch call agents`);
      console.log(`   POST /zoho/aria-trigger   - Zoho Flow → Aria call pipeline`);
      console.log(`   POST /zoho/aria-result    - Call result callback for Zoho`);
      console.log(`   GET  /calendly/availability - Calendly slot check (Retell custom fn)`);
      console.log(`   POST /calendly/book        - Calendly booking create (Retell custom fn)`);
      console.log(`   GET  /calendly/status       - Calendly integration health check`);
      console.log(`   GET  /scorer/rubric       - Interaction scoring rubric`);
      console.log(`   GET  /scorer/unscored     - Unscored calls for Interaction Scorer`);
      console.log(`   POST /scorer/score        - Submit interaction score`);
      console.log(`   GET  /scorer/scores       - Query scored interactions`);
      console.log(`   GET  /scorer/summary      - Aggregate scoring summary`);
      console.log(`\n   Expected agents:`);
      console.log(`   • Aria EN (Sendsteps):  agent_aa56b68b02f6de4ac5725a829b`);
      console.log(`   • Aria NL (Sendsteps):  agent_e1e1f763101db5abe0df281891`);
      console.log(`   • EconoWind Chat:       agent_760482429951f50e816c47b55a`);
      if (RETELL_WEBHOOK_SECRET) {
        console.log(`\n   [OK] Webhook signature verification ENABLED`);
      } else {
        console.log(`\n   [WARN] Webhook signature verification DISABLED (set RETELL_WEBHOOK_SECRET to enable)`);
      }
    });
  } catch (err) {
    console.error("Failed to start:", err);
    process.exit(1);
  }
}

start();
