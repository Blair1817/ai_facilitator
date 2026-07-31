# Migration from chloe/2nd-experiment-flow (old 2nd) onto Blair's latest main

## Baseline

- New branch: `2nd-experimental-workflow`, based on `origin/main` @ `afcb2ac3c3d92c3f8365a04505e14c116e13aa23` ("fix: resolve two backend blockers for two-round experiment", Blair Xu, 2026-07-29).
- Old reference (read-only, not deleted): `/Users/apple/ai_facilitator`, branch `chloe/2nd-experiment-flow`, HEAD `c42385c` + uncommitted working-tree changes documented in that worktree's `TEMP_DEMO_BACKEND_CHANGES.md`.
- Old 2nd has zero commits unique from Blair's main; all of its value was in its uncommitted working tree.

## What Blair's afcb2ac already provides (not migrated, already there)

- Real `facilitationOrder` randomization (`Math.random() < 0.5 ? [...] : [...]`) — kept as-is.
- Real `taskOrder` randomization (`Math.random() < 0.5 ? [0,1] : [1,0]`) — kept as-is, only the assignment bug below was fixed.
- `decisionOptions` as a real `{id, label}` array in `HPTConfig.json`, written via `round.set("decisionOptions", ...)` in `onRoundStart` — kept as-is; old 2nd's hardcoded `TEMP_DEMO_DECISION_OPTIONS` string-array patch was **not** migrated (obsolete, superseded).

## Bug found in Blair's afcb2ac itself (not from old 2nd — found during this migration's audit)

`onGameStart` had:
```js
round2.set("facilitation", facilitationOrder[1]);
// round2.set("taskIndex",    1);
round1.set("taskIndex", taskOrder[1]);   // <- copy-paste bug: wrong target (round1, not round2)
```
This meant Round 2's `taskIndex` was **never set** (permanently `undefined`), which makes `onRoundStart`'s `taskConfig["tasks"][taskIndex]` lookup fail and return early — Round 2 would never get `generalInfo`/`decisionOptions`/player content. Confirmed via `git show afcb2ac -- server/src/callbacks.js`, not assumed. **Fixed** to `round2.set("taskIndex", taskOrder[1])`.

## Migrated from old 2nd (all re-verified against Blair's actual current code, not blindly copied)

| Change | File | Why |
|---|---|---|
| ESM/CommonJS `createRequire` banner | `server/package.json` | Without it, `callbacks` subprocess crashes on boot with `require is not defined` — confirmed this crash is still present in Blair's afcb2ac (unchanged `package.json`), same root cause as originally found in old 2nd. |
| Static/Adaptive+role prompt content | `server/src/LLMConfig.js` | Blair's afcb2ac still has the old `{LLM, human}` templates; `callbacks.js` calls `llmSystemPrompts(facilitation, role)` with `"static"`/`"adaptive"`, which still resolves to `undefined` without this fix. |
| Round-scoped `generalInfo` | `server/src/callbacks.js` (`onRoundStart`) | Blair fixed `decisionOptions` scoping but not `generalInfo` — still `game.set(...)`, same cross-round overwrite risk. |
| `taskVersion` per round | `server/src/callbacks.js` (`onGameStart`) | Never set in Blair's version; `InitialDecision.jsx`/`FinalDecision.jsx` read `round?.get("taskVersion")` for the decision record. Derived from the (now-fixed) real `taskOrder`, not hardcoded. |
| Stable game-level alias assignment (`profileSlot`) | `server/src/callbacks.js` (`onGameStart` + `onRoundStart`) | Blair's `onRoundStart` still reshuffles `name`/`hexCode`/`playerContent` every round — same regression as before (a participant's Red/Pink/Green could change between Round 1 and Round 2). |
| Round-aware transition text + remount keys | `client/src/Game.jsx` | Not in Blair's afcb2ac at all. |
| `chat_round_${roundIndex}` attribute | `client/src/stages/Discussion.jsx` | Not in Blair's afcb2ac; without it, chat messages never reach `callbacks.js`'s `chat_round_0`/`chat_round_1` listeners in either round. |

## New adaptation required (not a blind migration — old 2nd's code assumed plain-string options, Blair's are `{id, label}` objects)

`client/src/stages/InitialDecision.jsx`, `FinalDecision.jsx`, `Discussion.jsx`:
- Field name changed from old 2nd's `taskDecisionOptions` to Blair's actual `decisionOptions`.
- Rendering changed from treating `option` as a string to `option.label` for display, `option.id` for the button `key`, selection state, and the saved decision record (`decision: selectedOption` where `selectedOption` now holds `option.id`).
- `Discussion.jsx`'s "Options under discussion" summary changed from `decisionOptions.join(", ")` to `decisionOptions.map(o => o.label).join(", ")`.

## Explicitly NOT migrated (old 2nd regressions/temp-only code, must not come back)

- `TEMP-BE-001` (hardcoded `facilitationOrder`) — Blair's real randomization is better, kept.
- `TEMP-BE-002` (`TEMP_DEMO_DECISION_OPTIONS` hardcoded string array) — superseded by Blair's real `{id,label}` schema.
- Per-round `_.shuffle(task["playerConfig"])` re-assigning `name`/`hexCode` — this was the regression itself, removed, not migrated.
- Flat `player.set("playerContent", ...)` — replaced with `player.round.set(...)`.
- `game.set("treatment").facilitation` reads anywhere — not touched, not reintroduced (already absent from `treatments.yaml`, matches old 2nd's finding, not re-litigated this task).

## `profileSlot` vs `aliasSlot`

Kept as a single field (`profileSlot`), assigned once in `onGameStart`, reused in `onRoundStart` to look up per-round private content. `HPTConfig.json` has no separate concept of an "information role" distinct from `playerConfig` array position — Task A and Task B's playerConfig entries are matched 1:1 by index (index 0 = Red/FF0000 in both tasks). There is nothing to decouple with the current data model. If a future task design needs a participant's information role to change independently of their visible color across rounds, `aliasSlot` (game-level, stable) and `profileSlot` (round-level, reassignable) would need to become two separate fields — flagged here for whoever owns that future design, not implemented speculatively.
