# @Facilitator requested-reply validator repair — 2026-10-18

Base: `main` at `b62247462d04136705e008722c85c65accbde4fc`, local uncommitted changes.

## Evidence and diagnosis

The supplied test-session transcript records three requested replies falling back after both semantic audits rejected them for `repetition` (one first audit also flagged `nonNeutral`). The visible refusal was deterministic `NON_LLM_FALLBACK`, not the generated candidate. The transcript does not include raw candidate/audit bodies, so individual model judgments cannot be reconstructed from it.

Source inspection found the requested Generator allowed explanations, summaries and comparisons, but `validatorRuntimePath` routed requests to the old automatic `frozen_control/validator.md`. That validator treated revisiting the same target/reasoning act as repetition and required a balanced contribution prompt, explicitly rejecting pure summaries. It also imposed an automatic two-sentence rule. The validator context accepted `triggerType` but did not render the request type or identify the request. All technical/validation failures then displayed a fixed refusal about correct answers, including for ordinary terminology questions. Earlier mention fixes addressed parsing/schema/mention handling without resolving this policy mismatch.

## Changes

- Dedicated requested-reply validator, with explicit runtime request context delivered to both Generator and Validator.
- Requested recaps and explanations can revisit public information; defining process terminology and resolving references to prior AI wording are permitted. Prior AI wording remains ineligible as task evidence.
- Requested definitions, grounded summaries and neutral comparisons satisfy the requested reasoning act. Requested responses keep their character cap rather than automatic sentence/word limits.
- Genuine repetition, ungrounded claims, recommendations, hidden-information inference and other audit failures still trigger bounded repair and fail closed. Exact duplicate checking remains enabled.
- Technical-failure fallback accurately states that the reply could not be completed and invites retry, rather than asserting the participant asked for a correct answer.
- Prompt manifests and offline runtime fixtures regenerated; automatic prompt files unchanged.

## Verification

Synthetic fixtures and stubbed model responses only; no attached transcript sent to an external model.

- Focused callback/semantic-validator/runtime tests: 64 passed.
- Full scoped source suite: 698 passed, zero failed/skipped across 42 files. Files enumerated with `rg --files src -g '*.test.mjs'` and passed explicitly to `node --test --test-reporter=spec`. Initial sandbox run had 19 loopback `listen EPERM` failures; rerun with local listener permission passed all 698.
- Callback regression exercises criteria, recap and terminology requests with prior AI history in Static and Adaptive conditions (six scenarios), and twice-rejected repetition/recommendation/hidden-inference/grounding candidates (four scenarios).
- Server production build passed. Built-source startup self-check, manifest integrity and requested Generator/Validator route checks passed.
- `git diff --check` passed.

These checks verify routing, policy delivery, publication, bounded repair and safety bookkeeping. They do not establish live-model semantic accuracy. No live model call, Azure mutation, deployment or participant-data modification was performed. Deploy through the Azure immutable-image pipeline before this fix can affect the hosted application.

## Pre-push integration verification

Rebased onto `origin/main` at `7a8c84a`, retaining the practice fallback's
`phase`, `source` and `exclude_from_primary_analysis` metadata alongside the
updated technical-failure copy. The complete server source suite passed all
710 tests with zero failures or skips after allowing local loopback listeners.
The merged server production build and `git diff --check` also passed.
