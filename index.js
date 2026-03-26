const express = require("express");
const crypto = require("crypto");
const { Pool } = require("pg");

// --- Config -----------------------------------------------------------------
const PORT = process.env.PORT || 3000;
const DATABASE_URL = process.env.DATABASE_URL;
const RETELL_WEBHOOK_SECRET = process.env.RETELL_WEBHOOK_SECRET || null;

// --- Email Config (Resend HTTP API) -----------------------------------------
const RESEND_API_KEY = process.env.RESEND_API_KEY || null;
const NOTIFY_FROM = process.env.NOTIFY_FROM || "onboarding@resend.dev";
const NOTIFY_TO = process.env.NOTIFY_TO || null;
const NOTIFY_SECRET = process.env.NOTIFY_SECRET || null;

if (!DATABASE_URL) {
  console.error("FATAL: DATABASE_URL environment variable is not set.");
  process.exit(1);
}

// --- PostgreSQL --------------------------------------------------------------
const pool = new Pool({
  connectionString: DATABASE_URL,
  ssl: process.env.DB_SSL === "false" ? false : { rejectUnauthorized: false },
  max: 5,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 5000,
});

// --- Table creation on startup -----------------------------------------------
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
  } finally {
    client.release();
  }
}

// --- Email via Resend HTTP API -----------------------------------------------
async function sendEmail({ from, to, subject, text, html }) {
  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      "Authorization": "Bearer " + RESEND_API_KEY,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ from, to: [to], subject, text, html: html || undefined }),
  });
  const data = await res.json();
  if (!res.ok) {
    throw new Error(data.message || JSON.stringify(data));
  }
  return data;
}

if (RESEND_API_KEY) {
  console.log("Email configured via Resend API (from: " + NOTIFY_FROM + ")");
} else {
  console.log("Email not configured (set RESEND_API_KEY to enable)");
}
// --- Webhook signature verification (optional) ------------------------------
function verifySignature(rawBody, signature) {
  if (!RETELL_WEBHOOK_SECRET) return true; // skip if no secret configured
  if (!signature) {
    console.warn("[WARN] No x-retell-signature header present -- skipping verification.");
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

// --- Express app -------------------------------------------------------------
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

// --- Health check ------------------------------------------------------------
app.get("/", (_req, res) => {
  res.json({
    service: "retell-webhook-receiver",
    status: "ok",
    version: "1.1.0",
    description: "Scala Auxilium -- Retell AI webhook ingestion for Paperclip monitoring agents",
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

// --- Main webhook endpoint ---------------------------------------------------
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
        console.error("[ERR] [" + receivedAt + "] INVALID SIGNATURE -- event dropped.");
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
      "-> [" + receivedAt + "] " + eventType + " | agent: " + agentLabel + " | call: " + (callId || "n/a") + " | transcript: " +
        (transcript ? transcript.length + " chars" : "none")
    );

    // Write to PostgreSQL
    await pool.query(
      "INSERT INTO retell_events (event_type, agent_id, call_id, transcript, call_analysis, full_payload, received_at) VALUES ($1, $2, $3, $4, $5, $6, $7)",
      [eventType, agentId, callId, transcript, callAnalysis ? JSON.stringify(callAnalysis) : null, JSON.stringify(payload), receivedAt]
    );

    console.log("  [OK] Stored in retell_events.");
  } catch (err) {
    console.error("  [ERR] DB write failed:", err.message);
    console.error("  [ERR] Payload that failed to store:", JSON.stringify(req.body).substring(0, 500));
  }
});
// --- Email notification endpoint (for Paperclip agents) ---------------------
app.post("/notify", async (req, res) => {
  // Auth check
  if (NOTIFY_SECRET) {
    const auth = req.headers["x-notify-secret"] || req.body.secret;
    if (auth !== NOTIFY_SECRET) {
      return res.status(401).json({ error: "Invalid or missing secret" });
    }
  }

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
  const fullSubject = prefix ? "[" + prefix + "] " + subject : subject;

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
      "INSERT INTO notifications (subject, body, priority, source, status) VALUES ($1, $2, $3, $4, 'sent')",
      [fullSubject, body || subject, priority || "normal", source || "unknown"]
    );

    console.log("Email sent: \"" + fullSubject + "\" from " + (source || "unknown"));
    res.json({ sent: true, subject: fullSubject });
  } catch (err) {
    // Log failure
    await pool.query(
      "INSERT INTO notifications (subject, body, priority, source, status, error) VALUES ($1, $2, $3, $4, 'failed', $5)",
      [fullSubject, body || subject, priority || "normal", source || "unknown", err.message]
    ).catch(function() {});

    console.error("Email send failed:", err.message);
    res.status(500).json({ error: "Failed to send email", details: err.message });
  }
});

// --- Notification history endpoint ------------------------------------------
app.get("/notifications", async (req, res) => {
  try {
    const { limit = 50 } = req.query;
    const result = await pool.query(
      "SELECT * FROM notifications ORDER BY sent_at DESC LIMIT $1",
      [Math.min(parseInt(limit) || 50, 200)]
    );
    res.json({ count: result.rows.length, notifications: result.rows });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// --- Stats endpoint (useful for Paperclip agents) ---------------------------
app.get("/stats", async (_req, res) => {
  try {
    const result = await pool.query(
      "SELECT event_type, agent_id, COUNT(*) as count, MIN(received_at) as earliest, MAX(received_at) as latest FROM retell_events GROUP BY event_type, agent_id ORDER BY latest DESC"
    );
    res.json({ total_events: result.rows.reduce(function(s, r) { return s + parseInt(r.count); }, 0), breakdown: result.rows });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// --- Events query endpoint (for Paperclip agents to pull recent events) -----
app.get("/events", async (req, res) => {
  try {
    const { agent_id, event_type, since, limit = 100 } = req.query;
    var query = "SELECT * FROM retell_events WHERE 1=1";
    const params = [];
    var paramIdx = 1;

    if (agent_id) {
      query += " AND agent_id = $" + (paramIdx++);
      params.push(agent_id);
    }
    if (event_type) {
      query += " AND event_type = $" + (paramIdx++);
      params.push(event_type);
    }
    if (since) {
      query += " AND received_at >= $" + (paramIdx++);
      params.push(since);
    }

    query += " ORDER BY received_at DESC LIMIT $" + paramIdx;
    params.push(Math.min(parseInt(limit) || 100, 500));

    const result = await pool.query(query, params);
    res.json({ count: result.rows.length, events: result.rows });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// --- Start -------------------------------------------------------------------
async function start() {
  try {
    await initDatabase();
    app.listen(PORT, "0.0.0.0", function() {
      console.log("Retell Webhook Receiver listening on port " + PORT);
    });
  } catch (err) {
    console.error("Failed to start:", err);
    process.exit(1);
  }
}

start();
