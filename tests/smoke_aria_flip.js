// Smoke test for the Aria flip endpoints.
//
// Runs against the LIVE Railway deployment. There is no mocking and no
// test framework dependency — this is an integration smoke test in the
// same style as check_run2.js.
//
// Usage:
//   node tests/smoke_aria_flip.js
//
// Exits 0 on success, 1 on any failed assertion.

const fs = require("fs");

// Minimal .env loader (no dotenv dep)
for (const line of fs.readFileSync("C:\\retell-repo\\.env", "utf8").split(/\r?\n/)) {
  const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/i);
  if (m) process.env[m[1]] = m[2].replace(/^"|"$/g, "");
}

const BASE         = process.env.RAILWAY_BASE_URL || "https://retell-webhook-receiver-production.up.railway.app";
const NOTIFY_SECRET = process.env.NOTIFY_SECRET;
const EN_AGENT_ID  = "agent_aa56b68b02f6de4ac5725a829b";
const NL_AGENT_ID  = "agent_e1e1f763101db5abe0df281891";
const NL_DID       = "+31207163656";

const out = [];
const log = (...a) => { const l = a.join(" "); console.log(l); out.push(l); };
let failures = 0;
const assert = (cond, msg) => {
  if (cond) {
    log(`  ✓ ${msg}`);
  } else {
    log(`  ✗ FAIL: ${msg}`);
    failures++;
  }
};

async function httpJson(method, path, body, extraHeaders = {}) {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      "x-notify-secret": NOTIFY_SECRET,
      ...extraHeaders,
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  let data;
  try { data = await res.json(); } catch { data = null; }
  return { status: res.status, data };
}

// Variant that sends JSON (most endpoints expect JSON)
async function httpJsonBody(method, path, body, extraHeaders = {}) {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: {
      "Content-Type": "application/json",
      "x-notify-secret": NOTIFY_SECRET,
      ...extraHeaders,
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  let data;
  try { data = await res.json(); } catch { data = null; }
  return { status: res.status, data };
}

(async () => {
  try {
    log("=== Aria flip endpoint smoke test ===");
    log("BASE:", BASE);
    log("NOTIFY_SECRET present:", !!NOTIFY_SECRET);

    // ── Test 1: /health should be 200 (sanity baseline) ─────────────────
    log("\n[1] /health sanity");
    const health = await httpJsonBody("GET", "/health");
    assert(health.status === 200, `/health returns 200 (got ${health.status})`);

    // ── Test 2: GET /aria/binding-status without auth → 401 ─────────────
    log("\n[2] GET /aria/binding-status without auth");
    const noAuth = await fetch(`${BASE}/aria/binding-status`).then(r => ({ status: r.status }));
    assert(noAuth.status === 401 || noAuth.status === 403, `unauth call is rejected (got ${noAuth.status})`);

    // ── Test 3: GET /aria/binding-status with auth → 200 and valid shape ─
    log("\n[3] GET /aria/binding-status with auth");
    const status1 = await httpJsonBody("GET", "/aria/binding-status");
    assert(status1.status === 200, `returns 200 (got ${status1.status})`);
    assert(status1.data && status1.data.current, "response has .current");
    assert(
      status1.data && status1.data.current && typeof status1.data.current.agent_label === "string",
      "response has .current.agent_label as string"
    );
    assert(
      status1.data && status1.data.current && status1.data.current.phone_number === NL_DID,
      `phone_number matches ${NL_DID}`
    );
    log("  initial binding:", status1.data && status1.data.current && status1.data.current.agent_label);

    // ── Test 4: POST /aria/set-agent with invalid agent → 400 ───────────
    log("\n[4] POST /aria/set-agent with invalid agent");
    const badAgent = await httpJsonBody("POST", "/aria/set-agent", { agent: "BOGUS" });
    assert(badAgent.status === 400, `returns 400 (got ${badAgent.status})`);

    // ── Test 5: POST /aria/set-agent EN → 200 and binding = EN ──────────
    log("\n[5] POST /aria/set-agent { agent: 'EN' }");
    const setEN = await httpJsonBody("POST", "/aria/set-agent", { agent: "EN" });
    assert(setEN.status === 200, `returns 200 (got ${setEN.status})`);
    assert(
      setEN.data && setEN.data.binding && setEN.data.binding.outbound_agent_id === EN_AGENT_ID,
      "binding now points to Aria EN agent id"
    );
    assert(
      setEN.data && setEN.data.binding && setEN.data.binding.agent_label === "Aria EN",
      "agent_label = 'Aria EN'"
    );

    // ── Test 6: GET status again → should show EN + last_change present ─
    log("\n[6] GET /aria/binding-status after EN flip");
    const status2 = await httpJsonBody("GET", "/aria/binding-status");
    assert(status2.status === 200, `returns 200 (got ${status2.status})`);
    assert(
      status2.data && status2.data.current && status2.data.current.agent_label === "Aria EN",
      "current.agent_label = 'Aria EN'"
    );
    assert(
      status2.data && status2.data.last_change && status2.data.last_change.timestamp,
      "last_change.timestamp is populated"
    );

    // ── Test 7: POST /aria/set-agent NL → 200 and binding = NL ──────────
    log("\n[7] POST /aria/set-agent { agent: 'NL' }");
    const setNL = await httpJsonBody("POST", "/aria/set-agent", { agent: "NL" });
    assert(setNL.status === 200, `returns 200 (got ${setNL.status})`);
    assert(
      setNL.data && setNL.data.binding && setNL.data.binding.outbound_agent_id === NL_AGENT_ID,
      "binding now points to Aria NL agent id"
    );
    assert(
      setNL.data && setNL.data.binding && setNL.data.binding.agent_label === "Aria NL",
      "agent_label = 'Aria NL'"
    );

    // ── Test 8: final status sanity ─────────────────────────────────────
    log("\n[8] Final /aria/binding-status");
    const status3 = await httpJsonBody("GET", "/aria/binding-status");
    assert(
      status3.data && status3.data.current && status3.data.current.agent_label === "Aria NL",
      "final state is 'Aria NL' (rest state restored)"
    );

    log("\n=== RESULT ===");
    if (failures === 0) {
      log(`✅ All assertions passed (${out.filter(l => l.startsWith("  ✓")).length} checks)`);
    } else {
      log(`❌ ${failures} assertion(s) failed`);
    }
  } catch (e) {
    log("FATAL:", e.message);
    log(e.stack);
    failures++;
  } finally {
    fs.writeFileSync("C:\\retell-repo\\tests\\smoke_aria_flip.out.txt", out.join("\n"));
    process.exit(failures === 0 ? 0 : 1);
  }
})();
