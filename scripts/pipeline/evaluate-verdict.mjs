// Turns the judge's structured output into a pass or fail exit code. Fails closed:
// an empty, malformed or contradictory verdict is a FAIL, never a pass.
// CLI: VERDICT='<json>' node scripts/pipeline/evaluate-verdict.mjs
import { pathToFileURL } from "node:url";

const fail = (reason, findings = []) => ({ ok: false, reason, findings });

export function evaluate(raw) {
  if (typeof raw !== "string" || raw.trim() === "") return fail("no verdict returned (an absent check counts as a failure)");
  let v;
  try { v = JSON.parse(raw); } catch { return fail("verdict is not valid JSON"); }
  if (typeof v !== "object" || v === null || Array.isArray(v)) return fail("verdict is not an object");
  if (typeof v.pass !== "boolean") return fail("verdict.pass must be a boolean");
  if (!Array.isArray(v.findings)) return fail("verdict.findings must be an array");
  if (v.pass === false) return fail(`judge failed the PR with ${v.findings.length} blocking finding(s)`, v.findings);
  if (v.findings.length > 0) return fail("verdict says pass but lists blocking findings (contradiction)", v.findings);
  return { ok: true, reason: "judge passed with no blocking findings", findings: [] };
}

function main() {
  const r = evaluate(process.env.VERDICT);
  console.log(r.ok ? `PASS: ${r.reason}` : `FAIL: ${r.reason}`);
  for (const f of r.findings) console.log(` - ${f.file || "?"}${f.line ? ":" + f.line : ""}: ${f.problem || ""} [${f.command || "no command"}]`);
  process.exit(r.ok ? 0 : 1);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
