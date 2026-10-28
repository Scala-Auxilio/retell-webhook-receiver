// Auth on the protected scorer, recon and Odoo routes. Run: npm test
// No network beyond 127.0.0.1, no database, no real data: a fake pool, a fake
// Odoo JSON-RPC server and a made-up secret.
"use strict";

const { test, describe, before, after } = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");

const SECRET = "test-secret-not-real-0123456789";

// ─── Fake Odoo (JSON-RPC): authenticate returns a uid, every query returns no rows ──
let fakeOdoo;
let odooCalls = 0;
before(async () => {
  fakeOdoo = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => { body += c; });
    req.on("end", () => {
      odooCalls += 1;
      const params = (JSON.parse(body || "{}").params) || {};
      const result = params.service === "common" ? 7 : [];
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({ jsonrpc: "2.0", id: 1, result }));
    });
  });
  await new Promise((r) => fakeOdoo.listen(0, "127.0.0.1", r));
  // odoo-proxy.js reads these when it is first required, so set them before.
  process.env.ODOO_URL = `http://127.0.0.1:${fakeOdoo.address().port}`;
  process.env.ODOO_DB = "test-db";
  process.env.ODOO_LOGIN = "test-login";
  process.env.ODOO_API_KEY = "test-key-not-real";
});
after(() => new Promise((r) => fakeOdoo.close(r)));

// ─── Fake database pool: enough for the handlers to answer 200 ─────────────
const fakePool = {
  async query(sql) {
    if (/SELECT id, total_score, tier, scored_at FROM interaction_scores/.test(sql)) {
      // auto-score: the call is already scored, so no Retell or Claude call is made
      return { rowCount: 1, rows: [{ id: 1, total_score: 80, tier: "Strong", scored_at: "2026-01-01T00:00:00Z" }] };
    }
    return { rowCount: 0, rows: [] };
  },
};

// One app per secret setting, with the real route modules and the real middleware.
async function startApp(secret, log = () => {}) {
  const express = require("express");
  const { makeRequireAuth } = require("../auth");
  const scorer = require("../interaction-scorer");
  const recon = require("../recon");
  const odooProxy = require("../odoo-proxy");
  const app = express();
  app.use(express.json());
  const requireAuth = makeRequireAuth(secret, { log });
  scorer.registerRoutes(app, fakePool, { requireAuth });
  recon.registerRoutes(app, fakePool, { requireAuth });
  odooProxy.registerRoutes(app, fakePool, { requireAuth });
  const server = await new Promise((r) => { const s = app.listen(0, "127.0.0.1", () => r(s)); });
  const base = `http://127.0.0.1:${server.address().port}`;
  return { base, close: () => new Promise((r) => server.close(r)) };
}

const PROTECTED = [
  ["GET", "/scorer/unscored"],
  ["POST", "/scorer/score", { call_id: "call_test_1", agent_type: "aria", dimension_scores: {}, outcome: "test" }],
  ["POST", "/scorer/auto-score", { call_id: "call_test_1" }],
  ["GET", "/scorer/scores"],
  ["GET", "/scorer/summary"],
  ["GET", "/recon/counts"],
  ["GET", "/recon/counts?since=2026-10-01T00:00:00Z&until=2026-10-02T00:00:00Z"],
  ["GET", "/recon/scores-by-source"],
  ["GET", "/odoo/status"],
  ["GET", "/odoo/pipeline-snapshot"],
  ["GET", "/odoo/pipeline-report"],
  ["GET", "/odoo/pipeline-report/preview"],
  ["POST", "/odoo/snapshot/save"],
];

async function call(base, method, route, body, headers = {}) {
  const res = await fetch(base + route, {
    method,
    headers: { ...(body ? { "Content-Type": "application/json" } : {}), ...headers },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  return { status: res.status, text };
}

describe("secret set", () => {
  let app;
  before(async () => { app = await startApp(SECRET); });
  after(() => app.close());

  for (const [method, route, body] of PROTECTED) {
    test(`${method} ${route}: no header gives 401`, async () => {
      const r = await call(app.base, method, route, body);
      assert.equal(r.status, 401);
      assert.deepEqual(JSON.parse(r.text), { error: "Invalid or missing secret" }); // same body as before this change
    });
    test(`${method} ${route}: wrong header gives 401`, async () => {
      assert.equal((await call(app.base, method, route, body, { "x-notify-secret": "wrong" })).status, 401);
      // Same length as the real secret, one character different.
      const nearly = SECRET.slice(0, -1) + (SECRET.endsWith("9") ? "8" : "9");
      assert.equal((await call(app.base, method, route, body, { "x-notify-secret": nearly })).status, 401);
    });
    test(`${method} ${route}: right header gives 200`, async () => {
      const r = await call(app.base, method, route, body, { "x-notify-secret": SECRET });
      assert.equal(r.status, 200, r.text);
    });
  }

  test("older callers that send the secret in the JSON body still pass", async () => {
    const r = await call(app.base, "POST", "/scorer/auto-score", { call_id: "call_test_1", secret: SECRET });
    assert.equal(r.status, 200, r.text);
    assert.equal((await call(app.base, "POST", "/scorer/auto-score", { call_id: "call_test_1", secret: "wrong" })).status, 401);
    assert.equal((await call(app.base, "POST", "/scorer/auto-score", { call_id: "call_test_1", secret: 12345 })).status, 401);
  });

  test("the Odoo routes reached the fake Odoo only with the right header", () => {
    assert.ok(odooCalls > 0);
  });

  // The rubric is a static document with no client data; it stays open.
  test("GET /scorer/rubric stays open", async () => {
    assert.equal((await call(app.base, "GET", "/scorer/rubric")).status, 200);
  });

  test("GET /recon/counts answers counts only, for a default 24h window", async () => {
    const r = await call(app.base, "GET", "/recon/counts", null, { "x-notify-secret": SECRET });
    assert.equal(r.status, 200, r.text);
    const body = JSON.parse(r.text);
    assert.deepEqual(Object.keys(body).sort(), ["agents", "notifications", "totals", "window"]);
    assert.deepEqual(body.totals, { events: 0, distinct_calls: 0, scored_calls: 0 });
    assert.deepEqual(body.notifications, { sent: 0, failed: 0 });
    const ms = new Date(body.window.until) - new Date(body.window.since);
    assert.equal(ms, 24 * 60 * 60 * 1000);
  });

  test("GET /recon/counts rejects a bad or oversized window with 400", async () => {
    const h = { "x-notify-secret": SECRET };
    assert.equal((await call(app.base, "GET", "/recon/counts?since=yesterday", null, h)).status, 400);
    assert.equal((await call(app.base, "GET", "/recon/counts?since=2026-10-02T00:00:00Z&until=2026-10-01T00:00:00Z", null, h)).status, 400);
    assert.equal((await call(app.base, "GET", "/recon/counts?since=2026-01-01T00:00:00Z&until=2026-03-01T00:00:00Z", null, h)).status, 400);
  });

  test("GET /recon/scores-by-source covers all time without a window", async () => {
    const r = await call(app.base, "GET", "/recon/scores-by-source", null, { "x-notify-secret": SECRET });
    assert.equal(r.status, 200, r.text);
    assert.deepEqual(JSON.parse(r.text), { window: "all", total: 0, sources: [] });
  });
});

describe("secret unset or empty: fail closed", () => {
  for (const [label, secret] of [["unset", null], ["undefined", undefined], ["empty", ""]]) {
    describe(label, () => {
      let app; const logged = [];
      before(async () => { app = await startApp(secret, (m) => logged.push(m)); });
      after(() => app.close());

      test("logs one clear startup error", () => {
        assert.equal(logged.length, 1);
        assert.match(logged[0], /STARTUP ERROR: NOTIFY_SECRET is not set/);
      });
      for (const [method, route, body] of PROTECTED) {
        test(`${method} ${route}: 503, with or without a header`, async () => {
          assert.equal((await call(app.base, method, route, body)).status, 503);
          assert.equal((await call(app.base, method, route, body, { "x-notify-secret": "anything" })).status, 503);
          assert.equal((await call(app.base, method, route, body, { "x-notify-secret": "" })).status, 503);
        });
      }
    });
  }
});

describe("recon counts with chat and call events", () => {
  const { foldEventCounts } = require("../recon");
  const ECONOWIND = "agent_760482429951f50e816c47b55a";
  const ARIA = "agent_aa56b68b02f6de4ac5725a829b";

  test("foldEventCounts adds chat_* and call_* into started/ended/analyzed", () => {
    const folded = foldEventCounts([
      { agent_id: ECONOWIND, event_type: "chat_started", n: "4" },
      { agent_id: ECONOWIND, event_type: "chat_ended", n: "3" },
      { agent_id: ECONOWIND, event_type: "chat_analyzed", n: "2" },
      { agent_id: ARIA, event_type: "call_started", n: "1" },
      { agent_id: ARIA, event_type: "call_ended", n: "1" },
      { agent_id: ARIA, event_type: "call_analyzed", n: "1" },
      { agent_id: ARIA, event_type: "call_ended", n: "2" },
      { agent_id: ARIA, event_type: "something_else", n: "5" },
    ]);
    // Sorted by agent_id: digits come before letters, so EconoWind is first.
    assert.deepEqual(folded, [
      { agent_id: ECONOWIND, events: 9, started: 4, ended: 3, analyzed: 2, other: 0 },
      { agent_id: ARIA, events: 10, started: 1, ended: 3, analyzed: 1, other: 5 },
    ]);
    assert.deepEqual(foldEventCounts([]), []);
  });

  // A pool that answers the three recon queries with EconoWind chat data,
  // so the route is checked end to end on the response shape.
  const chatPool = {
    async query(sql) {
      if (/GROUP BY agent_id, event_type/.test(sql)) {
        return { rows: [
          { agent_id: ECONOWIND, event_type: "chat_started", n: "4" },
          { agent_id: ECONOWIND, event_type: "chat_ended", n: "3" },
          { agent_id: ECONOWIND, event_type: "chat_analyzed", n: "2" },
        ] };
      }
      if (/COUNT\(DISTINCT call_id\) AS distinct_calls/.test(sql)) {
        return { rows: [{ agent_id: ECONOWIND, distinct_calls: "4", calls_with_transcript: "3" }] };
      }
      if (/JOIN interaction_scores/.test(sql)) {
        return { rows: [{ agent_id: ECONOWIND, scored_calls: "2" }] };
      }
      if (/FROM notifications/.test(sql)) {
        return { rows: [{ sent: "1", failed: "0" }] };
      }
      return { rows: [] };
    },
  };

  test("GET /recon/counts reports EconoWind chat events as started/ended/analyzed", async () => {
    const express = require("express");
    const { makeRequireAuth } = require("../auth");
    const app = express();
    require("../recon").registerRoutes(app, chatPool, { requireAuth: makeRequireAuth(SECRET) });
    const server = await new Promise((r) => { const s = app.listen(0, "127.0.0.1", () => r(s)); });
    try {
      const base = `http://127.0.0.1:${server.address().port}`;
      const r = await call(base, "GET", "/recon/counts?since=2026-10-27T00:00:00Z&until=2026-10-28T00:00:00Z", null, { "x-notify-secret": SECRET });
      assert.equal(r.status, 200, r.text);
      const body = JSON.parse(r.text);
      assert.deepEqual(body.agents, [{
        agent_id: ECONOWIND, events: 9, started: 4, ended: 3, analyzed: 2, other: 0,
        distinct_calls: 4, calls_with_transcript: 3, scored_calls: 2,
      }]);
      assert.deepEqual(body.totals, { events: 9, distinct_calls: 4, scored_calls: 2 });
      assert.deepEqual(body.notifications, { sent: 1, failed: 0 });
      assert.deepEqual(body.window, { since: "2026-10-27T00:00:00.000Z", until: "2026-10-28T00:00:00.000Z" });
      assert.equal((await call(base, "GET", "/recon/counts")).status, 401);
    } finally {
      await new Promise((r) => server.close(r));
    }
  });
});

describe("secretMatches", () => {
  const { secretMatches } = require("../auth");
  test("true only for the exact string", () => {
    assert.equal(secretMatches(SECRET, SECRET), true);
    assert.equal(secretMatches(SECRET + " ", SECRET), false);
    assert.equal(secretMatches("", SECRET), false);
    assert.equal(secretMatches(undefined, SECRET), false);
    assert.equal(secretMatches(["a"], SECRET), false);
    assert.equal(secretMatches("x".repeat(5000), SECRET), false); // a different length never throws
  });
  test("never true when no secret is configured", () => {
    assert.equal(secretMatches("", ""), false);
    assert.equal(secretMatches(undefined, undefined), false);
    assert.equal(secretMatches("null", null), false);
  });
});

describe("route modules refuse to register without auth", () => {
  test("interaction-scorer, recon, odoo-proxy and intelligence-analyst throw instead of opening routes", () => {
    const express = require("express");
    assert.throws(() => require("../interaction-scorer").registerRoutes(express(), fakePool), /requireAuth is required/);
    assert.throws(() => require("../recon").registerRoutes(express(), fakePool), /requireAuth is required/);
    assert.throws(() => require("../odoo-proxy").registerRoutes(express(), fakePool), /requireAuth is required/);
    assert.throws(() => require("../intelligence-analyst").registerAnalystRoutes(express(), { pool: fakePool }), /requireAuth is required/);
  });
});

describe("index.js wiring", () => {
  // index.js starts the server and the crons when loaded, so it is checked as text.
  const src = fs.readFileSync(path.join(__dirname, "..", "index.js"), "utf8");
  test("requireAuth comes from auth.js, with no fail-open branch left", () => {
    assert.match(src, /const requireAuth = makeRequireAuth\(NOTIFY_SECRET\);/);
    assert.doesNotMatch(src, /function requireAuth\(/);
    assert.doesNotMatch(src, /if \(!NOTIFY_SECRET\) return next\(\)/);
  });
  test("the scorer, recon, analyst and Odoo routes get requireAuth", () => {
    assert.match(src, /scorer\.registerRoutes\(app, pool, \{ requireAuth \}\)/);
    assert.match(src, /recon\.registerRoutes\(app, pool, \{ requireAuth \}\)/);
    assert.match(src, /analyst\.registerAnalystRoutes\(app, \{ pool, sendEmail, requireAuth \}\)/);
    assert.match(src, /odooProxy\.registerRoutes\(app, pool, \{ requireAuth \}\)/);
  });
  test("GET /events and GET /stats require the secret, with no redaction branch left", () => {
    assert.match(src, /app\.get\("\/events", requireAuth, async/);
    assert.match(src, /app\.get\("\/stats", requireAuth, async/);
    assert.doesNotMatch(src, /metadata-only/);
    assert.doesNotMatch(src, /secretMatches/);
  });
});
