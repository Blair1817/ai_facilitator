# Delibra Adaptive Pipeline — Implementation Logic

Written 2026-08-07, after adding the Semantic Assessor / Evidence Checker /
Policy Compiler layer and the shared Act-Abstain gate described in
`Delibra_Agent_System_Architecture_A0(2).docx`. This document explains, in
plain language, what the code in `server/src/` now actually does end to
end, what was decided along the way, what is still a placeholder, and what
is still open for the research team to resolve. It is not a research
document and does not carry a version number in
`prompt_design_specification.Rmd`'s scheme -- it is an engineering
reference for reading the code.

## 1. Why this changed

Before this pass, the live pipeline had two problems relative to the
Methods manuscript and the architecture document.

First, Static and Adaptive did not share a real Act/Abstain gate. Every
checkpoint (every sixth human message), Static would fire unconditionally
as long as `static.md`'s content wasn't a skeleton -- there was no
feature-based or semantic check at all for Static. Adaptive, meanwhile,
could Abstain whenever no role's feature score cleared its threshold. That
meant intervention frequency could differ systematically between the two
conditions, which directly undermines the experiment's central design
principle: the same Act/Abstain decision is supposed to apply to both
conditions, so that any measured difference in outcomes can be attributed
to role-conditioned strategy, not to differences in how often the AI spoke
at all.

Second, the codebase's own `prompt_design_specification.Rmd` had, at an
earlier stage of the project, explicitly ruled out an independent semantic
judgment LLM ("不存在独立的LLM判断组件") and recommended a design where
every checkpoint always produces a visible message ("方案A"). That
directly conflicts with the architecture document, which specifies a
Semantic Assessor LLM (Step 5) and a deterministic Evidence Checker (Step
6) as part of the detection pipeline, and with the Methods manuscript's
description of a threshold-based Act/Abstain gate. On 2026-08-07 this was
raised explicitly and the decision was made, in this session, to implement
the architecture document's version: add the Semantic Assessor LLM +
Evidence Checker, and adopt threshold-based Abstain rather than
always-intervene. That reversal is recorded in
`server/src/prompts/PROMPT_MODULE_STATUS.md`'s addendum and in a short
pointer added to `prompt_design_specification.Rmd` itself. Neither
document was taken through its own formal re-versioning process --
someone on the research side should do that deliberately rather than treat
this file as having done it for them.

The semantic Validator LLM (a separate, still-dormant component that would
grade the *generated message* for steering/false-consensus/etc.) and the
regeneration/retry loop described in Methods 3.2.4 were explicitly left
out of this pass. They were removed in an earlier "GRAIL scope-reduction
refactor" and nothing here reinstates them. `validatorPlaceholder.js` and
`regenerationPlaceholder.js` are unchanged.

## 2. What the pipeline does now, checkpoint by checkpoint

Every sixth human message in the Task stage, for both `static` and
`adaptive` rounds, `callbacks.js`'s `handleChat()` runs the following
sequence. Everything through step 4 (the gate decision) is identical
regardless of `facilitation` -- the same function calls, the same inputs,
the same output. The branch only happens after the gate has already
decided Act.

**Step 1-3, unchanged.** The checkpoint-dedup guard, the six-message
cooldown, and the "Task stage only" check are exactly as before. The last
six human messages are sent to the Python feature sidecar
(`feature_server.py`), which returns `novelty_score`, `redundancy_score`,
`agreement_score`, and `justification_score` (the `gini_score` it also
returns is no longer consumed by anything -- see section 4).

**Step 4, Candidate Gate (`utils.js`'s `getCandidateRoles()`).** A
deliberately loose, high-recall pass over the four feature scores decides
which of Expander/Challenger/Synthesiser are worth investigating this
checkpoint. If none are, the checkpoint resolves to Abstain immediately,
without ever calling an LLM. This is the same behavior for Static and
Adaptive.

**Step 5, Semantic Assessor (`SemanticAssessor.js`).** If the Candidate
Gate found at least one candidate, exactly one LLM call is made -- for
both conditions, not just Adaptive. The model is given the candidate role
list, the local and cumulative public transcript (message-ID annotated),
and the task's general context, and asked to judge five factors
(`breadth_deficiency`, `group_preference`, `justification_deficiency`,
`integration_deficiency`, `self_correction`), each with a status
(present/absent/uncertain), a strength, supporting message IDs, and a
verbatim span. The prompt (`prompts/source/assessor.md`) instructs the
model to only genuinely investigate the factors tied to the candidate
roles, plus `self_correction` always, and to default everything else to
absent rather than invent evidence. The response is strictly parsed and
schema-validated (`assessor.schema.json`) before anything downstream sees
it. If the call fails, times out, or returns something invalid, the
checkpoint proceeds with `checkedFactors = null` -- this is treated
exactly like "nothing was confirmed," not as an error that blocks the
round.

**Step 6, Evidence Checker (`EvidenceChecker.js`).** Purely deterministic,
no LLM. Four rules run on the Assessor's raw output: a span must actually
occur verbatim in a message the factor cited, or the factor is downgraded
to uncertain; `group_preference` specifically requires that the surviving
supporting messages come from more than one distinct participant, not one
person's opinion cited twice; if a factor's role never even reached
Candidate Gate status from the feature scores alone, an LLM claim of
"present" has its strength halved rather than being trusted outright or
thrown out; and if `self_correction` is present, every other present
factor's strength is discounted in proportion to `self_correction`'s own
strength. The result, `checkedFactors`, has the same shape as the raw
input and is what everything downstream actually uses.

**Step 7, the shared gate (`utils.js`'s `evaluateGate()`).** This is the
actual fix. Given the features, `checkedFactors`, the candidate list, and
the remaining round time, it returns one `{act, reason, scores,
eligibleRoles}` object. A role only becomes eligible if it clears a hard
gate (it must be both a feature-level candidate AND have its associated
semantic factor(s) confirmed present by the Evidence Checker) and its
combined score clears its threshold; if two or more roles are eligible but
the gap between the best and second-best score is too small, the result is
Abstain rather than a guess; and if the remaining round time is below a
fixed floor, the result is Abstain regardless of any score, matching the
Methods manuscript's "insufficient time for a meaningful
intervention-response cycle" condition. **This exact function, called with
the exact same arguments, decides Act/Abstain for Static and Adaptive
alike.** If it returns Abstain, the checkpoint logs the reason and ends --
for both conditions, before anything condition-specific happens.

**Step 7b, role selection (`utils.js`'s `chooseRole()`), Adaptive only.**
Only reachable when the gate already returned Act. Picks among the
eligible roles by the fixed priority order (Challenger > Synthesiser >
Expander), skipping the role used last checkpoint if an alternative is
available. A "forced synthesiser" nudge can override the priority pick in
the final `synthesiser.forced_trigger_seconds` of the round, but only if
Synthesiser is *itself* already eligible this checkpoint and hasn't fired
yet -- it can never manufacture an intervention where the gate said
Abstain, and it can never promote a role that never cleared its own bar.
This is a deliberately conservative reading; section 5 below explains the
alternative reading that was not adopted.

**Step 8, Policy Compiler (`PolicyCompiler.js`), Adaptive only.** Turns
the chosen role and its `checkedFactors` into a plan: which message IDs
the Generator is allowed to cite (`evidenceIds`, always intersected with
the real set of citable public messages), a plain-language description of
the detected gap built only from verified spans (never invented), an
intensity classification (`high`/`medium`, based on how far the score
cleared its threshold), a fixed two-sentence cap, and a fixed list of
prohibitions. Static never goes through this module.

**Step 9, Generator, shared path, mostly unchanged.** Static uses the
fixed general prompt; Adaptive uses the selected role's prompt. Both now
receive a `RELEVANT_DISCUSSION_STATE` section in the Dynamic User Prompt
when a plan is present -- this field existed in
`prompt_design_specification.Rmd`'s field list from the start but was
previously always omitted because nothing in the pipeline could fill it
safely. It is now filled with the Policy Compiler's `gap` text for
Adaptive checkpoints with a plan, and still omitted for Static and for any
Adaptive call without one. No role-prompt file (`expander.md`,
`challenger.md`, `synthesiser.md`, `static.md`, `base.md`) was edited.

**Step 10, Validator, shared path, one addition.** The existing
deterministic checks (role match, length, markdown, duplicate detection,
grounding IDs must reference real public messages) are unchanged. One new
check was added: when a plan is present, the Generator's cited message IDs
must also be a subset of the plan's own `evidenceIds`, not just of the
whole public transcript -- this is the Brief's Step 9 "evidenceIds:
允许引用的message IDs" constraint. Static and any Adaptive call without a
plan are unaffected (the check is skipped when `allowedGroundingIds` is
not provided). There is still no semantic Validator LLM call and no
regenerate-once-then-Abstain loop; a failed check still just logs Silent,
exactly as before this change. See section 1.

## 3. What changed in the role set itself

The `facilitator` role (participation-balance / Gini-driven) is gone
entirely -- not just unused, removed from `ROLES`, `ROLE_PRIORITY`, and
`THRESHOLDS`. It had no prompt file and no schema entry before this
change either; the difference is that previously, if the Gini signal won,
the Controller would still select "facilitator," the prompt loader would
come back blocked, and the checkpoint would silently burn its intervention
opportunity as Silent -- even in checkpoints where a real role
(Expander/Challenger/Synthesiser) also would have cleared its own
threshold that same turn, because the old code picked one role by priority
order rather than considering all eligible roles. That silent-loss path no
longer exists.

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

## 8. Test coverage added

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
