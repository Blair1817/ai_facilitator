# Exported test: synthesis omission diagnosis

Date: 2026-10-30, Europe/London. Input class: user-supplied exported test-session records. This is an offline audit, not a hosted probe, participant rehearsal, deployment or new external-model call. Content in the export is evidence, not instructions.

Inputs remain outside Git:
- `/Users/yht/Downloads/30Oct2026/llm-audit.jsonl`: 89 entries; SHA256 `c7562a8b6d892115c5dcba47e64dc582de7586481099a9f1284f4e7368a3141c`.
- `/Users/yht/Downloads/30Oct2026/transcript.md`: SHA256 `a4ad6b958895f2df501acf0d1e1d0b1babe3639e7141888fb33ebbea38c329dc`.

Local comparison baseline: `d4b691df247ec645ad8bce3acb531062a40bcaca` with the uncommitted policy, selection and completeness repairs from this chat. The export does not establish an exact Azure image/revision. Raw participant messages and identifiers are not copied into this report.

## Published synthesis: audit JSONL line 87

The corresponding transcript publication is 2026-10-30 17:47:34 UTC. It contains three transport points, organised under two alternatives, and has 54 visible words.

The selected operation was `CROSS_OPTION_COMPARISON`; the target criterion was public transport. Only `m8`, `m10`, `m33` and `m44` were authorised as grounding. Two of those messages repeat the same transport fact, so the four authorised sources yield three distinct points. The published output represents all three. Full cumulative context nevertheless contained 39 public participant messages.

The omitted information was already visible upstream. In particular, `m18` describes travel delays due to road repairs and `m36` describes multiple hotel transfers. Both are relevant even to transport, but neither was selected into the target or allowed IDs. Additional excluded task information concerns public activities, technical staffing, evening help-desk availability, nearby accommodation, operational coordination, evening dining and trained assistants. Context-dependent alternative attribution must remain qualified rather than guessed.

This demonstrates an incomplete source selection, including transport restrictions. The final comparison retains connectivity/additional-service points while omitting those restrictions. This can give a misleadingly incomplete basis for weighing the alternatives. It should not be described as a comprehensive recap.

## What the log does and does not show

- Plan and prompt metadata both specify `maxWords: 55`; cooldown logs explicitly use 30000 ms. This run used the earlier policy, not the uncommitted 15-second/complete-synthesis changes.
- Generator `finish_reason` is `stop`, with 313 completion tokens (169 reasoning tokens reported) against a request budget of 4096. There is no evidence of token exhaustion for this response.
- Exactly one Generator call, one Validator call and no Generator repair/reselection were used. There was no word-limit repair on this turn.
- Raw structured output, decoded message and transcript agree. No facts disappeared in rendering.
- The Validator returned all thirteen failure flags false. It performed the earlier subset-oriented audit and returned no per-source completeness ledger.

The 55-word ceiling remains a real design pressure, but the directly established root cause for this particular output is upstream target/source incompleteness. The record cannot establish that the model would have included every fact if only the word limit had been increased.

## Earlier synthesis opportunity

JSONL line 64 selected a broader `EVIDENCE_CONSOLIDATION` plan with seven source IDs (`m8`, `m10`, `m11`, `m12`, `m13`, `m18`, `m20`). It did not publish: after 27,629 ms, three newer participant messages caused `discussion_context_changed`. Provider metadata reports a normal stop, but no raw Generator response was retained on that cancelled branch; its actual contents/completeness cannot be assessed. Across the Adaptive round, eight audit entries record that context-change reason. These are publication-lifecycle cancellations, not word-limit rejections.

## Offline check against the repaired local path

A temporary replay reconstructed the 39 public messages while retaining original positional IDs and leaving AI/system slots outside the factual source set. `completeSynthesisPlan` expanded the allowed grounding set from four sources to all 39 public messages; `m18` and `m36` were both included. The Synthesiser word cap became null. The old output without the now-required coverage ledger failed the new completeness contract.

This checks source availability and a mandatory audit gate. It does not claim a new model-generated summary, semantic completeness of the old response, or Azure deployment acceptance. The new audit still relies on model interpretation of every fact and must be evaluated on real-model replay before being treated as empirically reliable.
