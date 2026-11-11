# Brief 001: NL manual-caution compliance flag

Status: ready for planner
Owner: Petrus
Expected tier: medium

## Goal

Every auto-scored call to a Netherlands number (country code +31) gets the flag `nl_manual_caution` in `interaction_scores.flags`, because no Netherlands do-not-call list is wired in yet and NL numbers need manual caution. A number that cannot be parsed is flagged as well, with reason `unparseable`, because no number is assumed safe to call.

## Constraints

- The detection is a pure function in a new module `compliance-flags.js`: no network, no database, no environment reads, never throws.
- Do not change the rubric, tiering, prompts or any other scoring behaviour.
- Auto-scored rows currently store `flags` as an empty object (`JSON.stringify({})`), while the manual scoring route and the flag-frequency query treat `flags` as an array. New code must store an array. The plan must record this shape change under "Decisions" and must not touch the manual route or the stats query. Any related bug found goes under "Out of scope, noticed".
- No real phone numbers, names, emails, transcripts or call ids anywhere. Use fake numbers such as `+31600000000`.
- The code must not log or print phone numbers.
- Tests make no network calls and use no real database.

## Files in scope

- `compliance-flags.js` (new)
- `tests/compliance-flags.test.js` (new)
- `interaction-scorer.js`, only the lines in `scoreAndPersist` that build the `flags` value passed to the INSERT
- `.claude/runs/001/**` (plan, tasks, release note)

## Acceptance criteria

1. `node --test tests/compliance-flags.test.js` exits 0 and runs at least 10 synthetic cases.
2. E.164 Netherlands numbers are flagged `nl_manual_caution`, also when written with spaces or dashes and with the `0031` prefix.
3. Non-NL numbers are not flagged, including Belgium (+32), the UK (+44), Italy (+39) and the US (+1).
4. Empty string, null, undefined, a number type, an object and the text `abc` return a flag with reason `unparseable` and never throw.
5. `npm test` exits 0, and the only new test file is `tests/compliance-flags.test.js`.
6. `git diff --name-only origin/main...HEAD` lists only the files in scope.
7. `node scripts/pipeline/risk-tier.mjs --base origin/main --head HEAD` reports a tier of medium or lower.
8. The judge check returns pass and the tier-gate check is green.

## Notes for the planner

The `to_number` value comes from the Retell call record that `scoreAndPersist` already fetches, so no new data source is needed. `batch-caller.js` has a phone normaliser for Dutch local formats. It is high tier and out of scope, so read it for reference only and do not import or change it.
