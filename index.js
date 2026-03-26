const express = require("express");
const crypto = require("crypto");
const { Pool } = require("pg");

const PORT = process.env.PORT || 3000;
const DATABASE_URL = process.env.DATABASE_URL;
const RETELL_WEBHOOK_SECRET = process.env.RETELL_WEBHOOK_SECRET || null;

if (!DATABASE_URL) {
  console.error("FATAL: DATABASE_URL environment variable is not set.");
  process.exit(1);
}

const pool = new Pool({
  connectionString: DATABASE_URL,
  ssl: process.env.DB_SSL === "false" ? false : { rejectUnauthorized: false },
  max: 5,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 5000,
});

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
    await client.query(`CREATE INDEX IF NOT EXISTS idx_retell_events_agent_id ON retell_events (agent_id);`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_retell_events_event_type ON retell_events (event_type);`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_retell_events_received_at ON retell_events (received_at);`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_retell_events_call_id ON retell_events (call_id);`);
    console.log("Database table retell_events ready with indexes.");
  } finally {
    client.release();
  }
}

function verifySignature(rawBody, signature) {
  if (!RETELL_WEBHOOK_SECRET) return true;
  if (!signature) {
    console.warn("No x-retell-signature header present, skipping verification.");
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

const app = express();

app.use(
  express.json({
    limit: "5mb",
    verify: (req, _res, buf) => {
      req.rawBody = buf.toString("utf-8");
    },
  })
);

app.get("/", (_req, res) => {
  res.json({
    service: "retell-webhook-receiver",
    status: "ok",
    version: "1.0.0",
    description: "Scala Auxilium - Retell AI webhook ingestion for Paperclip monitoring agents",
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

app.post("/webhooks/retell", async (req, res) => {
  const receivedAt = new Date().toISOString();
  res.status(200).json({ received: true });

  try {
    const payload = req.body;

    if (RETELL_WEBHOOK_SECRET) {
      const signature = req.headers["x-retell-signature"];
      if (!verifySignature(req.rawBody, signature)) {
        console.error("[" + receivedAt + "] INVALID SIGNATURE - event dropped.");
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
      "[" + receivedAt + "] " + eventType + " | agent: " + agentLabel + " | call: " + (callId || "n/a") + " | transcript: " +
        (transcript ? transcript.length + " chars" : "none")
    );

    await pool.query(
      `INSERT INTO retell_events (event_type, agent_id, call_id, transcript, call_analysis, full_payload, received_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [eventType, agentId, callId, transcript, callAnalysis ? JSON.stringify(callAnalysis) : null, JSON.stringify(payload), receivedAt]
    );

    console.log("  Stored in retell_events.");
  } catch (err) {
    console.error("  DB write failed:", err.message);
    console.error("  Payload that failed:", JSON.stringify(req.body).substring(0, 500));
  }
});

app.get("/stats", async (_req, res) => {
  try {
    const result = await pool.query(`
      SELECT event_type, agent_id, COUNT(*) as count,
        MIN(received_at) as earliest, MAX(received_at) as latest
      FROM retell_events GROUP BY event_type, agent_id ORDER BY latest DESC
    `);
    res.json({ total_events: result.rows.reduce((s, r) => s + parseInt(r.count), 0), breakdown: result.rows });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get("/events", async (req, res) => {
  try {
    const { agent_id, event_type, since, limit = 100 } = req.query;
    let query = "SELECT * FROM retell_events WHERE 1=1";
    const params = [];
    let paramIdx = 1;
    if (agent_id) { query += " AND agent_id = $" + paramIdx++; params.push(agent_id); }
    if (event_type) { query += " AND event_type = $" + paramIdx++; params.push(event_type); }
    if (since) { query += " AND received_at >= $" + paramIdx++; params.push(since); }
    query += " ORDER BY received_at DESC LIMIT $" + paramIdx;
    params.push(Math.min(parseInt(limit) || 100, 500));
    const result = await pool.query(query, params);
    res.json({ count: result.rows.length, events: result.rows });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

async function start() {
  try {
    await initDatabase();
    app.listen(PORT, "0.0.0.0", () => {
      console.log("Retell Webhook Receiver listening on port " + PORT);
      console.log("  POST /webhooks/retell  - Retell webhook ingestion");
      console.log("  GET  /health           - Health check");
      console.log("  GET  /stats            - Event statistics");
      console.log("  GET  /events           - Query stored events");
      if (RETELL_WEBHOOK_SECRET) {
        console.log("  Webhook signature verification ENABLED");
      } else {
        console.log("  Webhook signature verification DISABLED (set RETELL_WEBHOOK_SECRET to enable)");
      }
    });
  } catch (err) {
    console.error("Failed to start:", err);
    process.exit(1);
  }
}

start();
