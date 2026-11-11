// Guards the agent pipeline itself. Run: npm test
// Checks that the gates exist, fail closed, and that agents cannot grant themselves more power.
// No network, no database, no real data.
//
// Every file read and import happens inside a test, never at suite level. A throw while a suite
// is being defined makes node:test report a failed suite but still exit 0, which would let a
// missing file pass silently.
"use strict";

const { test, describe } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { pathToFileURL } = require("node:url");

const ROOT = path.join(__dirname, "..");
const read = (p) => fs.readFileSync(path.join(ROOT, p), "utf8");
const loadMjs = (p) => import(pathToFileURL(path.join(ROOT, p)).href);

function parseAgent(file) {
  const text = read(path.join(".claude", "agents", file));
  const m = text.match(/^---\n([\s\S]*?)\n---\n/);
  assert.ok(m, `${file}: missing frontmatter`);
  const fm = {};
  for (const line of m[1].split("\n")) {
    const i = line.indexOf(":");
    if (i > 0) fm[line.slice(0, i).trim()] = line.slice(i + 1).trim();
  }
  fm.toolList = (fm.tools || "").split(",").map((s) => s.trim()).filter(Boolean);
  return fm;
}

const REQUIRED_FILES = [
  "CLAUDE.md",
  ".claude/settings.json",
  ".claude/pipeline/risk-tiers.json",
  ".claude/agents/planner.md",
  ".claude/agents/decomposer.md",
  ".claude/agents/builder.md",
  ".claude/agents/judge.md",
  ".claude/agents/releaser.md",
  ".claude/briefs/TEMPLATE.md",
  ".github/workflows/judge.yml",
  ".github/workflows/tier-gate.yml",
  "scripts/pipeline/risk-tier.mjs",
  "scripts/pipeline/evaluate-verdict.mjs",
];

describe("required pipeline files exist (a missing file is a failure)", () => {
  for (const f of REQUIRED_FILES) {
    test(f, () => assert.ok(fs.existsSync(path.join(ROOT, f)), `${f} is missing`));
  }
});

describe("agent files", () => {
  const ROLES = ["planner", "decomposer", "builder", "judge", "releaser"];
  for (const role of ROLES) {
    test(`${role}.md has name, description, tools and model`, () => {
      const fm = parseAgent(`${role}.md`);
      assert.equal(fm.name, role);
      assert.ok(fm.description && fm.description.length > 20, "description too short");
      assert.ok(fm.toolList.length > 0, "tools allowlist is required");
      assert.ok(fm.model, "model is required");
    });
  }

  test("the judge cannot edit, write or run shell commands", () => {
    const { toolList } = parseAgent("judge.md");
    for (const banned of ["Write", "Edit", "Bash", "NotebookEdit"]) {
      assert.ok(!toolList.includes(banned), `judge must not have ${banned}`);
    }
  });

  test("planner and decomposer cannot edit code or run shell commands", () => {
    for (const role of ["planner", "decomposer"]) {
      const { toolList } = parseAgent(`${role}.md`);
      for (const banned of ["Edit", "Bash", "NotebookEdit"]) {
        assert.ok(!toolList.includes(banned), `${role} must not have ${banned}`);
      }
    }
  });
});

describe("judge verdict evaluation fails closed", () => {
  const finding = { file: "x.js", command: "grep -n x x.js", problem: "bad" };
  const cases = [
    ["undefined verdict", undefined],
    ["empty string", ""],
    ["whitespace", "   "],
    ["not json", "VERDICT: PASS"],
    ["json array", "[]"],
    ["json null", "null"],
    ["pass as a string", JSON.stringify({ pass: "true", findings: [] })],
    ["findings missing", JSON.stringify({ pass: true })],
    ["pass false with finding", JSON.stringify({ pass: false, findings: [finding] })],
    ["pass false without finding", JSON.stringify({ pass: false, findings: [] })],
    ["pass true with finding", JSON.stringify({ pass: true, findings: [finding] })],
  ];
  for (const [name, raw] of cases) {
    test(`${name} is a FAIL`, async () => {
      const { evaluate } = await loadMjs("scripts/pipeline/evaluate-verdict.mjs");
      assert.equal(evaluate(raw).ok, false);
    });
  }
  test("pass true with no findings is the only PASS", async () => {
    const { evaluate } = await loadMjs("scripts/pipeline/evaluate-verdict.mjs");
    assert.equal(evaluate(JSON.stringify({ pass: true, plan_found: true, summary: "ok", findings: [] })).ok, true);
  });
});

describe("risk tiers", () => {
  const expect = {
    "index.js": "high",
    "batch-caller.js": "high",
    "auth.js": "high",
    "schema.js": "high",
    "sql/drop-old-receiver-tables.sql": "high",
    "scripts/pipeline/risk-tier.mjs": "high",
    ".github/workflows/judge.yml": "high",
    ".claude/agents/judge.md": "high",
    ".claude/settings.json": "high",
    "CLAUDE.md": "high",
    "tests/pipeline.test.js": "high",
    "interaction-scorer.js": "medium",
    "compliance-flags.js": "medium",
    "tests/compliance-flags.test.js": "low",
    "docs/pipeline/README.md": "low",
    ".claude/briefs/001-nl-manual-caution-flag.md": "low",
    ".claude/runs/001/PLAN.md": "low",
    "brand-new-file.js": "high",
    "some/unknown/place.py": "high",
  };
  for (const [file, tier] of Object.entries(expect)) {
    test(`${file} is ${tier}`, async () => {
      const m = await loadMjs("scripts/pipeline/risk-tier.mjs");
      assert.equal(m.classifyFile(file, m.loadConfig()), tier);
    });
  }

  test("a mixed change takes the highest tier", async () => {
    const m = await loadMjs("scripts/pipeline/risk-tier.mjs");
    const config = m.loadConfig();
    assert.equal(m.highestTier(["docs/a.md", "interaction-scorer.js"], config), "medium");
    assert.equal(m.highestTier(["docs/a.md", "interaction-scorer.js", "auth.js"], config), "high");
  });

  test("windows-style paths classify the same", async () => {
    const m = await loadMjs("scripts/pipeline/risk-tier.mjs");
    assert.equal(m.classifyFile("sql\\x.sql", m.loadConfig()), "high");
  });

  test("high tier is blocked without the label and allowed with it", async () => {
    const m = await loadMjs("scripts/pipeline/risk-tier.mjs");
    assert.equal(m.gate("high", []).ok, false);
    assert.equal(m.gate("high", ["bug"]).ok, false);
    assert.equal(m.gate("high", undefined).ok, false);
    assert.equal(m.gate("high", ["human-approved"]).ok, true);
    assert.equal(m.gate("medium", []).ok, true);
    assert.equal(m.gate("low", []).ok, true);
  });
});

describe("workflows keep their guards", () => {
  test("judge workflow has a kill switch that fails closed", () => {
    const judge = read(".github/workflows/judge.yml");
    assert.match(judge, /AGENT_PIPELINE_ENABLED/);
    assert.match(judge, /exit 1/);
  });

  test("judge workflow never continues on error and always evaluates the verdict", () => {
    const judge = read(".github/workflows/judge.yml");
    assert.ok(!/continue-on-error/.test(judge));
    assert.match(judge, /evaluate-verdict\.mjs/);
    assert.match(judge, /if: always\(\)/);
  });

  test("judge is not allowed to write or edit", () => {
    const judge = read(".github/workflows/judge.yml");
    const allowed = judge.split("\n").filter((l) => l.includes("--allowedTools"));
    assert.ok(allowed.length > 0, "allowedTools line missing");
    for (const l of allowed) assert.ok(!/\b(Write|Edit|NotebookEdit)\b/.test(l), "judge allowedTools grants a write tool");
  });

  test("tier-gate workflow runs the gate with the PR labels", () => {
    const gateWf = read(".github/workflows/tier-gate.yml");
    assert.match(gateWf, /risk-tier\.mjs/);
    assert.match(gateWf, /--gate/);
    assert.match(gateWf, /LABELS/);
    assert.ok(!/continue-on-error/.test(gateWf));
  });
});

describe("briefs", () => {
  test("the template and brief 001 carry the four required parts", () => {
    for (const f of [".claude/briefs/TEMPLATE.md", ".claude/briefs/001-nl-manual-caution-flag.md"]) {
      const t = read(f);
      for (const h of ["## Goal", "## Constraints", "## Files in scope", "## Acceptance criteria"]) {
        assert.ok(t.includes(h), `${f} is missing ${h}`);
      }
    }
  });
});
