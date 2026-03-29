const express = require("express");
const crypto = require("crypto");
const { Pool } = require("pg");
const tidycal = require("./tidycal");
const scorer = require("./interaction-scorer");
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
    version: "1.5.0",
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

// ─── EconoWind Lead Notification Endpoint ───────────────────────────────────
app.post("/webhooks/econowind", requireAuth, async (req, res) => {
  const receivedAt = new Date().toISOString();
  const lead = req.body;

  // Validate minimum required fields
  if (!lead.company_name && !lead.contact_name) {
    return res.status(400).json({ error: "Missing required fields: company_name or contact_name" });
  }

  // Classify priority
  const priorityInfo = classifyPriority(lead.revenue_score, lead.conversion_score);
  const manager = routeToManager(lead.region);
  const totalScore = (parseInt(lead.revenue_score) || 0) + (parseInt(lead.conversion_score) || 0);

  console.log(`→ [${receivedAt}] EconoWind lead: ${lead.company_name} | ${priorityInfo.priority} (${priorityInfo.label}) | → ${manager.name} (${manager.email})`);

  // Return immediately with routing result
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
      return;
    }

    if (!RESEND_API_KEY) {
      console.warn(`  [WARN] Email not configured — cannot send ${priorityInfo.priority} notification.`);
      return;
    }

    const subject = `[${priorityInfo.priority} - ${priorityInfo.label}] New EconoWind Lead: ${lead.company_name || lead.contact_name}`;
    const html = buildLeadEmailHtml(lead, priorityInfo, manager);
    const textBody = `${priorityInfo.priority} - ${priorityInfo.label}\n\nNew EconoWind Lead: ${lead.company_name}\nContact: ${lead.contact_name} (${lead.contact_email})\nRegion: ${lead.region}\nScores: Revenue ${lead.revenue_score}/25, Conversion ${lead.conversion_score}/18\nSLA: ${priorityInfo.sla}\nAssigned to: ${manager.name}`;

    // Build recipient list: sales manager + CC Piet on P1
    const recipients = [manager.email];
    if (priorityInfo.priority === "P1" && ECONOWIND_CC_P1) {
      recipients.push(ECONOWIND_CC_P1);
    }

    await sendEmail({
      from: NOTIFY_FROM,
      to: recipients,
      subject,
      text: textBody,
      html,
    });

    // Update lead as notified
    await pool.query(
      `UPDATE econowind_leads SET notification_sent = TRUE WHERE company_name = $1 AND received_at = $2`,
      [lead.company_name, receivedAt]
    );

    // Log notification
    await pool.query(
      `INSERT INTO notifications (subject, body, priority, source, status) VALUES ($1, $2, $3, 'econowind_ventobot', 'sent')`,
      [subject, textBody, priorityInfo.priority]
    );

    console.log(`  [OK] ${priorityInfo.priority} notification sent to ${recipients.join(", ")}`);
  } catch (err) {
    console.error(`  [ERR] EconoWind lead processing failed:`, err.message);
    // Log failure
    await pool.query(
      `INSERT INTO notifications (subject, body, priority, source, status, error)
       VALUES ($1, $2, $3, 'econowind_ventobot', 'failed', $4)`,
      [`Lead notification failed: ${lead.company_name}`, err.message, priorityInfo.priority, err.message]
    ).catch(() => {});
  }
});

// ─── TidyCal Integration (live booking for Retell agents) ───────────────────
tidycal.registerRoutes(app);

// ─── Interaction Scorer (call quality scoring for Paperclip agents) ─────────
scorer.registerRoutes(app, pool);

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
    console.warn(`[ZOHO] WARNING: zoho_lead_id is null — Zoho Flow webhook body may not include 'id' or 'lead_id'. Received keys: ${Object.keys(zohoLead).join(", ")}`);
  }
  console.log(`→ [ZOHO] Aria trigger: ${prospect.contact_name} @ ${prospect.university_name} → ${agentKey} (lead: ${prospect.zoho_lead_id})`);

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

// ─── Zoho CRM Status Callback (update lead after call completes) ────────────
app.post("/zoho/aria-result", requireAuth, async (req, res) => {
  // This endpoint receives call results and can be used to update Zoho CRM via API
  // For now, it logs the result. Phase 2 (May) will use Zoho CRM API to update the lead.

  const { zoho_lead_id, call_id, status, transcript_summary } = req.body;
  console.log(`→ [ZOHO] Aria result: lead=${zoho_lead_id} call=${call_id} status=${status}`);

  // Log for now — Phase 2 will push back to Zoho CRM API
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
      console.log(`Retell Webhook Receiver v1.5.0 listening on port ${PORT}`);
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
      console.log(`   GET  /tidycal/availability - TidyCal slot check (Retell custom fn)`);
      console.log(`   POST /tidycal/book        - TidyCal booking create (Retell custom fn)`);
      console.log(`   GET  /tidycal/status       - TidyCal integration health check`);
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
