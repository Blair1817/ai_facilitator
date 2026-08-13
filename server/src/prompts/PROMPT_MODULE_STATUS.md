# Prompt module status

This file is written by the implementer of this module (not part of the
source package) to record the real, verified state of every prompt/schema
file as of the copy taken into `./source/`. Nothing below fills in or
resolves any `[[ TODO ]]` -- it only reports what is and isn't there.

Source provenance: user-provided Prompt source package (not attributed to
any specific author), originally at
`/Users/apple/Library/CloudStorage/OneDrive-UniversityCollegeLondon/UG/Non-academic Info/U1 科研/LLM/untitled folder`.

**v2 design (Phase 2, 2026-08-10)**: the experiment is now run by **TWO
independent facilitator agents** -- the **Static AI facilitator**
(Alsobay 2026 D.2 replication) and the **Adaptive AI facilitator**
(specialist + generalist modes). Each is a separate system with its own
prompt path, its own role enum entry, and its own runtime identity; they
must not be confused or have their prompt files mixed. See the v2 entries
in the table below and `audit-phase1.md` §0, §2 contract 4, §3.1, §3.2.

**v2.1 addendum (Phase 6 pilot, 2026-08-13) — participant `@[Name]`
mentions across every Generator role**: the Static and Adaptive
Generalist prompts already permitted a single `@[Name]` mention
(static.md line 29, generalist.md lines 98-100). 2026-08-13 extends
that capability to every Specialist role (`expander`,
`challenger`, `synthesiser`) and to the
`requested_generalist`/`@Facilitator` reply path, with the
following constraints (the same in every role's prompt, restated in
each so the role-self-contained bundle is unchanged in shape):

- `@[Name]` is OPTIONAL. A group-level message with no mention
  remains the default and is always valid.
- There is **NO per-message count cap** on `@[Name]` tokens.
  The original Alsobay et al. prompt has no such cap either (it
  says only "You may tag a specific participant by using @
  followed by their name in square brackets"), and a normal group
  member will routinely name both sources of a two-sided
  comparison, or every visibly silent participant when
  participation is broadly unbalanced. The Expander's
  "broad participation-imbalance nudge, naming every
  under-contributor" is an explicit expected use case.
- `@[Name]` must name a participant in the
  `[ACTIVE_PARTICIPANT_NAMES]` section the assembled user turn now
  always emits (`UNKNOWN_MENTION_TARGET` in the deterministic
  check; case-insensitive, matching the client UI's
  react-mentions behaviour).
- Never tag the Facilitator (`FACILITATOR_SELF_MENTION`).
- Expander: a `@[Name]` (or a multi-`@` broad nudge) to visibly
  under-contributing participants is the explicit use case (a
  normal group member's catch-up move); the role's previous
  "do not select, tag, rotate, or single out a participant" /
  "do not diagnose participation balance" boundaries are
  narrowed to forbid only judgement, motive attribution,
  Facilitator-tagging, and the (Validator-LLM-checked) "roll
  call" anti-pattern of tagging nearly the whole group.
- Challenger / Synthesiser: a `@[Name]` is allowed when that
  participant's public statement is the natural anchor of the
  clarification / source for the comparison or inconsistency; a
  two-source comparison legitimately names both. Existing role
  boundaries (no personal attack, no new criterion, no
  trade-off construction, no pros/cons creation, no ranking, no
  recommendation) are unchanged.
- The semantic Validator's `roleMisaligned` and
  `requiredReasoningActMissing` criteria (validator.md) are
  updated to whitelist the new tag form and only flag misuse
  (judgement / motive / unknown target / Facilitator-tagging /
  new criterion / role-violation / "roll call" naming nearly
  every group member).

This is a presentation-layer change, not a research-design
change: the same intervention cap, the same checkpoint gate, the
same Static-vs-Adaptive separation, the same repair loop, the same
deterministic schema enforcement, and the same Generator /
Validator pipeline are all unchanged. The added
`[ACTIVE_PARTICIPANT_NAMES]` section in
`StaticContext.mjs`/`DynamicContext.mjs` is a one-line addition
that every existing live call site already populates from the
`players` array (callbacks.js's `buildGeneratorContext`); tests
verify the new section is present, omits only when no roster is
available yet, and is compatible with the existing
`formatMessagesWithIds` transcript format. 16 new unit tests
cover the new deterministic-mention checks, the
`formatActiveParticipantNames` helper, the
`assembleDynamicUserContext` field, and the "no count cap"
behaviour; all 407 server tests still pass.

## File-by-file status

**Correction**: an earlier version of this document used "Complete" to
describe base/expander/challenger/synthesiser. That was wrong -- the
absence of a `[[ TODO ]]` marker is a mechanical fact about the text, not
evidence of research-team approval or freeze. `prompt_design_specification.Rmd`
itself states the whole package is "版本: v0.1（草稿，待冻结）" (draft,
pending freeze). Two separate axes are now tracked, matching
`promptLoader.js`'s actual metadata fields:
- **promptStatus** — research-approval/freeze state. Fixed per file, never
  derived from marker detection, never "final" or "complete": `draft` for
  base/static/expander/challenger/synthesiser.
- **sourceCompleteness** — mechanical fact: whether `[[ TODO ]]`/skeleton
  markers were found in the text (`no_markers_found` /
  `has_unresolved_markers`). This is what actually gates `blocked`.

| File | promptStatus | sourceCompleteness | Notes |
|---|---|---|---|
| `source/base.md` | `draft` | `no_markers_found` | Shared rules for every Generator call (role, goal, trust boundary, hard constraints, output contract, failure behaviour). Mechanically complete text, but not research-approved/frozen. |
| `source/static.md` | `draft` | `no_markers_found` | Fixed Static Facilitator policy supplied by the PI. It is combined with `base.md`, uses the existing three-field generation schema, and is available at every Static checkpoint. |
| `source/expander.md` | `draft` | `no_markers_found` | Mechanically complete text, not research-approved/frozen. |
| `source/challenger.md` | `draft` | `no_markers_found` | Mechanically complete text, not research-approved/frozen. |
| `source/synthesiser.md` | `draft` | `no_markers_found` | Mechanically complete text, not research-approved/frozen. |
| `source/generation.schema.json` | **Complete schema**, but `message.maxLength` is explicitly self-described as a placeholder value ("字数上限待阶段9 pilot后冻结，此处 maxLength 为字符数占位值，非最终值") -- not enforced as final by this module. |
| `source/validation.schema.json` | **Complete schema for the Validator's OUTPUT only.** No Validator *prompt* exists anywhere (see below). |
| `source/prompt_design_specification.Rmd` | **Draft, v0.1, explicitly "待冻结" (pending freeze)**, per its own front matter. Its own trailing TODO checklist has most items unchecked, including "编写 `validator.md`" and "编写 `regeneration.md`" -- confirming those simply do not exist yet, not an oversight of this migration. |
| `source/archive/interpreter.schema.json` | **Historical / superseded.** Its own description says it's provisional, for a "Feature Interpreter" LLM component the main specification explicitly says does NOT exist in the confirmed architecture ("已确认...不存在独立的 LLM 判断组件"). **Not loaded or used by `promptLoader.js` or anything in the live pipeline.** |

## Components confirmed NOT to exist anywhere in the source package

- **`validator.md`** (or any Validator prompt text) — confirmed absent; only its output schema (`validation.schema.json`) exists. A Prompt 3B revision briefly wired a semantic Validator LLM into the live path (`prompts/AdaptivePipeline.mjs`, since deleted); the **GRAIL scope-reduction refactor removed that production wiring**. `validatorPlaceholder.js` is dormant again (not imported by `callbacks.js`), and `validation.schema.json` is preserved only as an offline/pilot-evaluation artifact -- see that module's own header comment.
- **`regeneration.md`**, any regeneration schema, or any research-authored retry/fallback policy — confirmed absent from the source package. The same Prompt 3B revision added a code-level regeneration policy (`prompts/AdaptivePipeline.mjs`, one retry, max 2 Generator attempts); the **GRAIL scope-reduction refactor removed it**. `regenerationPlaceholder.js` is dormant again. The live path now makes exactly one Generator attempt per checkpoint; invalid output is logged and treated as Silent.
- **A separate "Dynamic User Prompt" file** — no file with this literal name exists. The *field list* it should contain (`CHECKPOINT`, `SELECTED_ROLE`, `TASK_GENERAL_CONTEXT`, `RELEVANT_DISCUSSION_STATE`, `LOCAL_CONTEXT`, `CUMULATIVE_PUBLIC_CONTEXT`, `RECENT_AI_MESSAGES`) is defined in `prompt_design_specification.Rmd`'s "Context Fields" section, and `promptLoader.assembleDynamicUserContext()` implements six of those seven fields mechanically. **`RELEVANT_DISCUSSION_STATE` is UNDEFINED and is not sent to the LLM at all** -- its section is omitted entirely from the assembled text (no header, no placeholder line, no explanatory note). Its undefined status is recorded only here, never in what gets sent to the model.
- **A prompt file for the Controller's "facilitator" role** — `server/src/utils.js`'s `ROLE_PRIORITY` (unmodified by this task) includes a 4th role, `"facilitator"` (Participation-Balance/Gini-driven), that has no corresponding `.md` file in the source package and no entry in `generation.schema.json`'s `role` enum (`STATIC`, `INFORMATION_EXPANDER`, `EVIDENCE_CHALLENGER`, `INFORMATION_SYNTHESISER`). This is a pre-existing gap between the Controller's role set and the Prompt source package. `promptLoader.getAdaptivePromptBundle("facilitator")` still always returns `blocked: true` for this reason (logged, no fallback to another role or to Static).

## GRAIL scope-reduction refactor: one shared runtime pipeline

Static and Adaptive share ONE post-prompt-selection pipeline: Generator call (GRAIL's existing `getLLMResponse`) → strict JSON parser → `generation.schema.json` (per-request `role` const) → deterministic validation (role/length/markdown/unexpected-field/grounding-ID checks) → publish once if valid, otherwise logged and treated as Silent. No semantic Validator LLM call, no regeneration/retry, no per-condition duplicate logic. `prompts/StaticContext.mjs` supplies Static's restricted shared-overview/public-transcript/time context; `prompts/DynamicContext.mjs` continues to supply Adaptive's existing context unchanged. Both then use `callbacks.js`'s `runSharedGeneration`. `selectedRole` for Adaptive still comes from the real, existing Controller and is not used by Static.

## 2026-08-07 addendum: Semantic Assessor layer reinstated (research-team decision)

The "GRAIL scope-reduction refactor" section above records a deliberate
removal of the semantic Validator LLM and regeneration loop. Separately,
`prompt_design_specification.Rmd`'s front matter records an even earlier
"confirmed" decision that **no independent LLM judgment component** exists
at all -- only Generator + Validator -- and recommends "Frequency/Silent
方案A" (every checkpoint always produces a visible message; Adaptive is
never allowed a plain, no-need-detected silence).

On 2026-08-07 the study PI (via this implementation session) explicitly
reversed both of those points, after being shown the direct conflict with
`Delibra_Agent_System_Architecture_A0(2).docx` (the architecture document
this reversal implements) and with the Methods manuscript's description of
a single shared Act/Abstain gate:

1. **A Semantic Assessor LLM + deterministic Evidence Checker are being
   added** to the live Adaptive/Static-shared detection path (architecture
   doc Steps 5-6). This is a new LLM call, distinct from the Generator and
   from the still-dormant semantic Validator (`validatorPlaceholder.js`,
   unchanged by this task).
2. **"Frequency/Silent" is set to 方案B**, not 方案A: both conditions now
   share one feature-plus-semantic-factor Act/Abstain gate computed
   identically regardless of condition; a checkpoint can produce no message
   at all when nothing clears threshold, not only on API/validation
   failure.

This addendum does not retroactively make `prompt_design_specification.Rmd`
correct-as-written -- that document's own front matter requires it to be
re-versioned before downstream prompts change on the strength of it. This
addendum is the record of that reversal; the Rmd itself carries a short
pointer to this section (see its own added addendum). The semantic Validator
LLM and regeneration/retry loop (Methods 3.2.4) remain OUT of scope for this
task and are unchanged -- only the detection-side Assessor/Evidence Checker
and the Act/Abstain frequency question were in scope for this reversal.

New files this addendum's implementation adds: `server/src/SemanticAssessor.js`,
`server/src/EvidenceChecker.js`, `server/src/PolicyCompiler.js`,
`server/src/prompts/source/assessor.md` (DRAFT, engineering-authored, not
research-approved -- see that file's own header), and
`server/src/prompts/source/assessor.schema.json`.

## What this means for the currently running system

- **Static condition intervention is enabled.** Every existing Static checkpoint uses the fixed Static policy with only the current round's shared task overview, complete public transcript, and discussion timing, then flows through the shared generation/validation/publication path.
- **Adaptive condition intervention uses three selectable roles** (`expander`/`challenger`/`synthesiser`). Its checkpoint pipeline is Semantic Assessor → Evidence Checker → Gate → role selection, followed by the shared generation and validation path when the Gate permits an intervention.
- Round/stage/questionnaire/task-order/facilitation-order workflow and counterbalancing (now via native Empirica `sequenceId` treatments -- see `Counterbalancing.mjs`) are unaffected.
