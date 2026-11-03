// ─── Receiver schema ──────────────────────────────────────────────────────────
// Every table the receiver owns, in one place. Used at boot (index.js) and by
// scripts/migrate-client-db.mjs to create the same tables on the client-data
// database. All statements are idempotent (IF NOT EXISTS).
"use strict";

const scorer = require("./interaction-scorer");
const analyst = require("./intelligence-analyst");

// Tables the receiver owns, with their serial id column, in dependency-free
// order. interaction_scores and prompt_change_proposals get their indexes
// from their own modules; pipeline_snapshots is also created by odoo-proxy.
const TABLES = [
  { name: "retell_events", id: "id", order: "received_at" },
  { name: "notifications", id: "id", order: "sent_at" },
  { name: "bunker_prices", id: "id", order: "fetched_at" },
  { name: "econowind_leads", id: "id", order: "received_at" },
  { name: "interaction_scores", id: "id", order: "scored_at" },
  { name: "prompt_change_proposals", id: "id", order: "created_at" },
  { name: "pipeline_snapshots", id: "id", order: "created_at" },
];

const CORE_DDL = [
  `CREATE TABLE IF NOT EXISTS retell_events (
        id              SERIAL PRIMARY KEY,
        event_type      VARCHAR(64) NOT NULL,
        agent_id        VARCHAR(128),
        call_id         VARCHAR(128),
        transcript      TEXT,
        call_analysis   JSONB,
        full_payload    JSONB NOT NULL,
        received_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );`,
  `CREATE INDEX IF NOT EXISTS idx_retell_events_agent_id    ON retell_events (agent_id);`,
  `CREATE INDEX IF NOT EXISTS idx_retell_events_event_type  ON retell_events (event_type);`,
  `CREATE INDEX IF NOT EXISTS idx_retell_events_received_at ON retell_events (received_at);`,
  `CREATE INDEX IF NOT EXISTS idx_retell_events_call_id     ON retell_events (call_id);`,
  `CREATE TABLE IF NOT EXISTS notifications (
        id          SERIAL PRIMARY KEY,
        subject     VARCHAR(255) NOT NULL,
        body        TEXT,
        priority    VARCHAR(32) DEFAULT 'normal',
        source      VARCHAR(128),
        status      VARCHAR(32) NOT NULL DEFAULT 'sent',
        error       TEXT,
        sent_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );`,
  `CREATE TABLE IF NOT EXISTS bunker_prices (
        id          SERIAL PRIMARY KEY,
        fetched_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        port        VARCHAR(64) NOT NULL,
        grade       VARCHAR(32) NOT NULL,
        usd_per_mt  NUMERIC(8,2) NOT NULL,
        source      VARCHAR(64) NOT NULL,
        status      VARCHAR(16) DEFAULT 'ok'
      );`,
  `CREATE INDEX IF NOT EXISTS idx_bunker_prices_fetched
        ON bunker_prices (port, grade, fetched_at DESC);`,
  `CREATE TABLE IF NOT EXISTS econowind_leads (
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
      );`,
  `CREATE INDEX IF NOT EXISTS idx_econowind_leads_priority ON econowind_leads (priority);`,
  `CREATE INDEX IF NOT EXISTS idx_econowind_leads_received ON econowind_leads (received_at);`,
  `CREATE TABLE IF NOT EXISTS pipeline_snapshots (
        id SERIAL PRIMARY KEY,
        week_label TEXT NOT NULL,
        snapshot_data JSONB NOT NULL,
        opportunity_count INTEGER,
        total_revenue NUMERIC,
        created_at TIMESTAMPTZ DEFAULT NOW()
      )`,
];

// Creates every table and index on the database behind `pool`. Safe to run
// again. `log` receives one line per module, as before.
async function ensureSchema(pool, { log = console.log } = {}) {
  const client = await pool.connect();
  try {
    for (const sql of CORE_DDL) await client.query(sql);
  } finally {
    client.release();
  }
  log("Database table retell_events ready with indexes.");
  log("Database table notifications ready.");
  log("Database table bunker_prices ready.");
  log("Database table econowind_leads ready.");
  await scorer.initScorerTable(pool);
  await analyst.initAnalystTables(pool);
  log("Database table pipeline_snapshots ready.");
}

module.exports = { TABLES, CORE_DDL, ensureSchema };
