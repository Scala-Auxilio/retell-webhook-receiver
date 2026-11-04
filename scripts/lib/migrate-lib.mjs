// Pure building blocks for scripts/migrate-client-db.mjs. Everything here takes
// query functions as arguments so it can be tested without a database.
// Nothing in this file ever prints a connection string.

export const STEPS = ["roles", "schema", "counts", "copy", "verify", "prove", "url", "rotate-postgres-password", "idle"];

// Steps come from the command line, or from MIGRATION_STEP when the script
// runs as a temporary Railway service (comma-separated, run in order).
export function parseSteps(argv, env = {}) {
  const raw = argv[0] ?? env.MIGRATION_STEP ?? "";
  const steps = raw.split(",").map((s) => s.trim()).filter(Boolean);
  if (steps.length === 0) return { error: "no step given: pass one on the command line or set MIGRATION_STEP" };
  const bad = steps.filter((s) => !STEPS.includes(s));
  if (bad.length) return { error: `unknown step(s): ${bad.join(", ")}; valid: ${STEPS.join(", ")}` };
  return { steps };
}

// Short fingerprint of a secret: first 8 hex characters of its SHA-256.
// Enough to tell two values apart in a log, useless for recovering the value.
import { createHash } from "node:crypto";
export function fingerprint(value) {
  return createHash("sha256").update(String(value ?? ""), "utf8").digest("hex").slice(0, 8);
}

// The password inside a connection string, decoded. Null when absent.
export function passwordFromUrl(raw) {
  try { const u = new URL(raw); return u.password ? decodeURIComponent(u.password) : null; } catch { return null; }
}

export function maskUrl(raw) {
  try {
    const u = new URL(raw);
    const user = u.username ? `${u.username}:***@` : "";
    return `${u.protocol}//${user}${u.hostname}${u.port ? ":" + u.port : ""}${u.pathname}`;
  } catch { return "(invalid url)"; }
}

// Replaces the credentials in an admin URL with a role's, keeping host, port and database.
export function urlForRole(adminUrl, role, password) {
  const u = new URL(adminUrl);
  u.username = role;
  u.password = password;
  return u.toString();
}

// Row counts for every table on one side. `query(sql) -> {rows}`.
export async function countTables(query, tables) {
  const out = {};
  for (const t of tables) {
    try {
      const r = await query(`SELECT COUNT(*)::bigint AS n, COALESCE(MAX(${t.id}), 0)::bigint AS max_id FROM ${t.name}`);
      out[t.name] = { count: Number(r.rows[0].n), maxId: Number(r.rows[0].max_id) };
    } catch (err) {
      out[t.name] = { count: null, maxId: null, error: err.code || err.message };
    }
  }
  return out;
}

export function compareCounts(source, target, tables) {
  const rows = [];
  let ok = true;
  for (const t of tables) {
    const s = source[t.name], d = target[t.name];
    const same = s && d && s.count !== null && s.count === d.count && s.maxId === d.maxId;
    if (!same) ok = false;
    rows.push({ table: t.name, source: s?.count ?? "missing", target: d?.count ?? "missing", sourceMaxId: s?.maxId ?? "-", targetMaxId: d?.maxId ?? "-", status: same ? "match" : "DIFFERS" });
  }
  return { ok, rows };
}

export function formatTable(rows) {
  const cols = Object.keys(rows[0] ?? {});
  const width = Object.fromEntries(cols.map((c) => [c, Math.max(c.length, ...rows.map((r) => String(r[c]).length))]));
  const line = (r) => cols.map((c) => String(r[c]).padEnd(width[c])).join("  ");
  return [line(Object.fromEntries(cols.map((c) => [c, c]))), ...rows.map(line)].join("\n");
}

// Column names shared by both sides, in the source's order.
export async function sharedColumns(sourceQuery, targetQuery, table) {
  const q = (query) => query(`SELECT column_name FROM information_schema.columns WHERE table_schema = 'public' AND table_name = $1 ORDER BY ordinal_position`, [table]);
  const s = (await q(sourceQuery)).rows.map((r) => r.column_name);
  const t = new Set((await q(targetQuery)).rows.map((r) => r.column_name));
  return s.filter((c) => t.has(c));
}

// Copies rows with id > the target's current max id, in batches, preserving
// ids, then sets the sequence. Resumable: running it again copies only what
// is new on the source. `targetQuery` must run inside the target connection.
export async function copyTable({ table, sourceQuery, targetQuery, batchSize = 1000, log = () => {} }) {
  const cols = await sharedColumns(sourceQuery, targetQuery, table.name);
  if (cols.length === 0) throw new Error(`${table.name}: no shared columns; create the schema on the target first`);
  const quoted = cols.map((c) => `"${c}"`).join(", ");
  const start = Number((await targetQuery(`SELECT COALESCE(MAX(${table.id}), 0)::bigint AS m FROM ${table.name}`)).rows[0].m);
  let last = start, copied = 0;
  for (;;) {
    const batch = await sourceQuery(`SELECT ${quoted} FROM ${table.name} WHERE ${table.id} > $1 ORDER BY ${table.id} ASC LIMIT $2`, [last, batchSize]);
    if (batch.rows.length === 0) break;
    const values = [], params = [];
    for (const row of batch.rows) {
      const ph = cols.map((c) => { params.push(row[c]); return `$${params.length}`; });
      values.push(`(${ph.join(", ")})`);
    }
    await targetQuery(`INSERT INTO ${table.name} (${quoted}) VALUES ${values.join(", ")} ON CONFLICT (${table.id}) DO NOTHING`, params);
    copied += batch.rows.length;
    last = Number(batch.rows[batch.rows.length - 1][table.id]);
    log(`${table.name}: copied ${copied} rows (up to id ${last})`);
  }
  await targetQuery(`SELECT setval(pg_get_serial_sequence('${table.name}', '${table.id}'), (SELECT COALESCE(MAX(${table.id}), 1) FROM ${table.name}), true)`);
  return { table: table.name, startedAt: start, copied, lastId: last };
}

// Roles on the client-data database. Passwords are bound as parameters of
// a format() call, never interpolated into the printed SQL. The receiver
// login owns the receiver tables (it runs CREATE TABLE IF NOT EXISTS and
// ALTER TABLE ... ADD COLUMN IF NOT EXISTS at boot, which need ownership);
// the read-only login may only SELECT, now and on tables created later.
export const ROLE_SQL = (appPassword, roPassword, dbName) => [
  { sql: `SELECT format('CREATE ROLE receiver_app LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT PASSWORD %L', $1::text)`, params: [appPassword], exec: true, label: "create role receiver_app" },
  { sql: `SELECT format('CREATE ROLE receiver_ro LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT PASSWORD %L', $1::text)`, params: [roPassword], exec: true, label: "create role receiver_ro" },
  { sql: `GRANT CONNECT ON DATABASE "${dbName}" TO receiver_app, receiver_ro`, label: "connect" },
  { sql: `GRANT USAGE, CREATE ON SCHEMA public TO receiver_app`, label: "schema for receiver_app" },
  { sql: `GRANT USAGE ON SCHEMA public TO receiver_ro`, label: "schema for receiver_ro" },
  { sql: `ALTER DEFAULT PRIVILEGES FOR ROLE receiver_app IN SCHEMA public GRANT SELECT ON TABLES TO receiver_ro`, label: "future tables readable by receiver_ro" },
];

// Queries that must be REFUSED, per role, and one that must work.
export const PROOF = {
  receiver_ro: {
    mustWork: [{ label: "select", sql: "SELECT COUNT(*) FROM retell_events" }],
    mustFail: [
      { label: "insert", sql: "INSERT INTO notifications (subject) VALUES ('proof-run must be refused')" },
      { label: "update", sql: "UPDATE notifications SET subject = subject WHERE false" },
      { label: "delete", sql: "DELETE FROM notifications WHERE false" },
      { label: "create table", sql: "CREATE TABLE proof_should_fail (id int)" },
      { label: "drop table", sql: "DROP TABLE retell_events" },
    ],
  },
  receiver_app: {
    mustWork: [{ label: "select", sql: "SELECT COUNT(*) FROM retell_events" }, { label: "insert+rollback", sql: "BEGIN; INSERT INTO notifications (subject, source, status) VALUES ('proof-run', 'migration-proof', 'sent'); ROLLBACK" }],
    mustFail: [
      { label: "create role", sql: "CREATE ROLE proof_should_fail" },
      { label: "create database", sql: "CREATE DATABASE proof_should_fail" },
      { label: "alter system", sql: "ALTER SYSTEM SET work_mem = '4MB'" },
      { label: "copy to server file", sql: "COPY retell_events TO '/tmp/proof_should_fail'" },
    ],
  },
};

export async function runProof(role, query) {
  const results = [];
  for (const q of PROOF[role].mustWork) {
    try { await query(q.sql); results.push({ role, test: q.label, expected: "allowed", outcome: "allowed", pass: true }); }
    catch (err) { results.push({ role, test: q.label, expected: "allowed", outcome: `refused (${err.code || err.message})`, pass: false }); }
  }
  for (const q of PROOF[role].mustFail) {
    try { await query(q.sql); results.push({ role, test: q.label, expected: "refused", outcome: "ALLOWED", pass: false }); }
    catch (err) { results.push({ role, test: q.label, expected: "refused", outcome: `refused (${err.code || "error"})`, pass: true }); }
  }
  return results;
}

// ── Password rotation of the connected role (workstream E) ───────────────────
// The Railway Postgres template reads POSTGRES_PASSWORD only when the data
// directory is first created, so a rotation changes the role with SQL and the
// variables separately. The new value is a format() parameter, never part of
// the printed SQL. The role is whatever the connection string logs in as.
export function validateNewPassword(value) {
  if (typeof value !== "string" || value.length < 24) return "must be at least 24 characters";
  if (!/^[A-Za-z0-9]+$/.test(value)) return "must be letters and digits only (it travels inside connection strings)";
  return null;
}

export const ROTATE_SQL = (newPassword) => [
  { sql: `SELECT format('ALTER ROLE %I WITH PASSWORD %L', current_user, $1::text)`, params: [newPassword], exec: true, label: "alter role password" },
];

// The same connection string with another password.
export function urlWithPassword(raw, password) {
  const u = new URL(raw);
  u.password = password;
  return u.toString();
}
