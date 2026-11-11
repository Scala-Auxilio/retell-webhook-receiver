# Handoff prompts for Claude Code

Two prompts. Start Claude Code in the root of retell-webhook-receiver. Run Part A once. Run Part B only after the one-time setup in `docs/pipeline/README.md` is complete and the foundation pull request is merged.

## Part A: finish the foundation branch (once)

Paste everything below the line.

---

You are finishing the agent pipeline foundation. Two workflow files are staged under `docs/pipeline/staged-workflows/` because the automation that built the branch could not write to `.github/workflows`. You have my git credentials, so move them.

1. Run `git fetch origin` and `git checkout agent-pipeline-foundation`, then `git pull`.
2. Run `mkdir -p .github/workflows`, then `git mv docs/pipeline/staged-workflows/judge.yml .github/workflows/judge.yml` and `git mv docs/pipeline/staged-workflows/tier-gate.yml .github/workflows/tier-gate.yml`. Change nothing inside them.
3. Run `npm install --no-audit --no-fund --no-package-lock` and `npm test`. All tests must pass. If any fails, stop and show me the output. Do not edit tests to make them pass.
4. Stage files explicitly with `git add .github docs`. Never stage `node_modules`. Commit with the message "Move staged workflows into .github/workflows" and push the same branch.
5. Open a pull request from `agent-pipeline-foundation` to `main` if none exists. Do not merge it and do not add labels.
6. Report: the PR link, the test count, and the checks that ran. The `judge` check is expected to fail closed until the secret and variable in `docs/pipeline/README.md` are set. Say what you saw.

## Part B: run brief 001 through the pipeline

Paste everything below the line.

---

You are running brief 001 through the agent pipeline in this repository. Work autonomously. Do not ask me questions unless a stop condition below is hit.

Read first, in this order: `CLAUDE.md`, `docs/pipeline/README.md`, `.claude/briefs/001-nl-manual-caution-flag.md`.

Preconditions. Verify each and stop with a clear report if any fails:
1. You are on `main`, up to date with `origin/main`, working tree clean.
2. `.claude/agents/` contains planner, decomposer, builder, judge and releaser, and `.github/workflows/` contains `judge.yml` and `tier-gate.yml`.
3. `npm install --no-audit --no-fund --no-package-lock` and `npm test` pass on `main`. Record the number of passing tests as the baseline.

Run:
1. Create branch `agent/001-nl-manual-caution-flag` from `main`.
2. Use the `planner` subagent on the brief. Commit its output under `.claude/runs/001/`. If it wrote QUESTIONS.md, stop and show me the questions.
3. Check PLAN.md yourself: every acceptance criterion is mapped to a task and a runnable command, the risk tier is medium or lower, and "Out of scope, noticed" is filled in. If not, send it back to the planner once. If it is still wrong, stop.
4. Use the `decomposer` subagent. Commit `tasks.json`.
5. For each task in dependency order, use one `builder` subagent on the same branch. Commit after each task with a message naming the task id.
6. Before opening the PR, run `npm test` and `git diff --name-only origin/main...HEAD`. Every changed file must be in the brief's "Files in scope". If not, fix it.
7. Open one pull request against `main`. The body lists the brief id, the tasks, the proving commands with results, the baseline and final test counts, and the output of `node scripts/pipeline/risk-tier.mjs --base origin/main --head HEAD`.
8. Wait for CI with `gh pr checks --watch`. Required checks: `test`, `judge`, `tier-gate`.
9. If a check fails, read why (`gh run view` on the failed run), fix it with a `builder` subagent and push. Allow two fix rounds in total. After the second failure, open a GitHub issue labelled `needs-human` with the failing command and output, then stop.
10. When all three checks are green and the tier is medium or lower, use the `releaser` subagent to enable auto-merge. If the tier is high, stop and tell me the PR is waiting for the `human-approved` label.

Hard rules:
- Never push to `main`, never force push, never add labels, never edit anything under `.github/`, `.claude/agents/`, `.claude/pipeline/`, `.claude/settings.json`, `CLAUDE.md`, `scripts/` or `tests/pipeline.test.js`.
- Never run `batch-caller.js`. No real client data in any file, message or PR text.
- Never weaken, skip or delete a test.

Final report, in plain text and under 200 words:
- PR link and the three check results.
- Baseline and final test counts.
- Every moment you wanted to ask me something or hit a gap, and which file (agent, brief or CLAUDE.md) should change so it does not happen again. Zero interventions is the goal.
- The "Out of scope, noticed" items from the plan.
