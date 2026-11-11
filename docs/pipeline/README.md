# Agent pipeline

A brief goes in, a merged pull request comes out, and a human only writes the brief and approves high-risk changes. Agents are files in `.claude/agents/`. State lives in `.claude/runs/<brief-id>/`. Rules live in `CLAUDE.md`.

```
brief -> planner -> decomposer -> builder(s) -> PR -> CI: test + judge + tier-gate -> releaser (auto-merge)
```

## What enforces what

| Concern | Enforced by | Where |
| --- | --- | --- |
| Tests decide, not opinions | Required check `test` | `.github/workflows/tests.yml` |
| Builder never grades itself | Judge runs in CI with no write tools and a JSON verdict | `.github/workflows/judge.yml`, `.claude/agents/judge.md` |
| A missing verdict is a failure | `evaluate-verdict.mjs` exits 1 on empty or malformed input | `scripts/pipeline/evaluate-verdict.mjs` |
| High-risk changes need a human | Required check `tier-gate` and the `human-approved` label | `scripts/pipeline/risk-tier.mjs`, `.claude/pipeline/risk-tiers.json` |
| Agents cannot loosen their own rules | Pipeline files are high tier | `.claude/pipeline/risk-tiers.json` |
| Dangerous commands | Deny rules | `.claude/settings.json` |
| Stop everything | Repository variable `AGENT_PIPELINE_ENABLED` not `true` makes the judge fail, so nothing auto-merges | `.github/workflows/judge.yml` |
| The gates themselves work | `tests/pipeline.test.js` includes planted failures | `tests/pipeline.test.js` |

## One-time setup (human only, in GitHub)

Until these are done the pipeline is advisory, because nothing forces a merge to wait for the checks.

0. The two workflow files could not be pushed by the automation that built this branch, because GitHub blocks writes to `.github/workflows` without a special token scope. They are staged in `docs/pipeline/staged-workflows/`. Move them with your own git credentials (Part A of `HANDOFF-PROMPT.md` does this for you in Claude Code). Until they are in `.github/workflows/`, `tests/pipeline.test.js` fails on purpose.
1. Settings, Secrets and variables, Actions, new repository secret `ANTHROPIC_API_KEY`. Use a dedicated key with a monthly spend limit set in the Anthropic console.
2. Same page, Variables, new repository variable `AGENT_PIPELINE_ENABLED` with value `true`.
3. Issues, Labels, create `human-approved` and `needs-human`.
4. Settings, Branches, add a rule for `main`: require a pull request, require status checks `test`, `judge` and `tier-gate`, require branches to be up to date, block force pushes, do not allow bypassing. As of this branch `main` is not protected.
5. Settings, General, enable "Allow auto-merge".
6. Check how `main` deploys on Railway. If a merge to `main` deploys to production automatically, then merging is releasing, and there is no staging step yet. Keep the human gate on high-risk changes until a staging and rollback path exists.
7. The foundation pull request changes pipeline files, so it is high tier: it needs the `human-approved` label from you and all three checks green before you merge it.

## What is not built yet

- Staging deploy, post-release smoke test and automatic rollback (the releaser stops at merge).
- Parallel builders in separate git worktrees. Version 1 runs tasks one after another on one branch.
- Spend alerts beyond the API key limit and `--max-turns` on the judge.
- Whether the judge job can start custom subagents is unverified. The workflow therefore tells the judge to read `.claude/agents/judge.md` as its instructions.
- The judge workflow has never run. Its `--allowedTools` and `--json-schema` arguments follow the action's documentation but are untested. The first pull request is the test. If the judge check errors, the gate fails closed, which is the intended behaviour.

## Things noticed while building this (not fixed here)

- Auto-scored rows store `flags` as `{}` while the stats query reads it with `jsonb_array_elements_text`, which expects an array. Not verified against the live database. Brief 001 touches this shape and must record it.
- `package.json` says Node 22, the Tests workflow uses Node 20.
- The repository has no `.gitignore`, so `node_modules` is not excluded.

## Reading a run

Open `.claude/runs/<brief-id>/`: PLAN.md, tasks.json, RELEASE.md. Every time a human had to step in, the cause is a missing or vague contract. Fix that file, not the run.
