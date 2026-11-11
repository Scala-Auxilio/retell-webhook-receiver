// Classifies changed files into low / medium / high risk and enforces the human gate.
// Pure functions are exported for tests. CLI:
//   node scripts/pipeline/risk-tier.mjs --files a.js,b.js
//   node scripts/pipeline/risk-tier.mjs --base origin/main --head HEAD --gate   (reads LABELS env, a JSON array)
// A file the config does not list counts as the default tier (high). Fail safe.
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";

const ORDER = { low: 0, medium: 1, high: 2 };
const here = path.dirname(fileURLToPath(import.meta.url));
const CONFIG_PATH = path.join(here, "..", "..", ".claude", "pipeline", "risk-tiers.json");

export function loadConfig(p = CONFIG_PATH) {
  return JSON.parse(fs.readFileSync(p, "utf8"));
}

export function globToRegExp(glob) {
  let re = "";
  for (let i = 0; i < glob.length; ) {
    if (glob.startsWith("**/", i)) { re += "(?:.*/)?"; i += 3; }
    else if (glob.startsWith("**", i)) { re += ".*"; i += 2; }
    else if (glob[i] === "*") { re += "[^/]*"; i += 1; }
    else { re += glob[i].replace(/[.+?^${}()|[\]\\]/g, "\\$&"); i += 1; }
  }
  return new RegExp("^" + re + "$");
}

export function classifyFile(file, config) {
  const f = String(file).replace(/\\/g, "/").replace(/^\.\//, "");
  let best = null;
  for (const rule of config.rules) {
    for (const pat of rule.patterns) {
      if (globToRegExp(pat).test(f) && (best === null || ORDER[rule.tier] > ORDER[best])) best = rule.tier;
    }
  }
  return best === null ? config.default : best;
}

export function highestTier(files, config) {
  let top = "low";
  for (const f of files) {
    const t = classifyFile(f, config);
    if (ORDER[t] > ORDER[top]) top = t;
  }
  return top;
}

export function gate(tier, labels, approvalLabel = "human-approved") {
  if (tier === "high" && !(Array.isArray(labels) && labels.includes(approvalLabel))) {
    return { ok: false, reason: `high-risk change needs the "${approvalLabel}" label, applied by a human` };
  }
  return { ok: true, reason: tier === "high" ? "high tier, human approved" : `${tier} tier, no human gate needed` };
}

function parseArgs(argv) {
  const a = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--gate") a.gate = true;
    else if (argv[i].startsWith("--")) a[argv[i].slice(2)] = argv[++i];
  }
  return a;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const config = loadConfig();
  let files;
  if (args.files !== undefined) files = args.files.split(",").map((s) => s.trim()).filter(Boolean);
  else {
    const out = execFileSync("git", ["diff", "--name-only", "--no-renames", `${args.base}...${args.head || "HEAD"}`], { encoding: "utf8" });
    files = out.split("\n").map((s) => s.trim()).filter(Boolean);
  }
  const tier = highestTier(files, config);
  const perFile = Object.fromEntries(files.map((f) => [f, classifyFile(f, config)]));
  let result = { tier, files: perFile };
  let code = 0;
  if (args.gate) {
    let labels = [];
    try { labels = JSON.parse(process.env.LABELS || "[]"); } catch { labels = []; }
    const g = gate(tier, labels, config.approvalLabel);
    result.gate = g;
    if (!g.ok) code = 1;
  }
  console.log(JSON.stringify(result, null, 2));
  process.exit(code);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
