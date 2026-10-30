# Synthesiser coverage investigation — 2026-10-30

Scope: current local source. No live conversation or Azure revision verified; no runtime policy change, deployment, or model call.

## Confirmed findings

1. **Whole-message limit: 55 whitespace-separated words.** `PromptRuntime.mjs` defines `SYNTHESISER_MAX_WORDS=55`; `PolicyCompiler.js` attaches it to synthesis plans. `synthesiser.md` counts summary, headings, numbering and closing question, explicitly selects material within that ceiling, and permits a smaller scoreboard with fewer points/options. `SynthesisPointContract.mjs` repeats the same budget for the official OpenAI structured-point path. Its point arrays have no fixed point maximum, but the total-word limit still applies.
2. **Over-limit output is rejected, not sliced.** `GeneratorContract.mjs` reports `MESSAGE_EXCEEDS_WORD_LIMIT`. The presentation normaliser concatenates all supplied content, and the structured-point decoder formats all returned points without truncation. No frontend word-55 cutoff was found in the inspected path.
3. **An incomplete target is a separate cause.** The Assessor chooses integration source IDs, the compiler uses them as plan evidence IDs, and the Generator may only ground a Specialist message in that allowed set. Citing another public message fails `GROUNDING_ID_OUTSIDE_PLAN_EVIDENCE`. Increasing the cap alone cannot repair missing target sources.
4. **Completeness is not required.** The Validator explicitly says authorised sources need not all be repeated. At least two contributions must be organised; the point decoder likewise checks at least two sources. It does not require all relevant facts within the target to appear. One message may contain several facts, so source-ID coverage alone is not factual completeness.
5. **The input is not limited to the latest six messages.** Assessor and Generator context builders send cumulative current-round public participant context plus a separate latest-six-message context. This does not exclude upstream filtering, provider limits or different deployed code in a live case.

## Reproduction using the prompt's G-09 example

Input: five factual reports (`m0`–`m4`) and one decision-context message (`m5`); all six are target/allowed IDs. Output cites only `m0`–`m3`. It omits this allowed public report:

> Two Orsena event bus routes share a crowded afternoon stop.

Using the real `normalizeGeneratorCandidate` and `runDeterministicValidation`:

| Variant | Visible words | Word-limit result |
| --- | ---: | --- |
| Existing G-09 output | 48 | Pass |
| Restore the omitted report verbatim while retaining the existing text | 58 | `MESSAGE_EXCEEDS_WORD_LIMIT` |

This confirms deletion pressure and an example teaching selective coverage. It does not prove that all five reports could never fit with alternative faithful wording. It is a synthetic built-in example, not the user's particular conversation. Existing structured-point contract tests also passed locally.

## Independent token constraint

Local default Generator output budget is 1000 tokens; Synthesiser uses medium reasoning effort. Actual request settings, response `finish_reason`, raw output and repairs must be inspected before attributing a specific live omission to provider truncation. That cause is not confirmed here.

## Recommended repair

- Define focused versus whole-discussion synthesis scope explicitly; assemble all relevant facts for that scope before generation.
- Give Synthesiser a bounded budget scaled to distinct required facts and necessary qualifications, with numbers chosen through representative replay. Avoid silently deleting required facts/options to satisfy a fixed 55-word cap.
- Check coverage of required factual units, including unresolved concerns and both sides of discrepancies. Allow faithful merging and relevant exclusions; do not require every chat utterance.
- Update the constant, prompt, selective fallback, G-09 example, structured-point instruction and Validator together. Raising only the constant leaves contradictory instructions and no completeness guarantee.

For a particular conversation, trace public chat → detector target/quotes → plan evidence IDs → raw Generator output/metadata → repairs → published message. This distinguishes target omission, generation selection, word-limit pressure and token exhaustion.


## Implemented follow-up

Following the user's explicit completeness-first instruction, the local source
now removes the Synthesiser word cap, expands permitted sources beyond detector
seeds, and requires an exact-quote-backed per-source semantic coverage audit.
The G-08/G-09 demonstrations and all runtime prompt copies were updated. See
`docs/adaptive-need-detection.md` for the final policy. This supersedes the
fixed-cap behaviour diagnosed above; Azure deployment is not part of this change.

Validation after implementation: 898/898 local service/prompt tests passed,
including loopback export-server tests; server production build passed. New
coverage tests exercise omitted sources, a missing fact within a multi-fact
source reported by the semantic auditor, invalid quote mappings, incomplete
ledgers, partial context, complete outputs beyond 55 words and truncated audits.
These are offline contract/orchestration checks, not a real-model completeness
benchmark. No live-model replay or Azure deployment was performed.
