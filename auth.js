// ─── Shared-secret auth for protected endpoints ─────────────────────────────
// Callers send NOTIFY_SECRET in the x-notify-secret header (or, for older
// callers, as "secret" in the JSON body). Two rules:
//  - Fail closed: if NOTIFY_SECRET is unset or empty, every protected route
//    answers 503 and the server logs a startup error. It never lets a request
//    through without a secret to check against.
//  - Constant time: the comparison takes the same time whether the guess is
//    right, nearly right or a different length, so it cannot be found by timing.

const crypto = require("crypto");

// True only when `given` is a string equal to `secret`. Both sides are hashed
// first so timingSafeEqual always compares two buffers of the same length.
function secretMatches(given, secret) {
  if (typeof given !== "string" || typeof secret !== "string" || secret === "") return false;
  const a = crypto.createHash("sha256").update(given, "utf8").digest();
  const b = crypto.createHash("sha256").update(secret, "utf8").digest();
  return crypto.timingSafeEqual(a, b);
}

// Builds the requireAuth middleware for one secret. Called once at startup.
function makeRequireAuth(secret, { log = console.error } = {}) {
  const configured = typeof secret === "string" && secret !== "";
  if (!configured) {
    log("[AUTH] STARTUP ERROR: NOTIFY_SECRET is not set. Every protected endpoint will answer 503 until it is set and the service is redeployed.");
  }
  return function requireAuth(req, res, next) {
    if (!configured) {
      return res.status(503).json({ error: "Auth is not configured on this server" });
    }
    const given = req.headers["x-notify-secret"] || (req.body && req.body.secret);
    if (!secretMatches(given, secret)) {
      return res.status(401).json({ error: "Invalid or missing secret" });
    }
    next();
  };
}

module.exports = { makeRequireAuth, secretMatches };
