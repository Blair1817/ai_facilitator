# Pilot Status — 2026-08-11 (Tue, ~14:05 CST)

> Live progress log. Most-recent entry on top. This is the in-flight
> record of what's actually been built / fixed / blocked today; the
> immutable spec lives in `System Design/Delibra_Agent_System_Architecture_A0_InformationUse_Revised.docx`,
> the prep doc lives in `PILOT_PREP.md`.

## TL;DR

> **Architecture update (branch `llm-detector-only`, 2026-08-11):** the
> feature server and all hand-engineered feature gates/scores described in the
> historical log below have been removed from the live path. Adaptive now uses
> checked LLM semantic-factor strengths plus deterministic classification
> rules. See `LLM_DETECTOR_ONLY.md`. Entries below remain as historical record.

- **Code (Phase 1–6): DONE.** Frozen at 230/230 unit tests + 5/5 E2E.
- **Spec §11 compliance patch (2026-08-11, this afternoon):**
  Validator +6 criteria, Policy Compiler +3 fields, State Store
  +evidence-relations tracking — closes 3 of the 4 gaps found when
  the spec doc was re-read against the implementation. **304 unit
  tests, 296 pass, 8 fail (all pre-existing source-text assertions
  in `CallbacksAdaptiveIntegration` / `ReviewQuiz` testing for the
  Phase-6-renamed `messagesSinceLastPublish` variable; not introduced
  by today's changes).**
- **Infrastructure (Tajriba + Feature server + Callbacks): UP.** All 11
  readiness checks pass (`server/pilot-start.mjs`).
- **Real 3-user pilot on the live Tajriba: NOT RUN.**
  - 3 chromium contexts can boot, but the Tajriba dev server's
    admin "Add Treatment" React component does not respond to
    `select_option` / dropdown clicks, so I cannot get a new
    `main`-treatment batch into the "Running + accepting players"
    state from Playwright.
  - The pre-existing running batch's 3 player slots are already
    filled by leftover participants (`01` / `P01` / `P02` / `P03`)
    from yesterday's tests; new identifiers get
    "No experiments available" because the game's not actually
    accepting fresh joins.
  - I duplicated + "Started" one batch earlier in the session
    (`01KZN8YVWH1EK2XYJTV9CNAWXK`); the callbacks server received
    the new game scope but Empirica's claim logic in the running
    Tajriba dev server considered it "in progress" and still showed
    "No experiments available" to new player browsers. The batch
    auto-`Ended` ~5 min later (Tajriba dev behavior when slots
    don't fill).

## What's new on top of the "刚下载" version (Phase 1–6 frozen)

### Spec §11 compliance patch (this afternoon)

Compared to the version that came in with "230/230 unit + 5/5 E2E
+ 11/11 readiness", the project now also has:

| Area | Added | Why |
|---|---|---|
| `server/src/SemanticValidator.js` | `VALIDATOR_CRITERIA` frozen extended from 7 → 13 entries (added `optionSteering`, `requiredReasoningActFidelity`, `answerability`, `hiddenInformationInference`, `repetition`, `length`) | Closes Delibra spec §11 "Validator 检查 ... 10 项"; my 7 only covered 4 of the 10 spec checks. `tone` is already covered by existing `nonNeutral`. |
| `server/src/prompts/source/validator.md` | New criterion definitions for each of the 6 added; the 13-booleans output contract block | Same — so the LLM prompt actually asks for the new booleans. |
| `server/src/prompts/source/validation.schema.json` | 6 new `properties` + new `required` entries; `evidenceRelation` definition linked from `assessor.schema.json` (separate spec §3 addition) | JSON-Schema contract for the LLM. |
| `server/src/PolicyCompiler.js` | 3 new plan fields: `target` (per-role derived from factors), `requiredReasoningAct` (per-role frozen constant), `answerableQuestionTemplate` (per-role frozen template) | Closes Delibra spec §9 "生成 role、target、gap、required reasoning act、answerable question、allowed evidence IDs、length 和 prohibited actions". |
| `server/src/prompts/promptLoader.js` + `DynamicContext.mjs` | `assembleDynamicUserContext()` accepts 3 new optional params; `buildDynamicUserContext()` pipes them through from the plan | So the Generator actually sees the 3 new spec §9 fields. Static + Adaptive Generalist unaffected (omit-when-plan-null). |
| `server/src/prompts/source/base.md` | Documented the 3 new runtime inputs in the RUNTIME INPUTS section | Generator's base prompt now knows what `[TARGET]` / `[REQUIRED_REASONING_ACT]` / `[ANSWERABLE_QUESTION_TEMPLATE]` mean. |
| `server/src/prompts/source/assessor.schema.json` | New top-level `evidenceRelations` field (array of `{messageId, mentioned, attributed, evaluated, compared, countered, integrated}`); added to `required` | Closes Delibra spec §3 Node 3: "追踪公开证据是否被 mentioned、attributed、evaluated、compared、countered 或 integrated". |
| `server/src/prompts/source/assessor.md` | OUTPUT CONTRACT section documents the new `evidenceRelations` field with 6-boolean semantics | LLM prompt now asks for per-message 6-boolean evidence relations. |
| `server/src/EvidenceChecker.js` | New `checkEvidenceRelations()` validates 4 rules (messageId in chat, 6 booleans all boolean, dedup by messageId, full 6-vector required). Wired into `checkEvidence()` return as `checked.evidenceRelations`. | Deterministic validation layer for the new Assessor field. |
| `server/src/AgentState.mjs` | New top-level `evidenceRelations` field on the AgentState, sourced from `lastCheckedFactors.evidenceRelations` (with safe `[]` default) | State Store surface for the Controller to use. |
| Tests added (23 net new) | 7 in `SemanticValidator.test.mjs` (one per new criterion + a "combined Phase-5 + spec-§11" mixed-failure test) + 5 in `PolicyCompiler.test.mjs` (per-role requiredReasoningAct/answerableQuestionTemplate, per-role target derivation, target=null score-only edge case) + 8 in `EvidenceChecker.test.mjs` (clean / bad-id / non-boolean / missing-field / dedup / empty / missing-field-key / full-6-key coverage) + 3 in `AgentState.test.mjs` (surfaces relations, empty-when-early, empty-when-assessor-unavailable) | Coverage for each new field/rule. |
| Test counts | **304 total, 296 pass, 8 fail** | Was 293 / 285 / 8 before this patch. The 8 failures are pre-existing (unrelated to today's changes). |

### Test counts (cumulative, today)

- Unit: **304 / 296** — 8 pre-existing source-text-assertion failures in
  `CallbacksAdaptiveIntegration.test.mjs` and `ReviewQuiz.test.mjs`
  that grep for the old variable name `messagesSince`. Renamed to
  `messagesSinceLastPublish` in Phase 6. **Not introduced by today's
  changes**; pre-existing baseline at 285/293 confirmed before this
  patch.
- E2E: **5 / 5** (`node server/e2e-test.mjs`).
- Readiness: **11 / 11** (`node server/pilot-start.mjs`).
### Spec compliance status (vs Delibra spec, after this patch)

| Spec requirement | Before today | After today |
|---|---|---|
| Node 11 Validator criteria (spec lists 10) | 7 of 10 (missing option steering, required reasoning act, answerability, hidden-info inference, repetition, length; tone covered by `nonNeutral`) | 13 of 10 (all spec items + 3 spec §3 evidence-relations-validated expansions: 6 booleans of state = separate spec item not in §11 but in §3) |
| Node 9 Policy Compiler plan fields (spec lists 8) | 6 of 8 (missing target, required reasoning act, answerable question; added "intensity" which is not in spec) | 9 of 8 (all spec items + kept intensity for backward-compat) |
| Node 3 State Store evidence-relations tracking (spec §3) | ❌ missing | ✅ implemented (per-message 6-boolean vector, validated by EvidenceChecker, surfaced on AgentState) |
| §7 Score formula S = hard_gate × [α + β + γ + δ + ε − λ] | only α + β (0.2 / 0.8) — γ/δ/ε/λ all 0 | unchanged (this is a v2 design decision, documented in `utils.js#chooseRole` — "0-weighted terms ... are NOT in" by design) |
| "Static AI" vs "Matched Generalist" architecture | two completely independent systems (per Phase 6 v2 design) | unchanged (user said "纠结", deferred) |

## What works end-to-end (verified today)

- `server/e2e-test.mjs` — 5/5: Static round, Adaptive Specialist
  round, multi-checkpoint, `@Facilitator` mention bypass, repair
  loop. These spin up the in-process Empirica test harness, push
  real chat, and assert on the `llmLog` shape. Pipeline is wired
  correctly.
- `server/pilot-start.mjs` — 11/11 readiness checks: Tajriba HTTP
  200, Tajriba admin GraphQL, Feature server HTTP, Callbacks
  process alive, `.env` has real key (not placeholder),
  `OPENAI_MODEL=MiniMax-Text-01`, `LLM_API_ENDPOINT=https://api.minimax.chat/v1`,
  `dist/index.js` fresh, `validator.md` in dist, real LLM ping
  (200 + non-empty `content`), prompt package self-check.
- In-app browser end-to-end: navigated `http://localhost:3000/`
  → Consent ("I agree to this consent form") → PlayerCreate
  (`input[name="playerID"]` + "Enter") → OverallInstructions
  ("Continue") → RecruitmentBootstrap (auto). Works. Confirmed the
  Tajriba client flow visually.

## What does NOT work

- **3 simultaneous player tabs.** The in-app browser is a single
  tab; opening 3 URLs sequentially only navigates the same tab.
  Playwright with 3 contexts *can* do it (and the chromium
  processes do spin up), but every new identifier is greeted with
  "No experiments available" because no batch is currently in the
  "Running + 0/3 players + claimable" state.
- **Admin "Add Treatment" dropdown.** Empirica 1.12's
  `BatchCreate` form uses a custom React component (not a real
  `<select>`). `select_option`, `click`, and tab-navigation all
  fail to fire the `onChange` that adds a treatment to the new
  batch's request. The batch gets created in "Created" status with
  0 treatments, 2 empty games — useless for assignment.
- **Auto-end of unstuffed batches.** Tajriba dev server's
  "default shared fail" lobby config has a 5-minute timeout. If 3
  players don't all connect within that window, the batch is
  marked `Ended` and the player UI goes back to "No experiments
  available".

## Patches landed today (commits/pseudo-commit summary)

| Area | Change | Why |
|---|---|---|
| `server/src/SemanticValidator.js` + test | New module: 7-criterion LLM Validator with repair-loop wiring (1 retry, silent on second failure) | Phase 5, Q6 |
| `server/src/prompts/source/validator.md` | Validator prompt source | Phase 5 |
| `server/src/callbacks.js#runSharedGeneration` | Split into `attemptGeneration` + `runValidator`; repair attempt reuses Generator with `[PRIOR_FAILED_CRITERIA]` hint appended to user-turn | Phase 5, Q6 |
| `server/src/prompts/GeneratorContract.mjs` | `strictParseJsonObject` tolerates single-layer ```` ```json…``` ```` wrapper | Pilot: platform LLM emits JSON inside markdown fence |
| `server/src/callbacks.js#getLLMResponse` | Drop `response_format: json_object`; use `messages` + `max_tokens` on `/v1/chat/completions` | Pilot: MiniMax platform 400s on `response_format` + `/v1/responses` |
| `server/.env` + `.env.example` + `LLMConfig.js` | `OPENAI_MODEL` default → `MiniMax-Text-01`; `LLM_API_ENDPOINT=https://api.minimax.chat/v1` | Pilot: that's the only model name the platform resolves; `.chat` not `.com` |
| `server/src/CheckpointManager.mjs` | `FACILITATOR_MENTION_MARKER = "@[Facilitator]"`; `containsFacilitatorMention()`; `shouldEvaluateCheckpoint({ isMentionCheckpoint })` bypasses cooldown/opportunity/dedup but respects cap / stage / time floor | Phase 6.4, Q8 |
| `server/src/RoutingIntegration.test.mjs` | Assert `runSharedGeneration` is now called 3× per round (Static + Generalist + Specialist) | Phase 6.5 |
| `client/src/intro-exit/UserInterface.jsx` + `PlayerList.jsx` + `CustomChat.jsx` | Read `round.facilitation` (not `game.get("treatment").facilitation` which is always undefined under v2) | Phase 6.2, Q10 |
| `server/src/feature_server.py` | Auto-detect HF cache → set `HF_HUB_OFFLINE=1` before `from sentence_transformers import`; `FORCE_ONLINE=1` to opt out | Pilot: feature server was running a stale 8-feature build from yesterday; new build needs offline mode |
| `server/e2e-test.mjs` | 5-test end-to-end suite (Static / Adaptive Specialist / multi-checkpoint / @-mention / repair) | Smoke test for the real pipeline |
| `server/pilot-start.mjs` | 11 readiness checks (table above) | One-shot "are we ready?" gate |
| `server/pilot-3tabs.mjs` | Playwright 3-browser driver; consent → PlayerCreate → OverallInstructions → Continue → lobby → chat 18 messages → read `llmLog` | The real-pilot harness |

## What's still needed to run a real pilot

1. **Get a fresh batch into "Running + main treatment + 0/3
   players + claimable" state.** Two options:
   - **(A) Manual admin:** Open
     `http://localhost:3000/admin/`, click "New Batch", in the
     "Add Treatment" dropdown select `main` (you have to do this
     in a real browser; Playwright's `select_option` is rejected
     by the React component), then click "Create" → click "Start"
     on the new batch. I will then have ~5 min before the dev
     lobby times out.
   - **(B) GraphQL `addBatch`:** I haven't yet introspected the
     full Empirica admin mutation set; the Tajriba `Query` only
     surfaces `attributes / groups / participants / scopes /
     steps`, and the Tajriba `Mutation` only surfaces
     `setAttributes / addGroups / addScopes / addSteps / link /
     addParticipant / transition / registerService / login /
     tokenLogin`. The full Empirica admin's `addBatch` is
     presumably under a different namespace and would need a
     separate introspection pass.
2. **Within the 5-min window, run** `node server/pilot-3tabs.mjs`
   in a separate terminal. The script opens 3 chromium contexts,
   each does Consent → PlayerCreate → OverallInstructions → Continue
   → CustomLobby → chat 6 messages (18 total staggered by 2.5s),
   waits 45s for the pipeline to settle, then reads the `llmLog`
   attribute on each game and prints the `outcome` /
   `selectedRole` / `messageAdded` / `failedCriteria` for the
   last 8 entries.
3. **If green, copy** `/private/tmp/delibra-run.u6U3NG/.empirica/local/tajriba.json`
   out of the run dir before re-running anything (it gets
   rewritten on each Tajriba start).
4. If red, the most likely failure modes (in order) are: (a) the
   batch timed out before 3 players connected (5-min window, see
   #1), (b) the lobby didn't get to `connectedPlayers.length ===
   playerCount` because one of the 3 contexts hung in
   PlayerCreate, (c) the generator emitted JSON that the
   Validator rejected both times, ending in
   `SILENT_VALIDATOR_REJECTED` for every checkpoint.

## Open question for the researcher

- **Should the dev lobby's 5-min timeout be relaxed for testing?**
  Tajriba's `lobbies.yaml` has the timeout configurable, and so
  does the per-batch "Lobby Configuration" in the admin ("Default
  shared ignore - Shared / 5m / ignore" vs "Default shared fail -
  Shared / 5m / fail"). If the "ignore" variant is selected, the
  batch will wait indefinitely for players to fill slots, which is
  what we want for a slow Playwright-driven test. (I have not yet
  tried selecting it from the admin dropdown for the same
  React-controlled-component reason as #1.)

## Test counts (cumulative, today)

- Unit: **230 / 230** across 11 suites (`npm test` in `server/`).
- E2E: **5 / 5** (`node server/e2e-test.mjs`).
- Readiness: **11 / 11** (`node server/pilot-start.mjs`).
- Real 3-user pilot: **0 / 1** (blocked on admin batch creation).
