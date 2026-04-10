# Aria Number Flip Endpoints — Implementation Plan
Date: 2026-04-10

## Goal
Give Scala Auxilium a safe, human-gated way to run the April 14 pilot with a single Dutch phone number shared between Aria EN and Aria NL agents, until VoIPStudio provisions a second NL DID.

## Approach
Add two tiny HTTP endpoints (`/aria/set-agent`, `/aria/binding-status`) and a warning check inside the existing `/zoho/aria-trigger` dispatcher. Piet manually controls when the NL number is bound to the EN agent versus the NL agent, using the same `NOTIFY_SECRET` auth header as the rest of the endpoints. A single feature flag `ARIA_FLIP_MODE` toggles the whole behaviour off in one env-var change the moment the second NL number lands.

No timers. No auto-unflip. No heartbeat. The operator is the safety net; the code just exposes the primitives they need and logs every change to the `notifications` table for audit.

## Files
- **Modify:** `C:\retell-repo\index.js` — add two helper functions, two HTTP endpoints, and a warning check in the existing `/zoho/aria-trigger` handler. Add `ARIA_FLIP_MODE` to the env var list.
- **Create:** `C:\retell-repo\tests\smoke_aria_flip.js` — standalone Node script (same pattern as `check_run2.js`) that exercises both new endpoints end-to-end against the live Railway deployment. No test runner dependency.
- **Modify:** Railway env vars — add `ARIA_FLIP_MODE=true` (via Piet or the Railway CLI; documented in this plan).
- **No changes to:** `batch-caller.js`, Zoho Flow, Retell agent configs.

## Constants
- Aria EN agent ID: `agent_aa56b68b02f6de4ac5725a829b`
- Aria NL agent ID: `agent_e1e1f763101db5abe0df281891`
- NL DID: `+31207163656`
- Retell API: `https://api.retellai.com`

---

## Tasks

### Task 1: Add Retell binding helper functions

**What this does:** Gives us two reusable helpers — one to read the current outbound agent bound to the NL number, one to set it. Used by both new endpoints and by the warning check.

**Files involved:**
- Modify: `C:\retell-repo\index.js`

**Steps:**
- [ ] Write the smoke-test assertion first in a scratch script: "calling `getCurrentNLNumberBinding()` should return an object with `phone_number: +31207163656`, `outbound_agent_id: agent_e1e1f763101db5abe0df281891` (or the EN id), and `agent_label: 'Aria EN' | 'Aria NL'`."
- [ ] Run the scratch script — confirm it fails (function doesn't exist yet).
- [ ] Add `ARIA_NL_DID` const near the top of `index.js` next to the existing agent constants, with value `+31207163656`.
- [ ] Add `AGENT_LABELS` const mapping `{ "agent_aa56b68b02f6de4ac5725a829b": "Aria EN", "agent_e1e1f763101db5abe0df281891": "Aria NL" }`.
- [ ] Write `async function getCurrentNLNumberBinding()` that calls Retell's `POST /list-phone-numbers`, finds the entry matching `ARIA_NL_DID`, and returns `{ phone_number, outbound_agent_id, agent_label }`. Throw a clear error if the number isn't found.
- [ ] Write `async function updateNLNumberBinding(targetAgent)` where `targetAgent` is `"EN"` or `"NL"`. Resolve the agent ID, call Retell's `PATCH /update-phone-number/{phone_number}` with `{ outbound_agent_id }`, then call `getCurrentNLNumberBinding()` to verify and return the new state.
- [ ] Re-run the scratch script — confirm it passes.
- [ ] Verify: curl the scratch helper, see `Aria NL` returned (since that's the current rest state).

**Done when:** Both helpers exist in `index.js` and a scratch call returns the correct current binding.

---

### Task 2: Add POST /aria/set-agent endpoint

**What this does:** Lets Piet (or the assistant on his behalf) flip the NL number between Aria EN and Aria NL with a single HTTP call. Protected by `NOTIFY_SECRET`. Logs every change to `notifications`.

**Files involved:**
- Modify: `C:\retell-repo\index.js`

**Steps:**
- [ ] Add test assertion to the scratch smoke script: "POST `/aria/set-agent` with `{ agent: 'EN' }` returns HTTP 200 and a body where `binding.agent_label === 'Aria EN'`."
- [ ] Run the smoke script — confirm it fails (404, endpoint doesn't exist).
- [ ] Add the endpoint handler near the existing Aria routes in `index.js`. Accept `POST`. Require header `x-notify-secret: <NOTIFY_SECRET>`; return 401 on mismatch.
- [ ] Guard with `if (process.env.ARIA_FLIP_MODE !== "true") return res.status(403).json({ error: "ARIA_FLIP_MODE disabled" });`.
- [ ] Validate body: `agent` must be `"EN"` or `"NL"`; reject others with 400.
- [ ] Call `updateNLNumberBinding(agent)`, capture the new state.
- [ ] Insert a row into `notifications`: `subject: "Aria number rebound to {agent_label}"`, `body: JSON.stringify({ previous_agent, new_agent, triggered_by })`, `source: 'aria_binding_change'`, `status: 'logged'`, `priority: 'medium'`.
- [ ] Return `{ ok: true, binding: { ... }, timestamp }`.
- [ ] Wrap in try/catch; on Retell error, return 500 with the error body.
- [ ] Re-run the smoke script — confirm it passes.
- [ ] Verify: curl the endpoint twice (EN then NL), then read the `notifications` table to confirm both audit rows exist.

**Done when:** The endpoint flips the binding, returns the new state, and writes an audit row — verified end-to-end against production Railway.

---

### Task 3: Add GET /aria/binding-status endpoint

**What this does:** Read-only endpoint to answer "what is the NL number currently bound to, and when did it last change?" Safe to call any time, no side effects.

**Files involved:**
- Modify: `C:\retell-repo\index.js`

**Steps:**
- [ ] Add test assertion: "GET `/aria/binding-status` returns HTTP 200 with `current.agent_label`, `current.phone_number`, and `last_change` (may be null if no audit rows exist)."
- [ ] Run the smoke script — confirm it fails.
- [ ] Add the GET handler. Require the same `x-notify-secret` header.
- [ ] Guard with `ARIA_FLIP_MODE` (return 403 if disabled, so the endpoint is "invisible" in normal mode).
- [ ] Call `getCurrentNLNumberBinding()` for the live state.
- [ ] Query `SELECT created_at, body FROM notifications WHERE source = 'aria_binding_change' ORDER BY id DESC LIMIT 1` for the most recent change.
- [ ] Return `{ current: { phone_number, outbound_agent_id, agent_label }, last_change: { timestamp, details } | null }`.
- [ ] Re-run the smoke script — confirm it passes.
- [ ] Verify: curl the endpoint, sanity-check the payload shape.

**Done when:** The endpoint reliably reports current binding state plus the last audit row.

---

### Task 4: Add warning check to /zoho/aria-trigger

**What this does:** Prevents silent mistakes. If Piet fires a dispatch for an EN lead while the number is bound to NL (or vice versa), the handler refuses the call and returns a clear error telling him to flip first. Does NOT auto-correct.

**Files involved:**
- Modify: `C:\retell-repo\index.js`

**Steps:**
- [ ] Add test assertion: "POST `/zoho/aria-trigger` with a Ready-for-Aria-EN lead while bound to NL returns HTTP 409 with `error: 'binding_mismatch'` and `current_agent: 'Aria NL'`."
- [ ] Run the smoke script — confirm it fails (current behaviour dispatches without checking).
- [ ] Inside the `/zoho/aria-trigger` handler, after determining `requiredAgent` from `Aria_Status` (existing logic), and **only if `ARIA_FLIP_MODE === "true"`**, call `getCurrentNLNumberBinding()`.
- [ ] If `required !== current`, return 409 with `{ error: "binding_mismatch", required_agent, current_agent, hint: "Call POST /aria/set-agent to flip before dispatching." }`. Do not call Retell. Do not modify Zoho.
- [ ] If they match, proceed with the existing dispatch logic unchanged.
- [ ] Re-run the smoke script — confirm it passes.
- [ ] Verify: while bound to NL, POST an EN-ready lead, 409 response. Then flip to EN via `/aria/set-agent`, POST again, success.

**Done when:** A mismatched dispatch is blocked at the door with a clear, actionable error, and a matched dispatch still works exactly as before.

---

### Task 5: Deploy and set ARIA_FLIP_MODE=true on Railway

**What this does:** Pushes the code and turns the feature on in production.

**Files involved:**
- No file changes. Git push + Railway env var change.

**Steps:**
- [ ] Run `node --check index.js` — confirm syntax clean.
- [ ] `git add index.js tests/smoke_aria_flip.js docs/plans/2026-04-10-aria-number-flip-endpoints.md`.
- [ ] `git commit -m "feat(aria): single-number flip endpoints for pilot"`.
- [ ] `git push origin main` — Railway auto-deploys in ~45s.
- [ ] Ask Piet (or use the Railway CLI if available) to set `ARIA_FLIP_MODE=true` in Railway environment variables. Confirm the redeploy that follows.
- [ ] Hit `/health` — confirm `status: healthy`.
- [ ] Hit `/aria/binding-status` with the `NOTIFY_SECRET` — confirm it returns current state (should be `Aria NL`).

**Done when:** Railway is running the new code, `ARIA_FLIP_MODE=true` is live, and the status endpoint confirms the rest-state NL binding.

---

### Task 6: End-to-end smoke run

**What this does:** Final proof that the whole flow works before Monday's pilot.

**Files involved:**
- Use: `C:\retell-repo\tests\smoke_aria_flip.js`

**Steps:**
- [ ] Run the smoke script end-to-end:
  1. GET binding-status, expect `Aria NL`.
  2. POST set-agent `EN`, expect new state `Aria EN`.
  3. GET binding-status, expect `Aria EN` and an audit row.
  4. POST set-agent `NL`, expect new state `Aria NL`.
  5. GET binding-status, expect `Aria NL` and a newer audit row.
- [ ] Manually: move a test lead (e.g. Rogier) to `Ready for Aria EN` in Zoho, confirm the dispatch endpoint correctly 409s while bound to NL.
- [ ] Flip to EN, retry dispatch, confirm call fires.
- [ ] Flip back to NL. Confirm binding is restored.
- [ ] Document a one-liner "runbook" for Piet: the exact commands he'll use Monday morning to flip and dispatch batches.

**Done when:** The full flip, dispatch, verify, unflip cycle has been exercised once against the live production Railway + Retell and confirmed working on a real lead.

---

## Rollback Plan
If any of the above causes a regression:
1. Set `ARIA_FLIP_MODE=false` on Railway — all new behaviour becomes inert (endpoints return 403, warning check is skipped, dispatch reverts to original logic).
2. If that isn't enough, `git revert <commit>` and push.

## Out of Scope (will NOT touch)
- `batch-caller.js` internals
- The existing call_analyzed handler (patched separately in commits `31ee269` and `9c90065`)
- Zoho Flow triggers
- HMAC signature verification (post-pilot cleanup)
- `NO_ANSWER_DISPOSITIONS` cleanup (post-pilot cleanup)
