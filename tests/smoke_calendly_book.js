// tests/smoke_calendly_book.js
// Integration smoke test for /calendly/book body-shape handling.
//
// Proves the endpoint accepts BOTH payload shapes:
//   1) Retell custom-function tool with args_at_root=false:
//        { name: "book_meeting", call: {...}, args: { specialist, start_time, name, email } }
//   2) Direct/manual POST:
//        { specialist, start_time, name, email }
//
// The bug (2026-04-10): endpoint only accepted shape #2, so real Aria calls
// failed with "Missing start_time" because Retell was sending shape #1.

const https = require("https");
const fs = require("fs");

// Minimal .env loader (no dotenv dependency)
try {
  for (const line of fs.readFileSync(__dirname + "/../.env", "utf8").split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/i);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^"|"$/g, "");
  }
} catch { /* .env optional */ }

const BASE = process.env.SMOKE_BASE_URL || "https://retell-webhook-receiver-production.up.railway.app";

let failCount = 0;
function check(name, cond, extra) {
  if (cond) {
    console.log("  PASS - " + name);
  } else {
    console.log("  FAIL - " + name + (extra ? " :: " + extra : ""));
    failCount++;
  }
}

function request(path, opts) {
  return new Promise((resolve, reject) => {
    const url = new URL(BASE + path);
    const req = https.request({
      hostname: url.hostname,
      port: 443,
      path: url.pathname + url.search,
      method: opts.method || "GET",
      headers: opts.headers || {},
    }, (res) => {
      let b = "";
      res.on("data", (c) => (b += c));
      res.on("end", () => {
        let parsed = b;
        try { parsed = JSON.parse(b); } catch { /* plain */ }
        resolve({ status: res.statusCode, body: parsed, raw: b });
      });
    });
    req.on("error", reject);
    if (opts.body) req.write(opts.body);
    req.end();
  });
}

// Intentionally invalid fields so we never actually create a real Calendly booking.
// The ".invalid" TLD is reserved (RFC 2606) and Calendly rejects it at the API layer.
// If the endpoint UNWRAPS correctly, Calendly returns 400 "Email format is invalid" and
// our handler returns { booked: false, error: "Calendly API 400: ..." }.
// If the endpoint does NOT unwrap, it returns 400 "Missing start_time" BEFORE touching Calendly.
// These two failure modes are distinct, which is exactly what we want to assert against.
const FAKE = {
  specialist: "mike",
  start_time: "2026-06-15T10:00:00+02:00",
  name: "Smoke Test Do Not Book",
  email: "smoke-test-do-not-book@example.invalid",
};

(async () => {
  console.log("=== /calendly/book body-shape smoke test ===");
  console.log("BASE: " + BASE);
  console.log("");

  // ---- Case A: Retell-shaped wrapped body (the bug scenario) ----
  console.log("[A] Retell-shaped body { name, call, args: {...} }");
  const wrapped = JSON.stringify({
    name: "book_meeting",
    call: { call_id: "smoke_test_wrapped" },
    args: FAKE,
  });
  const a = await request("/calendly/book", {
    method: "POST",
    headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(wrapped) },
    body: wrapped,
  });

  check("[A] returns 200 (got " + a.status + ")", a.status === 200);
  check("[A] response is JSON object", typeof a.body === "object" && a.body !== null);
  check("[A] response is NOT 'Missing start_time'",
    !(a.body && a.body.error && /Missing start_time/.test(a.body.error)),
    "got: " + JSON.stringify(a.body).slice(0, 200));
  // Should hit Calendly and fail at the email-validation layer, proving unwrap worked
  check("[A] reached Calendly layer (error mentions Calendly or email)",
    a.body && ((a.body.error && /Calendly|email|Email/i.test(a.body.error))
              || a.body.booked === false),
    "got: " + JSON.stringify(a.body).slice(0, 200));
  check("[A] booked is false (fake email should not book)", a.body && a.body.booked === false);

  // ---- Case B: Direct/manual body shape (backward-compat path) ----
  console.log("");
  console.log("[B] Direct body { specialist, start_time, name, email }");
  const direct = JSON.stringify(FAKE);
  const b = await request("/calendly/book", {
    method: "POST",
    headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(direct) },
    body: direct,
  });

  check("[B] returns 200 (got " + b.status + ")", b.status === 200);
  check("[B] response is NOT 'Missing start_time'",
    !(b.body && b.body.error && /Missing start_time/.test(b.body.error)),
    "got: " + JSON.stringify(b.body).slice(0, 200));
  check("[B] booked is false (fake email should not book)", b.body && b.body.booked === false);

  // ---- Case C: Missing start_time inside args should still return a proper error ----
  console.log("");
  console.log("[C] Wrapped body with missing start_time");
  const missing = JSON.stringify({
    name: "book_meeting",
    call: { call_id: "smoke_test_missing" },
    args: { specialist: "mike", name: "Missing", email: "missing@example.invalid" },
  });
  const c = await request("/calendly/book", {
    method: "POST",
    headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(missing) },
    body: missing,
  });
  check("[C] returns 400 when start_time genuinely missing (got " + c.status + ")", c.status === 400);
  check("[C] error body mentions Missing start_time",
    c.body && c.body.error && /Missing start_time/.test(c.body.error));

  // ---- Summary ----
  console.log("");
  console.log("=== RESULT ===");
  if (failCount === 0) {
    console.log("All assertions passed");
    process.exit(0);
  } else {
    console.log(failCount + " assertion(s) failed");
    process.exit(1);
  }
})().catch((e) => { console.error("FATAL: " + e.message); process.exit(2); });
