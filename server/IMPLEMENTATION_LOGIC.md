# Delibra Adaptive Pipeline — Implementation Logic

This engineering reference describes the current server implementation. The
live Adaptive pipeline is LLM-semantic rather than feature-server based.

## Checkpoint and routing flow

`callbacks.js` receives canonical public Discussion messages and asks the
`CheckpointManager` whether the shared checkpoint trigger has fired. Static
and Adaptive use the same checkpoint schedule, but their post-trigger routes
are intentionally separate.

### Static

Static uses the fixed Static policy with the current round's shared task
overview, complete public transcript, and available timing context. It does
not run the Adaptive detector, Gate, Policy Compiler, or role selection.

### Adaptive

At an Adaptive checkpoint:

1. `SemanticAssessor.js` makes one LLM call over the public transcript and
   returns the schema-validated semantic discussion state.
2. `EvidenceChecker.js` verifies cited message IDs and exact spans, enforces
   the multi-participant requirement for group preference, validates
   message-level evidence relations, and applies the self-correction discount.
3. `utils.js`'s `evaluateGate()` classifies the checkpoint as `specialist`,
   `generalist`, or `abstain` using only checked semantic detector strengths,
   deterministic thresholds, and remaining time.
4. `chooseRole()` selects Expander, Challenger, or Synthesiser only for a
   specialist decision. A generalist decision uses the fixed Generalist policy;
   an abstain decision publishes nothing.
5. `PolicyCompiler.js` creates a bounded, evidence-grounded plan for a selected
   Specialist. The shared Generator and Validator path then produces and checks
   the candidate facilitator message before publication.

Detector failure is fail-closed: invalid or unavailable Semantic Assessor
output reaches the Gate as unavailable checked state and resolves to abstain.

## Detector state and research persistence

The `feature_snapshots` database table name is retained by the research schema,
but its content is checkpoint audit state from the current Adaptive pipeline:

- `semantic_assessor`: raw semantic factors or assessor error;
- `evidence_checker`: checked factors and validated evidence relations;
- `gate_state`: decision, reason, eligible roles, role scores, and per-role
  classification details.

It does not contain hand-engineered discussion features. Selected role,
publication outcome, and published message linkage live in `interventions`;
validated message-level relations live in `evidence_relations`. Static
checkpoints do not produce either Adaptive snapshot type.

## Current role and threshold rules

The selectable Specialist roles are `expander`, `challenger`, and
`synthesiser`. Their deterministic thresholds and the Gate's time/margin rules
are defined in `utils.js`. These values are research configuration and should
not be changed as part of UI, persistence, or lifecycle work.

## Generator and validation boundary

Static uses the Static prompt bundle. Adaptive uses either the Generalist
bundle or the Controller-selected Specialist bundle. The participant-facing
chat receives only a validated message; rationale and detector/controller
audit data are not published to participants.

The deterministic Generator contract verifies required fields, role fidelity,
length/format requirements, duplication, and grounding against eligible public
messages. The semantic Validator may reject or repair generated output through
the shared generation path; failures resolve safely without blocking the
experiment lifecycle.

## Lifecycle boundary

Empirica/Tajriba remains authoritative for rooms, rounds, stages, timers,
reconnects, chat, ready-to-end behaviour, and S1–S4 assignment. Research
persistence is additive: assignment confirmation is fail-closed for a new
untracked game, while all non-assignment mirror writes are non-blocking.

The priority order was `["facilitator", "challenger", "expander",
"synthesiser"]`; besides the removed facilitator slot, Expander was
ranked above Synthesiser, which directly contradicted the documented order
in both the Brief and the Methods manuscript ("Scrutiny, then Integration,
then Expansion" = Challenger > Synthesiser > Expander). It is now
`["challenger", "synthesiser", "expander"]`.

`debug_ui.html` was not touched. Its header comment in the old `utils.js`
claimed it imported from that file; that was never actually true (it has
its own hand-copied inline logic, no module import anywhere in the file).
Its inline copy is now stale relative to the real pipeline (still has
facilitator, the old flat `selectRole()` shape, no semantic layer at all).
It is a manual dev tool, not part of the live experiment path, and out of
scope for this task -- flagged so nobody uses it as documentation of
current behavior.

## 4. New placeholder values -- all pending calibration, none guessed from data

Every number introduced in this pass carries the same status as the
numbers that already existed: a structurally-necessary placeholder, not a
calibrated value.

- `THRESHOLDS.candidate.*` (Candidate Gate's loose feature cutoffs).
- `THRESHOLDS.gate.min_time_for_intervention_seconds` (10s) -- the new
  hard time floor implementing "insufficient time -> Abstain." Distinct
  from the pre-existing `synthesiser.forced_trigger_seconds` (20s), which
  only re-picks which role Adaptive uses once the gate has already said
  Act.
- `THRESHOLDS.gate.margin` (0.05) -- the top-two margin below which the
  gate treats a decision as too ambiguous and Abstains instead of
  guessing.
- `THRESHOLDS.weights.*` -- the combined-score formula's weights
  (`feature: 0.6, semantic: 0.4, persistence: 0, stage_fit: 0, penalty:
  0`). `persistence` and `penalty` are real, computable, unit-tested
  quantities (whether a factor was also present last checkpoint; whether
  this role repeats last checkpoint's role) but are weighted at zero
  because there is no calibration data yet to justify moving them off
  zero -- raising them is a research decision, not an engineering one.
  `stage_fit` is weighted at zero AND always evaluates to zero regardless
  of weight, because `feature_server.py` computes no "discussion stage"
  signal at all yet; there is nothing to weight until that feature exists.
- The Policy Compiler's intensity cutoff (halfway between a role's own
  threshold and 1.0) is an arbitrary, clearly-labeled placeholder rule,
  not derived from anything.

None of these were tuned against any transcript or pilot data -- they are
only structurally present so the formula's shape matches the architecture
document and so downstream code has something well-typed to call.

## 5. Decisions made without a research-team sign-off, and why

Two decisions were explicitly escalated and answered by the user this
session (recorded in `PROMPT_MODULE_STATUS.md`'s addendum): add the
Semantic Assessor/Evidence Checker layer, and use threshold-based Abstain
rather than always-intervene. Beyond those two, a small number of
lower-stakes implementation choices were made directly, documented inline,
and are called out again here because they are easy to change later if the
team wants something different:

**Forced-synthesiser semantics.** The old code could force Synthesiser
unconditionally in the last 20 seconds, even overriding what would
otherwise have been an Abstain -- directly contradicting the "insufficient
time -> Abstain" rule. The reconciled version only lets the nudge change
*which* already-eligible role Adaptive uses; it requires Synthesiser to
have independently cleared its own hard gate and threshold this
checkpoint. A looser reading is possible (force Synthesiser whenever the
gate is Act for *any* reason, even if Synthesiser itself never became
eligible) -- that was not adopted without an explicit decision, because it
would mean picking a role that never demonstrated its own need this
checkpoint.

**Margin-fail / no-eligible-role resolves to Abstain, not "Generalist."**
The architecture document's Table 6 has an explicit, self-marked-uncertain
footnote about whether this case should fall back to a Generalist policy
(identical prompt to Static) instead of Abstain, pending Pilot 2 data.
This pass takes the Abstain branch, matching the Methods manuscript's
stated default. Introducing a Generalist output later is a small, additive
change (a new branch in `callbacks.js` after `evaluateGate()` returns
`act:false`) -- nothing in the current structure needs to change to add
it.

**Hard gate definition.** The architecture document's Table 6 describes
per-role "necessary conditions" in prose. This implementation defines a
role's hard gate as: it passed the feature-only Candidate Gate for that
role, AND its associated semantic factor(s) were confirmed present by the
Evidence Checker. This was chosen specifically to avoid inventing a second
set of magic thresholds beyond the ones the Candidate Gate already uses --
a role can only be hard-gated in if both the cheap feature signal and the
expensive semantic judgment agree something is really there.

## 6. Still open / out of scope for this pass

- The semantic Validator LLM (grading the generated message itself for
  steering, false consensus, role fidelity beyond the deterministic
  checks) and the repair-then-regenerate-once-then-Abstain loop from
  Methods 3.2.4 are still not wired into the live path.
- `static.md` is still a content skeleton (`[[ TODO ]]` markers); Static
  cannot produce a message at all until the research team supplies real
  policy text for it. This is unrelated to the gate work in this pass --
  it was true before and remains true after.
- No intervention-count cap is enforced anywhere yet (only the six-message
  cooldown). The architecture document's Checkpoint Manager describes one
  ("介入上限").
- `ConditionRouting.mjs` (and its test) appear to be dead code -- not
  imported by `callbacks.js` or `index.js`, only referenced by their own
  tests. Left untouched; flagged in case it should be deleted or revived
  deliberately, not silently by this task.
- `assessor.md` and `assessor.schema.json` are engineering drafts, not
  research-approved content, and are explicitly marked as such in their
  own headers. They should be reviewed the same way `expander.md` /
  `challenger.md` / `synthesiser.md` were, before any real session relies
  on them.

## 7. Files touched

Modified: `server/src/callbacks.js`, `server/src/utils.js`,
`server/src/prompts/promptLoader.js`, `server/src/prompts/DynamicContext.mjs`,
`server/src/prompts/GeneratorContract.mjs`,
`server/src/prompts/PROMPT_MODULE_STATUS.md`,
`server/src/prompts/source/prompt_design_specification.Rmd` (addendum
notes only), `server/tests/utils.test.js`, `server/tests/integration.test.js`.

Added: `server/src/SemanticAssessor.js`, `server/src/EvidenceChecker.js`,
`server/src/PolicyCompiler.js`, `server/src/prompts/source/assessor.md`,
`server/src/prompts/source/assessor.schema.json`,
`server/src/SemanticAssessor.test.mjs`, `server/src/EvidenceChecker.test.mjs`,
`server/src/PolicyCompiler.test.mjs`, this file.

Not touched: `client/`, `.empirica/`, `HPTConfig.json`, `treatments.yaml`,
round/stage/questionnaire flow, counterbalancing (S1-S4), `expander.md` /
`challenger.md` / `synthesiser.md` / `static.md` / `base.md`,
`validatorPlaceholder.js`, `regenerationPlaceholder.js`, `debug_ui.html`.

**2026-08-08 addendum (opening message, section 8):** in the interim, a
separate PR (`d753eb6`) restructured `callbacks.js`'s Static/Adaptive
routing so Static no longer shares the Act/Abstain gate with Adaptive at
all (Static now always attempts a message every checkpoint, bypassing
feature extraction/Candidate Gate/Semantic Assessor/Evidence
Checker/`evaluateGate()` entirely) and rewrote `base.md`/`expander.md`/
`challenger.md`/`synthesiser.md`. None of sections 1-7 above describe that
current state anymore for the Static/Adaptive routing question specifically
-- they describe this document's original 2026-08-07 version. The Adaptive
pipeline itself (Steps 4-8, `utils.js`/`SemanticAssessor.js`/
`EvidenceChecker.js`/`PolicyCompiler.js`) was not touched by that PR and
still matches sections 1-7 exactly. Additionally modified for the opening
message: `server/src/callbacks.js` (`onStageStart`), `server/src/prompts/promptLoader.js`
(new `getOpeningMessageBundle()`), `server/src/prompts/promptLoader.test.mjs`.
Added: `server/src/prompts/source/opening_message.md`.

## 8. Opening message (2026-08-08 addition)

A separate, small feature, unrelated to the gate/semantic-layer work above:
the Facilitator now posts one fixed message at the very start of every
Task-stage discussion, before any human message exists, identical text in
both Static and Adaptive. Requested by the user directly (not derived from
Methods/architecture docs), with these choices confirmed at the time:
applies to both conditions with the exact same wording; the text is a
fixed template, not LLM-generated; and it is fully independent of the
checkpoint gate -- it does not call the Generator or the Semantic Assessor,
does not go through `GeneratorContract.mjs`'s validator, does not
increment `totalInterventions`, and does not touch any Adaptive Controller
cooldown state (`lastRole`, `synthesiserFired`, `messagesSinceLastIntervention`,
`lastHandledCheckpoint`).

Implementation: `server/src/prompts/source/opening_message.md` holds the
literal text (draft, engineering-authored, same "needs research review"
status as `assessor.md`). `promptLoader.js`'s new `getOpeningMessageBundle()`
reads it, using the same missing-file/incomplete-marker-blocking contract as
the other loaders in that file, and returns everything after the file's
last `---` delimiter as the participant-facing text (a header above that
delimiter carries the file's own status notes and is never sent to
participants). `callbacks.js`'s `onStageStart` handler calls it once, when
the stage transitioning to is named `"Task"`, and -- if not blocked --
appends it directly to that round's chat via `game.append`, then writes a
separate log entry (`outcome: "OPENING_MESSAGE_PUBLISHED"` or
`"OPENING_MESSAGE_SKIPPED"`) distinct in shape from the per-checkpoint
`logEntry` objects, specifically so downstream analysis scripts counting
intervention frequency don't need to special-case filtering it out --
it is already tagged with a different `outcome` value than any checkpoint
outcome (`ACT`/`ABSTAIN`/`PUBLISHED`/`SILENT` families never produce
`OPENING_MESSAGE_*`).

This message is not analyzed for role fidelity, non-directiveness, etc. by
anything currently in the pipeline (no Generator call means no
`GeneratorContract.mjs` check ever runs against it) -- its safety rests
entirely on the fixed wording being reviewed by a human before use, the
same as `static.md`/`expander.md`/etc. Review the wording in
`opening_message.md` before running any real session.

## 9. Test coverage added

`server/src/EvidenceChecker.test.mjs` (13 tests), `server/src/PolicyCompiler.test.mjs`
(7 tests), `server/src/SemanticAssessor.test.mjs` (14 tests) -- all pure-function
or fake-LLM tests, `node --test`, no network, no API key. `server/tests/utils.test.js`
was rewritten for the new `getCandidateRoles`/`evaluateGate`/`chooseRole` shape
(34 tests). `server/tests/integration.test.js` was narrowed to only the
still-purely-feature-based `getCandidateRoles()` against a real running
feature-server sidecar (role selection itself now requires a Semantic
Assessor call, which needs a mocked LLM, not a live sidecar -- that
coverage lives in `SemanticAssessor.test.mjs` instead).

At the time of writing: `node --experimental-vm-modules --test
$(find src -name "*.test.mjs")` reports 155/155 passing.
`NODE_OPTIONS=--experimental-vm-modules npx jest tests/utils.test.js`
reports 34/34 passing. `tests/integration.test.js` requires the feature
server sidecar running locally and was only syntax-checked here (this
sandbox had insufficient disk space to install
`sentence-transformers`/torch). The remaining `jest`-reported failures for
files under `src/` are a pre-existing convention, not a regression: those
files use Node's built-in `node:test` runner (not Jest) and must be run
with `node --test`, exactly as before this change -- see
`src/ConditionRouting.test.mjs`'s own header comment.
