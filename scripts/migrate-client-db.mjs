#!/usr/bin/env node
// Migration of the receiver's tables to their own Postgres ("client-data").
// Run from a machine that can reach both databases (see
// docs/client-db-migration-runbook.md). Connection strings come from the
// environment and are never printed; passwords for the new logins come from
// the environment too.
//
//   SOURCE_DATABASE_URL        the shared Postgres (today's DATABASE_URL)
//   CLIENT_ADMIN_DATABASE_URL  the new Postgres, admin login from Railway
//   RECEIVER_APP_PASSWORD      password for the new login receiver_app
//   RECEIVER_RO_PASSWORD       password for the new login receiver_ro
//
//   node scripts/migrate-client-db.mjs roles     create receiver_app and receiver_ro (admin)
//   node scripts/migrate-client-db.mjs schema    create the tables as receiver_app
//   node scripts/migrate-client-db.mjs counts    row counts on both sides
//   node scripts/migrate-client-db.mjs copy      copy rows (resumable: only what is new)
//   node scripts/migrate-client-db.mjs verify    counts and max ids must match
//   node scripts/migrate-client-db.mjs prove     refused and allowed test queries per login
//   node scripts/migrate-client-db.mjs url       the receiver's CLIENT_DATABASE_URL, password masked
import { createRequire } from "node:module";
import { countTables, compareCounts, formatTable, copyTable, ROLE_SQL, runProof, maskUrl, urlForRole } from "./lib/migrate-lib.mjs";

const require = createRequire(import.meta.url);
const { Pool } = require("pg");
const { TABLES, ensureSchema } = require("../schema.js");

const ssl = process.env.DB_SSL === "false" ? false : { rejectUnauthorized: false };
const env = (name) => { const v = process.env[name]; if (!v) { console.error(`${name} is not set`); process.exit(2); } return v; };
const pool = (url) => new Pool({ connectionString: url, ssl, max: 2 });
const appUrl = () => urlForRole(env("CLIENT_ADMIN_DATABASE_URL"), "receiver_app", env("RECEIVER_APP_PASSWORD"));
const roUrl = () => urlForRole(env("CLIENT_ADMIN_DATABASE_URL"), "receiver_ro", env("RECEIVER_RO_PASSWORD"));

async function withPool(url, fn) { const p = pool(url); try { return await fn(p); } finally { await p.end(); } }

const cmd = process.argv[2];
try {
  if (cmd === "roles") {
    await withPool(env("CLIENT_ADMIN_DATABASE_URL"), async (admin) => {
      const db = new URL(env("CLIENT_ADMIN_DATABASE_URL")).pathname.replace(/^\//, "");
      for (const step of ROLE_SQL(env("RECEIVER_APP_PASSWORD"), env("RECEIVER_RO_PASSWORD"), db)) {
        try {
          if (step.exec) { const r = await admin.query(step.sql, step.params); await admin.query(r.rows[0].format); }
          else await admin.query(step.sql);
          console.log(`ok   ${step.label}`);
        } catch (err) {
          if (err.code === "42710") console.log(`skip ${step.label}: already exists`);
          else throw err;
        }
      }
    });
  } else if (cmd === "schema") {
    await withPool(appUrl(), async (app) => { await ensureSchema(app, { log: (l) => console.log(`  ${l}`) }); await app.query(`GRANT SELECT ON ALL TABLES IN SCHEMA public TO receiver_ro`); console.log("schema created as receiver_app; receiver_ro can read every table"); });
  } else if (cmd === "counts" || cmd === "verify") {
    const [s, t] = await Promise.all([withPool(env("SOURCE_DATABASE_URL"), (p) => countTables((q) => p.query(q), TABLES)), withPool(appUrl(), (p) => countTables((q) => p.query(q), TABLES))]);
    const { ok, rows } = compareCounts(s, t, TABLES);
    console.log(`source: ${maskUrl(env("SOURCE_DATABASE_URL"))}\ntarget: ${maskUrl(appUrl())}\n`);
    console.log(formatTable(rows));
    console.log(`\n${ok ? "MATCH: every table has the same row count and max id on both sides" : "DIFFERS: run copy, then verify again"}`);
    if (cmd === "verify" && !ok) process.exit(1);
  } else if (cmd === "copy") {
    await withPool(env("SOURCE_DATABASE_URL"), (src) => withPool(appUrl(), async (dst) => {
      for (const t of TABLES) {
        const r = await copyTable({ table: t, sourceQuery: (q, p) => src.query(q, p), targetQuery: (q, p) => dst.query(q, p), log: (l) => console.log(`  ${l}`) });
        console.log(`${t.name}: ${r.copied} new rows copied (target had up to id ${r.startedAt})`);
      }
    }));
  } else if (cmd === "prove") {
    const all = [];
    for (const [role, url] of [["receiver_ro", roUrl()], ["receiver_app", appUrl()]]) {
      all.push(...await withPool(url, (p) => runProof(role, (q) => p.query(q))));
    }
    console.log(formatTable(all.map(({ role, test, expected, outcome, pass }) => ({ role, test, expected, outcome, result: pass ? "PASS" : "FAIL" }))));
    const failed = all.filter((r) => !r.pass).length;
    console.log(`\n${failed === 0 ? "PROOF PASSED: every refused query was refused, every allowed one worked" : `PROOF FAILED: ${failed} unexpected outcome(s)`}`);
    if (failed) process.exit(1);
  } else if (cmd === "url") {
    console.log(`CLIENT_DATABASE_URL for the receiver (password masked; compose it with the receiver_app password from the password manager):\n${maskUrl(appUrl())}`);
  } else {
    console.error("usage: migrate-client-db.mjs roles|schema|counts|copy|verify|prove|url"); process.exit(2);
  }
} catch (err) {
  console.error(`${cmd} failed: ${err.message}`); process.exit(1);
}
