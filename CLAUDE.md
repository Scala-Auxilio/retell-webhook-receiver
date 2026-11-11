# retell-webhook-receiver: guide for agents

This repo is Scala Auxilio's Retell webhook receiver. It records call and chat events, scores interactions, runs batch calling and talks to Postgres, Odoo and Calendly. It handles live client data. Read this file before doing anything.

## Commands

- Install: `npm install --no-audit --no-fund --no-package-lock`
- Test (the gate): `npm test` (runs `node --test tests/*.test.js`)
- Node: `package.json` says 22.x. The existing Tests workflow uses Node 20. Do not change either without a brief that says so.
- Risk tier of files: `node scripts/pipeline/risk-tier.mjs --files a.js,b.js`

## Data rule (never break)

- No real phone numbers, names, emails, transcripts, call ids or client names in code, tests, fixtures, logs, commit messages or PR text. Use obviously fake values such as `+31600000000` and `example.com`.
- Tests make no network calls beyond 127.0.0.1, touch no real database and read no real secrets. Use fakes, as `tests/auth.test.js` does.
- Never run `batch-caller.js` with `--send`. Never call the Retell, Anthropic, Odoo, Calendly or Railway APIs from a task.

## How work flows

1. A human writes a brief from `.claude/briefs/TEMPLATE.md`.
2. `planner` writes `.claude/runs/<brief-id>/PLAN.md`.
3. `decomposer` writes `.claude/runs/<brief-id>/tasks.json`.
4. `builder` implements one task per branch and opens a PR.
5. CI runs three required checks: `test`, `judge`, `tier-gate`.
6. `releaser` enables auto-merge only when all three are green.

State lives in those files. If it is not written down, the next agent cannot see it.

## Risk tiers

Tiers are defined in `.claude/pipeline/risk-tiers.json` and enforced by CI, not by good intentions.

- low: docs, tests, briefs. Flows through on green checks.
- medium: scoring and analysis logic. Flows through on green checks.
- high: anything that dials, books, authenticates, migrates, deploys, or changes the pipeline itself. Needs the `human-approved` label, applied by a human.
- A file the config does not list counts as high.

## Rules for every agent

- One job per agent. A builder never approves its own work. The judge never edits.
- Stay inside the files your task owns. Anything else you notice goes in the plan under "Out of scope, noticed", not in the diff.
- Never push to `main`, never force push, never merge a PR that is not green, never add the `human-approved` label.
- Do not weaken, skip or delete a test to make a check pass.
- Do not edit `.github/`, `.claude/agents/`, `.claude/settings.json`, `.claude/pipeline/`, `CLAUDE.md` or `tests/pipeline.test.js` unless the brief is about the pipeline itself. They are high tier by design.
- A missing check is a failure, not a pass.

## Escalation

After two failed fix rounds on the same problem, stop. Open a GitHub issue labelled `needs-human` with the failing command, the output (no client data) and what you tried. Do not widen scope to get unstuck.

## Definition of done

Every acceptance criterion in the brief has a passing check, `npm test` is green, the diff touches only owned files, and the PR body lists the risk tier printed by `risk-tier.mjs`.
