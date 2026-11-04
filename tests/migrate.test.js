// Migration building blocks against fake query functions. No database, no
// network, no real connection strings or passwords.
"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

test("schema.js lists every receiver table and its DDL is what index.js used to run", () => {
  const { TABLES, CORE_DDL } = require("../schema");
  assert.deepEqual(TABLES.map((t) => t.name), ["retell_events", "notifications", "bunker_prices", "econowind_leads", "interaction_scores", "prompt_change_proposals", "pipeline_snapshots"]);
  const ddl = CORE_DDL.join("\n");
  for (const t of ["retell_events", "notifications", "bunker_prices", "econowind_leads", "pipeline_snapshots"]) assert.match(ddl, new RegExp(`CREATE TABLE IF NOT EXISTS ${t}`));
  assert.ok(CORE_DDL.every((s) => /IF NOT EXISTS/.test(s)), "every statement is idempotent");
  const src = fs.readFileSync(path.join(__dirname, "..", "index.js"), "utf8");
  assert.ok(!/CREATE TABLE IF NOT EXISTS retell_events/.test(src), "index.js no longer carries the DDL");
  assert.match(src, /await ensureSchema\(pool\)/);
});

test("index.js prefers CLIENT_DATABASE_URL, names the source, and reports it on /health", () => {
  const src = fs.readFileSync(path.join(__dirname, "..", "index.js"), "utf8");
  assert.match(src, /const ACTIVE_DATABASE_URL = CLIENT_DATABASE_URL \|\| DATABASE_URL;/);
  assert.match(src, /connectionString: ACTIVE_DATABASE_URL,/);
  assert.match(src, /source: DATABASE_SOURCE/);
  assert.match(src, /"client-data" : "shared"/);
});

test("copyTable copies new rows in id order, keeps ids, resumes from the target's max id, and sets the sequence", async () => {
  const { copyTable } = await import("../scripts/lib/migrate-lib.mjs");
  const source = [...Array(2500).keys()].map((i) => ({ id: i + 1, event_type: "call_ended", secret_col: "only-on-source", received_at: `t${i}` }));
  const target = new Map([[1, { id: 1 }], [2, { id: 2 }]]); // already has two rows
  const sqls = [];
  const sourceQuery = async (sql, params) => {
    sqls.push(sql);
    if (/information_schema/.test(sql)) return { rows: ["id", "event_type", "secret_col", "received_at"].map((c) => ({ column_name: c })) };
    const [after, limit] = params; return { rows: source.filter((r) => r.id > after).slice(0, limit) };
  };
  const targetQuery = async (sql, params) => {
    sqls.push(sql);
    if (/information_schema/.test(sql)) return { rows: ["id", "event_type", "received_at"].map((c) => ({ column_name: c })) }; // no secret_col on target
    if (/MAX\(id\)/.test(sql) && /SELECT COALESCE/.test(sql) && !/setval/.test(sql)) return { rows: [{ m: Math.max(0, ...target.keys()) }] };
    if (/^INSERT/.test(sql)) { const per = 3; for (let i = 0; i < params.length; i += per) target.set(params[i], { id: params[i], event_type: params[i + 1], received_at: params[i + 2] }); return { rows: [] }; }
    return { rows: [] };
  };
  const logs = [];
  const r = await copyTable({ table: { name: "retell_events", id: "id" }, sourceQuery, targetQuery, batchSize: 1000, log: (l) => logs.push(l) });
  assert.deepEqual(r, { table: "retell_events", startedAt: 2, copied: 2498, lastId: 2500 });
  assert.equal(target.size, 2500);
  assert.equal(target.get(2500).event_type, "call_ended");
  assert.ok(!JSON.stringify([...target.values()]).includes("only-on-source"), "only shared columns are copied");
  assert.ok(sqls.some((s) => /setval\(pg_get_serial_sequence\('retell_events', 'id'\)/.test(s)));
  assert.ok(sqls.some((s) => /ON CONFLICT \(id\) DO NOTHING/.test(s)));
  assert.equal(logs.length, 3);
  // Running again copies nothing.
  const again = await copyTable({ table: { name: "retell_events", id: "id" }, sourceQuery, targetQuery });
  assert.equal(again.copied, 0);
});

test("countTables and compareCounts report match or difference per table and tolerate a missing table", async () => {
  const { countTables, compareCounts, formatTable } = await import("../scripts/lib/migrate-lib.mjs");
  const tables = [{ name: "a", id: "id" }, { name: "b", id: "id" }];
  const q = (data) => async (sql) => { const name = sql.match(/FROM (\w+)/)[1]; if (!(name in data)) { const e = new Error("relation does not exist"); e.code = "42P01"; throw e; } return { rows: [{ n: String(data[name].n), max_id: String(data[name].max) }] }; };
  const s = await countTables(q({ a: { n: 10, max: 10 }, b: { n: 5, max: 7 } }), tables);
  const t = await countTables(q({ a: { n: 10, max: 10 } }), tables);
  const c = compareCounts(s, t, tables);
  assert.equal(c.ok, false);
  assert.deepEqual(c.rows.map((r) => [r.table, r.status]), [["a", "match"], ["b", "DIFFERS"]]);
  assert.equal(t.b.error, "42P01");
  assert.match(formatTable(c.rows), /table\s+source\s+target/);
});

test("fingerprint is 8 hex chars of the sha256 and the receiver logs it without the value", async () => {
  const { fingerprint, passwordFromUrl } = await import("../scripts/lib/migrate-lib.mjs");
  assert.match(fingerprint("pw-not-real"), /^[0-9a-f]{8}$/);
  assert.notEqual(fingerprint("pw-not-real"), fingerprint("pw-not-real-2"));
  assert.equal(passwordFromUrl("postgresql://receiver_app:p%40ss@host:5432/db"), "p@ss");
  assert.equal(passwordFromUrl("postgresql://host:5432/db"), null);
  const src = fs.readFileSync(path.join(__dirname, "..", "index.js"), "utf8");
  assert.match(src, /receiver_app password fingerprint \(CLIENT_DATABASE_URL\)/);
  assert.match(src, /digest\("hex"\)\.slice\(0, 8\)/);
  assert.doesNotMatch(src, /console\.log\([^\n]*CLIENT_DATABASE_URL\}/, "the URL itself is never logged");
});

test("parseSteps takes the step from the command line or MIGRATION_STEP, several in order, and rejects unknown ones", async () => {
  const { parseSteps } = await import("../scripts/lib/migrate-lib.mjs");
  assert.deepEqual(parseSteps(["counts"], { MIGRATION_STEP: "copy" }), { steps: ["counts"] });
  assert.deepEqual(parseSteps([], { MIGRATION_STEP: "roles, schema,counts" }), { steps: ["roles", "schema", "counts"] });
  assert.deepEqual(parseSteps([], { MIGRATION_STEP: "idle" }), { steps: ["idle"] });
  assert.match(parseSteps([], {}).error, /no step given/);
  assert.match(parseSteps([], { MIGRATION_STEP: "drop" }).error, /unknown step/);
});

test("roles, proof queries and url helpers never expose a password", async () => {
  const { ROLE_SQL, PROOF, runProof, urlForRole, maskUrl } = await import("../scripts/lib/migrate-lib.mjs");
  const steps = ROLE_SQL("app-pw-not-real", "ro-pw-not-real", "railway");
  assert.ok(!JSON.stringify(steps.map((s) => s.sql)).includes("pw-not-real"), "passwords are parameters, not SQL text");
  assert.ok(steps.some((s) => /NOSUPERUSER NOCREATEDB NOCREATEROLE/.test(s.sql)));
  assert.ok(steps.some((s) => /ALTER DEFAULT PRIVILEGES FOR ROLE receiver_app .* GRANT SELECT ON TABLES TO receiver_ro/.test(s.sql)));
  assert.ok(PROOF.receiver_ro.mustFail.map((q) => q.label).includes("drop table"));
  assert.ok(PROOF.receiver_app.mustFail.map((q) => q.label).includes("create role"));
  // A fake role that refuses everything but SELECT.
  const results = await runProof("receiver_ro", async (sql) => { if (/^SELECT/.test(sql)) return { rows: [] }; const e = new Error("permission denied"); e.code = "42501"; throw e; });
  assert.ok(results.every((r) => r.pass), JSON.stringify(results));
  const leaky = await runProof("receiver_ro", async () => ({ rows: [] }));
  assert.ok(leaky.filter((r) => !r.pass).length === PROOF.receiver_ro.mustFail.length, "an allowed write is reported as a failure");
  const url = urlForRole("postgresql://postgres:admin-pw-not-real@host.railway.internal:5432/railway", "receiver_app", "app-pw-not-real");
  assert.equal(url, "postgresql://receiver_app:app-pw-not-real@host.railway.internal:5432/railway");
  assert.equal(maskUrl(url), "postgresql://receiver_app:***@host.railway.internal:5432/railway");
});

test("rotate-postgres-password: valid step, URL-safe password rule, ALTER ROLE through format() with the value as a parameter, URL rewrite keeps host and database", async () => {
  const { parseSteps, validateNewPassword, ROTATE_SQL, urlWithPassword, maskUrl } = await import("../scripts/lib/migrate-lib.mjs");
  assert.deepEqual(parseSteps(["rotate-postgres-password"]).steps, ["rotate-postgres-password"]);
  assert.equal(validateNewPassword("Abcdefghijklmnopqrstuvwxyz123456"), null);
  assert.match(validateNewPassword("short"), /24 characters/);
  assert.match(validateNewPassword("Abcdefghijklmnopqrstuvwx@yz12345"), /letters and digits/);
  const steps = ROTATE_SQL("NEWPASSWORDVALUE0123456789abcdef");
  assert.equal(steps.length, 1);
  assert.ok(!steps[0].sql.includes("NEWPASSWORDVALUE"), "the value is a parameter, not part of the SQL text");
  assert.deepEqual(steps[0].params, ["NEWPASSWORDVALUE0123456789abcdef"]);
  assert.match(steps[0].sql, /ALTER ROLE %I WITH PASSWORD %L/);
  const u = urlWithPassword("postgresql://postgres:oldsecret@postgres.railway.internal:5432/railway", "NEWPASSWORDVALUE0123456789abcdef");
  assert.equal(u, "postgresql://postgres:NEWPASSWORDVALUE0123456789abcdef@postgres.railway.internal:5432/railway");
  assert.equal(maskUrl(u), "postgresql://postgres:***@postgres.railway.internal:5432/railway");
});
