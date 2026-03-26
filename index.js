const express = require("express");
const crypto = require("crypto");
const { Pool } = require("pg");
const nodemailer = require("nodemailer");

// --- Config -----------------------------------------------------------------
const PORT = process.env.PORT || 3000;
const DATABASE_URL = process.env.DATABASE_URL;
const RETELL_WEBHOOK_SECRET = process.env.RETELL_WEBHOOK_SECRET || null;

// --- Email Config ----------------------------------------------------------
const SMTP_HOST = process.env.SMTP_HOST || "smtp.gmail.com";
const SMTP_PORT = parseInt(process.env.SMTP_PORT) || 587;
const SMTP_USER = process.env.SMTP_USER || null;
const SMTP_PASS = process.env.SMTP_PASS || null;
const NOTIFY_TO = process.env.NOTIFY_TO || SMTP_USER;
const NOTIFY_SECRET = process.env.NOTIFY_SECRET || null;

if (!DATABASE_URL) {
  console.error("FATAL: DATABASE_URL environment variable is not set.");
  process.exit(1);
}

// --- PostgreSQL ------------------------------------------------------------
const pool = new Pool({
  connectionString: DATABASE_URL,
  ssl: process.env.DB_SSL === "false" ? false : { rejectUnauthorized: false },
  max: 5,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 5000,
});

// --- Table creation on startup ---------------------------------------------
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

// --- Email transporter -----------------------------------------------------
let transporter = null;
if (SMTP_USER && SMTP_PASS) {
  transporter = nodemailer.createTransport({
    host: SMTP_HOST,
    port: SMTP_PORT,
    secure: SMTP_PORT === 465,
    auth: { user: SMTP_USER, pass: SMTP_PASS },
  });
  console.log("Email transporter configured (" + SMTP_HOST + ":" + SMTP_PORT + ")");
} else {
  console.log("Email not configured (set SMTP_USER and SMTP_PASS to enable)");
}

// --- Webhook signature verification (optional) ----------------------------
function verifySignature(rawBody, signature) {
  if (!RETELL_WEBHOOK_SECRET) return true;
  if (!signature) {
    console.warn("[WARN] No x-retell-signature header present -- skipping verification.");
    return true;
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

// --- Express app -----------------------------------------------------------
const app = express();

app.use(
  express.json({
    limit: "5mb",
    verify: (req, _res, buf) => {
      req.rawBody = buf.toString("utf-8");
    },
  })
);

// --- Health check ----------------------------------------------------------
app.get("/", (_req, res) => {
  res.json({
    service: "retell-webhook-receiver",
    status: "ok",
    version: "1.0.0",
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

// --- Main webhook endpoint -------------------------------------------------
app.post("/webhooks/retell", async (req, res) => {
  const receivedAt = new Date().toISOString();
  res.status(200).json({ received: true });

  try {
    const payload = req.body;

    if (RETELL_WEBHOOK_SECRET) {
      const signature = req.headers["x-retell-signature"];
      if (!verifySignature(req.rawBody, signature)) {
        console.error("[ERR] [" + receivedAt + "] INVALID SIGNATURE -- event dropped.");
        return;
      }
    }

    const eventType = payload.event || "unknown";
    const callData = payload.call || {};
    const agentId = callData.agent_id || null;
    const callId = callData.call_id || null;
    const transcript = callData.transcript || null;
    const callAnalysis = callData.call_analysis || null;

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

    await pool.query(
      `INSERT INTO retell_events (event_type, agent_id, call_id, transcript, call_analysis, full_payload, received_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [eventType, agentId, callId, transcript, callAnalysis ? JSON.stringify(callAnalysis) : null, JSON.stringify(payload), receivedAt]
    );

    console.log("  [OK] Stored in retell_events.");
  } catch (err) {
    console.error("  [ERR] DB write failed:", err.message);
    console.error("  [ERR] Payload that failed to store:", JSON.stringify(req.body).substring(0, 500));
  }
});

// --- Email notification endpoint (for Paperclip agents) -------------------
app.post("/notify", async (req, res) => {
  if (NOTIFY_SECRET) {
    const auth = req.headers["x-notify-secret"] || req.body.secret;
    if (auth !== NOTIFY_SECRET) {
      return res.status(401).json({ error: "Invalid or missing secret" });
    }
  }

  if (!transporter) {
    return res.status(503).json({ error: "Email not configured. Set SMTP_USER and SMTP_PASS." });
  }

  const { subject, body, html, priority, source } = req.body;
  if (!subject) {
    return res.status(400).json({ error: "Missing required field: subject" });
  }

  const prefixes = { critical: "CRITICAL", high: "ALERT", normal: "", low: "FYI" };
  const prefix = prefixes[priority] || "";
  const fullSubject = prefix ? "[" + prefix + "] " + subject : subject;

  try {
    await transporter.sendMail({
      from: '"Scala Auxilium Agents" <' + SMTP_USER + '>',
      to: NOTIFY_TO,
      subject: fullSubject,
      text: body || subject,
      html: html || undefined,
    });

    await pool.query(
      `INSERT INTO notifications (subject, body, priority, source, status) VALUES ($1, $2, $3, $4, 'sent')`,
      [fullSubject, body || subject, priority || "normal", source || "unknown"]
    );

    console.log('Email sent: "' + fullSubject + '" from ' + (source || "unknown"));
    res.json({ sent: true, subject: fullSubject });
  } catch (err) {
    await pool.query(
      `INSERT INTO notifications (subject, body, priority, source, status, error) VALUES ($1, $2, $3, $4, 'failed', $5)`,
      [fullSubject, body || subject, priority || "normal", source || "unknown", err.message]
    ).catch(() => {});

    console.error("Email send failed:", err.message);
    res.status(500).json({ error: "Failed to send email", details: err.message });
  }
});

// --- Notification history endpoint ----------------------------------------
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

// --- Stats endpoint --------------------------------------------------------
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

// --- Events query endpoint -------------------------------------------------
app.get("/events", async (req, res) => {
  try {
    const { agent_id, event_type, since, limit = 100 } = req.query;
    let query = "SELECT * FROM retell_events WHERE 1=1";
    const params = [];
    let paramIdx = 1;

    if (agent_id) {
      query += " AND agent_id = $" + paramIdx++;
      params.push(agent_id);
    }
    if (event_type) {
      query += " AND event_type = $" + paramIdx++;
      params.push(event_type);
    }
    if (since) {
      query += " AND received_at >= $" + paramIdx++;
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

// --- Start -----------------------------------------------------------------
async function start() {
  try {
    await initDatabase();
    app.listen(PORT, "0.0.0.0", () => {
      console.log("Retell Webhook Receiver listening on port " + PORT);
      console.log("   POST /webhooks/retell  - Retell webhook ingestion");
      console.log("   POST /notify           - Send email notification");
      console.log("   GET  /health           - Health check");
      console.log("   GET  /stats            - Event statistics");
      console.log("   GET  /events           - Query stored events");
      console.log("   GET  /rotifications    - Notification history");
      console.log("");
      console.log("   Expected agents:");
      console.log("   - Aria EN (Sendsteps):  agent_aa56b68b02f6de4ac5725a829b");
      console.log("   - Aria NL (Sendsteps):  agent_e1e1f763101db5abe0df281891");
      console.log("   - EconoWind Chat:       agent_760482429951f50e816c47b55a");
      if (RETELL_WEBHOOK_SECRET) {
        console.log("");
        console.log("   [OK] Webhook signature verification ENABLED");
      } else {
        console.log("");
        console.log("   [WARN] Webhook signature verification DISABLED (set RETELL_WEBHOOK_SECRET to enable)");
      }
    });
  } catch (err) {
    console.error("Failed to start:", err);
    process.exit(1);
  }
}

start();
