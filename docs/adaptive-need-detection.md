# Adaptive need detection and role selection (updated 2026-11-11)

This document describes how the Adaptive facilitator decides when and which role
speaks at an automatic checkpoint. The 2026-11-11 update removes the per-message
early-closeout probe, the priority/waiting queue, Specialist repair and redraw,
and limits participation invitations to recently silent participants. It
replaces the role-priority description in `server/IMPLEMENTATION_LOGIC.md` and
`LLM_DETECTOR_ONLY.md`, which are outdated on this point. Automatic pacing is
six human messages and a 15 s attempt cooldown for both Static and Adaptive.
Existing time floors, UI and experiment procedure remain.

## Division of labour

| Step | Done by | What |
|---|---|---|
| 1. Silence rule | Code | Invite recently silent participants; no detector call |
| 2. Judge each need | LLM detector (`specialist/assessor.md`, reasoning effort `low`) | ELICIT, SCRUTINIZE and INTEGRATE are judged independently against checklists; each is null or one operation + target + exact quotes |
| 3. Verify evidence | Code (`EvidenceChecker.checkNeedAssessment`, per candidate) | Exact quotes from the cited public messages; ≥2 distinct participants for SCRUTINIZE/INTEGRATE; ≥3 messages for fragmented_evidence; operation matches need |
| 4. Choose the role | Code (`AdaptiveEvidence.selectAdaptiveAssessment`) | Summary pause (recent evidence only), then a uniform random draw by role |

Participation (inviting a silent participant) is decided by code only; the
detector never reports it. `QUIET_PARTICIPANTS` is detector context only.

## Triggers

- **Message checkpoint** (Static and Adaptive): Task stage, time floor (Static
  10 s, Adaptive 20 s), 15 s cooldown, six human messages since the last
  publication, no automatic pipeline in flight.
- **Adaptive closeout checks**: remaining 180 s and 120 s, once each, integration
  only; no Static message when nothing qualifies.
- There is no background scan after ordinary messages (removed 2026-11-11: it
  consumed the shared cooldown/lock and starved message checkpoints). A skipped
  checkpoint waits for the next human message.
- @Facilitator requests bypass pacing and are not interventions.

## Selection (message-triggered Adaptive checkpoints)

1. **Silence rule (deterministic, not randomized, no detector call).** A roster
   participant with no message among the last `SILENCE_WINDOW = 12` public
   participant messages (requires at least 12 messages) is invited by the
   Expander. Per participant and round: at most `PARTICIPATION_INVITE_CAP = 2`
   invitations, none within 12 human messages of the previous one. Eligible
   names are invited together in one message. If an invitee posts before
   publication, the invitation is discarded and the Static policy is used.
   Logged as `selection.mode = "rule_triggered"` and `silenceRule`. Being quiet
   overall no longer triggers an invitation.
2. **Summary pause.** A detector `defer` (participant summary in progress)
   pauses the checkpoint, including the Static fallback, only while one of its
   quotes is among the latest 3 public participant messages; otherwise it is
   ignored (`selection.ignoredDefer`).
3. **Uniform draw.** A role is drawn uniformly among roles present in the
   verified pool, then a candidate uniformly within that role. A role that
   filled the last two Specialist turns is skipped when another role is
   available. The exact probability is logged (`selection.mode = "random"`).
   There is no priority tier or waiting queue.
4. **Empty pool** → Static policy message.
5. **Any Specialist failure** (Validator rejection including repetition,
   word limit, preflight, grounding) → Static policy message. No Specialist
   repair and no redraw. Static keeps its own single repair in both conditions.

Prompts ask for at most 40 words (hard runtime ceiling 50) for Static,
Expander and Challenger; Synthesiser has no fixed ceiling.

If new participant messages arrive while a synthesis is being generated or
validated, it is discarded and regenerated once with the latest transcript; a
second change ends a message checkpoint in the Static policy and makes a timed
check retry later. An invitation is also discarded before publication if an
invitee has posted meanwhile.

## Checklists and their basis

Each item must hold for the need to be reported. "Design choice" means no
direct literature basis; these are to be pre-registered.

| Need / operation | Checklist | Basis |
|---|---|---|
| ELICIT coverage_gap | target is a live option or established relevant criterion; facts are concentrated on other options/criteria leaving it under-covered (mention counts are clues, inspect concrete facts); nobody currently supplying/requesting the missing coverage | Coverage is the strongest predictor of decision quality (Lu et al., 2012); discussion is biased toward already-known information (Stasser & Titus, 1985 — to verify) |
| ELICIT vague_information | an option was evaluated; no concrete task fact cited; nobody has since supplied facts | Information sharing predicts team performance (Mesmer-Magnus & DeChurch, 2009 — the unique-vs-openness claim is to verify) |
| Participation (code) | silence rule / quiet rule above | Knowing who knows what increases pooling (Stewart & Stasser, 1995; Stasser, Stewart & Wittenbaum, 1995 — to verify); public spotlighting has limited effect on low participators (DiMicco et al., 2004) |
| SCRUTINIZE unsupported_claim | a preference/claim was stated; no supporting task fact; ≥2 participants discussed the option/issue (design choice) | Preference-consistent evaluation (Greitemeyer & Schulz-Hardt, 2003); consider-the-opposite (Lord, Lepper & Preston, 1984) |
| SCRUTINIZE unresolved_concern | a concern was raised; nobody answered it | Dissent improves hidden-profile decisions mainly via more intense, less biased discussion (Schulz-Hardt et al., 2006) |
| SCRUTINIZE unclear_link / unclear_assumption | unchanged definitions | No literature distinguishes them in this paradigm (candidate for merging after validation) |
| INTEGRATE cross_option_evidence | ≥2 options under the same public criterion; not yet compared; ≥2 participants | Listing/structuring discussion content (Voigtländer et al., 2009 — to verify); leaders keep unshared information in play (Larson et al., 1996) |
| INTEGRATE fragmented_evidence | ≥3 messages, ≥2 participants (design choice); not yet connected | as above |
| INTEGRATE public_discrepancy | same object, measure and scope; conflicting; unresolved | Design choice |

## References

Verified (source and the claim used):
- Greitemeyer, T., & Schulz-Hardt, S. (2003). *JPSP, 84*(2), 322–339.
- Schulz-Hardt, S., Brodbeck, F. C., Mojzisch, A., Kerschreiter, R., & Frey, D. (2006). *JPSP, 91*(6), 1080– (end page to verify).
- Lu, L., Yuan, Y. C., & McLeod, P. L. (2012). *PSPR, 16*(1), 54–75.
- Larson, J. R., Jr., Christensen, C., Abbott, A. S., & Franz, T. M. (1996). *JPSP, 71*, 315–330.
- Lord, C. G., Lepper, M. R., & Preston, E. (1984). *JPSP, 47*(6), 1231–1243.
- DiMicco, J. M., Pandolfo, A., & Bender, W. (2004). *CSCW '04*.
- Alsobay, M. et al. (2025). arXiv:2508.08242.
- Mesmer-Magnus, J. R., & DeChurch, L. A. (2009). *Journal of Applied Psychology, 94*(2), 535–546 (overall claim only).

To verify:
1. Mesmer-Magnus & DeChurch (2009): whether unique-information sharing relates to performance more strongly than openness.
2. Stasser, G., & Titus, W. (1985). *JPSP, 48*, 1467–1478 — finding.
3. Stewart, D. D., & Stasser, G. (1995). *JPSP, 69*, 619–628 — finding.
4. Stasser, G., Stewart, D. D., & Wittenbaum, G. M. (1995). *JESP, 31*, 244–265 — finding.
5. Voigtländer et al. (2009). *Social Psychology, 40*(2), 79–; DOI 10.1027/1864-9335.40.2.79 — authors, pages, results.
6. Thürmer, J. L., Wieber, F., Schultze, T., & Schulz-Hardt, S. (2018). Hidden profile discussion coding. *Cambridge Handbook of Group Interaction Analysis*, 565–574 — coding categories.
7. Schulz-Hardt et al. (2006) — end page.
8. Mojzisch & Schulz-Hardt (2010) — source and finding.
9. "Interaction analysis codes each utterance on several dimensions" — find a source or drop the claim.

## Audit log fields (`llmLog`)

`detectorCandidates`, `selection` (`mode`, `pool`, `rejected`, `probability`,
`eligibleRoles`, `recentRoles`, `ignoredDefer`), `silenceRule` (`window`,
`silent`, `eligible`), `specialistFailure`, `fallbackRoute`, `optionMentionCounts`,
`participationCounts`, `quietParticipants`. Round state: `participationInvites`
(`count`, `atHumanMessageCount`) enforces the invitation cap and spacing. The
Markdown transcript export prints trigger source, selected role, selection
mode/pool roles/probability, silence-rule eligibility, Specialist failure,
fallback, Validator/deterministic failures, visible words and model calls.

## Intervention accounting

Only LLM-generated automatic checkpoint messages are interventions
(`totalInterventions`, message field `countsAsIntervention: true`). Replies to
@Facilitator requests are counted in `totalParticipantRequestReplies` and do not
reset the 6-message gate. Request fallbacks and fixed messages (opening,
silence nudges such as "No rush …") are not interventions, and fixed messages
do not invalidate an in-progress automatic result. The participant UI is
unchanged: fixed nudges still appear as Facilitator messages.

## Validation still required

The checklist is an operational definition. Before publication, a human-coded
sample (40–60 checkpoints, two coders) must report agreement and per-need
precision/recall of the detector. A live-model run of the new detector format
(`node server/real-adaptive-evaluation.mjs`) is needed to check the schema-valid
rate.


## Complete and concise synthesis (2026-10-30)

Synthesiser no longer has a 55-word ceiling. Coverage takes precedence over
length; use the shortest lossless wording after covering the required material.
Expander, Challenger and the control policies retain their existing word limits.

Detector seed quotes identify why integration is needed. Before generation,
`completeSynthesisPlan` expands allowed sources to the full current-round public
participant discussion. Consolidation and cross-option scoreboards cover all
public task information across the task alternatives, including qualifications,
corrections and unresolved concerns. Focused discrepancy representation still
covers the entire particular disagreement and can exclude unrelated topics.
Empty messages, greetings and logistics contain no task facts to summarise.
No private profile, answer key, AI statement or outside fact is added.

The semantic Validator must return a per-source coverage ledger in addition to
its thirteen flags, mapping source quotes to exact summary text. Each source's
ALL distinct facts must be checked, including multi-fact messages. Code verifies
that every source is accounted for exactly once, quote mappings exist, and
represented sources are cited. A missing/invalid audit or an omitted fact fails
validation; the Specialist is not repaired (2026-11-11) and the incomplete
synthesis is never published; the Static policy is used instead. Round-wide synthesis cannot exclude task sources merely because
they were absent from detector seeds. The ledger is a source-verified semantic
audit, not a deterministic proof that the model understood every fact correctly;
live-model replay and human review remain required.

Generation and coverage-audit token budgets scale with public input, with at
least 8192 output tokens to accommodate structure and reasoning. Provider
`finish_reason=length` results fail closed. The validator receives the public
transcript once, with source and recent-message IDs referencing it.
If public participant messages change during synthesis, refresh the transcript
and regenerate and validate once within the existing budget. If the transcript
changes again before publication, skip the synthesis.
Existing automatic time/lifecycle
budgets remain in place, so slow or oversized work may still produce no summary;
the system must never resolve this by silently deleting required facts.

## 2026-11-13 repairs after the two rehearsal sessions

Evidence: exported sessions `01M7ATWX2HQQ5C9EP6SPBB7XEQ` and `01M7B1FTT6TTSENCB6FX1Y5Y25`, plus repeated live sampling of the real Validator and detector on those transcripts (`gpt-5.6-luna`).

- **Unestablished criteria are dropped, not fatal.** The detector often names a comparison aspect in its own words ("accommodation" when participants said "rooms"). `dropUnestablishedCriteria()` removes such labels before selection and logs them as `droppedDetectorCriteria`. Preflight still refuses any unestablished label it is given. `CROSS_OPTION_COMPARISON` needs two option labels; a named criterion is optional. Before: 6/6 sampled integration candidates at one checkpoint were rejected `TARGET_UNSUPPORTED`; after: 6/6 qualified.
- **Every role is preflighted at selection** (`validatePlan`), so a drawn Expander/Challenger candidate cannot be blocked later at generation preflight.
- **Participation invitations.** `specialist/validator.md` now states that inviting a target to share from their own notes asserts no fact. Before: 11/26 sampled standard invitations rejected (`hiddenInformationInference`, `notGrounded`, …); after: 26/26 passed, while a control that asserts what the notes contain was rejected 6/6. An invitation that is attempted but not published now also starts the 12-message spacing window (`participationInvites[name].failedAttempts`, capped at 2), unless the invitee has posted meanwhile. The silence rule itself is unchanged (deterministic, no detector call).
- **Detector structure.** The detector call now sends a strict response schema derived from `assessor.schema.json` (`strictAssessorResponseSchema()`); explicit nulls for optional fields are removed before the canonical schema check. Earlier sessions lost about one detector call in ten to malformed JSON.
- **Adaptive Static turn.** A candidate rejected only for `GROUNDING_ID_NOT_PARTICIPANT_MESSAGE` / `UNKNOWN_GROUNDING_ID` uses its single Static repair instead of losing the checkpoint.
- **Export.** `transcript.md` prints Specialist Validator failures, preflight failures, rejected candidates, dropped criteria, detector errors, cancellation reasons and a Specialist-to-Static fallback count.

- **One Specialist repair is restored** (`generatorRepair: 1`; supersedes the 2026-11-11 "no Specialist repair" rule above). Once integration candidates qualified, the Synthesiser's first draft was usually rejected by the coverage check (`SYNTHESIS_COVERAGE_INCOMPLETE`, typically for omitted preference/leaning statements): 5 drafts, 5 rejections in one replay, each returning to Static. The Validator names the omitted message IDs, so the repair uses that feedback. A repetition rejection still goes straight to Static, and there is still no reselection. Cost: a repaired Synthesiser turn took about 70 s in replay.
- **Synthesis coverage audit** (`SynthesisCoverage.mjs`): a message that only states a preference, leaning, agreement or vote, or only asks a question, is `no_task_information`; facts, qualifications and concerns in a mixed message must still be covered. The Synthesiser repair prompt now says to keep what was covered and add the omitted content. Replays of session `01M7B1FTT6TTSENCB6FX1Y5Y25` (same transcript, `gpt-5.6-luna`): Synthesiser published 0/5 attempts with no repair, 1/5 with repair only, 4/9 with repair plus this audit change (three replays: 2/3, 0/4, 2/2). Remaining rejections are single omitted task details; a failed attempt costs 60–78 s before the Static turn.

## 2026-11-14 Synthesiser rebuilt on a per-message ledger

Supersedes the Synthesiser parts of the sections above (one-shot scoreboard generation, the 13-flag Validator with the `SYNTHESIS_COVERAGE_INCOMPLETE` audit, and the repair/coverage notes of 2026-11-13). Those paths are no longer used for Adaptive Synthesiser turns.

**Why.** The Synthesiser was all-or-nothing: one call wrote the whole scoreboard, a second had to prove nothing was omitted, and a single omitted detail discarded the message after 60–78 s. In replays of session `01M7B1FTT6TTSENCB6FX1Y5Y25` it published 0/5, 1/5 and 4/9 attempts across three successive repairs.

**Design (`SynthesisLedger.mjs`).**

1. Every public participant message of the round gets exactly one ledger entry: `points` (one or more statements, each with an exact quote from the message and an option), `repeats` (adds nothing beyond an earlier message), or `no_task_information` (greeting, logistics, bare preference/vote, bare question, remark about the discussion).
2. One extraction call proposes entries for the messages that have none yet (`specialist/ledger_extractor.md`); one independent audit call confirms or rejects each entry (`specialist/ledger_auditor.md`). Both use strict response schemas.
3. Code checks what code can check: one entry per message ID, quotes are substrings of the message, options are task options, no mentions, bounded length, repeats point to earlier represented messages.
4. Entries that fail are retried once with the reason, for those messages only. Anything still unconfirmed, missing, malformed, or affected by a model outage is replaced by **the participant's own words in quotation marks**, placed under the option the message names (otherwise "Other points").
5. Code renders the scoreboard: options in the task's authoritative order, points in first-appearance order, no names, plus one closing question (the model's if the auditor approved it, otherwise a fixed neutral question).
6. Confirmed entries are stored per round (`round.synthesisLedger`, keyed by message ID and bound to the exact text), so later scoreboards only ask the model about new messages. Quoted fallbacks are never cached.

**Guarantees enforced by code, not by model behaviour.**

- *Complete*: every message is `points`, quoted, a repeat of represented content, or explicitly excluded with a recorded reason; the audit log lists all of them (`synthesisLedger.accounted`).
- *Always deliverable*: no model verdict can discard the scoreboard. Only a lifecycle change (stage ended, a newer Facilitator message, the 20 s floor) or fewer than two information items stops it. An exhausted chain time budget does not.
- *Nothing unverified*: model-written text reaches participants only if its quote check passed and the auditor confirmed it.
- New participant messages that arrive during generation are folded in (up to two refreshes), then the scoreboard is published as complete up to its snapshot.
- A second scoreboard in a round requires at least one new information item since the previous one.

**Scoreboard guarantee per round.** If no Synthesiser scoreboard has been delivered: at the 180 s closeout tick it is built unless the detector selected a role or a participant is writing their own summary; at the 120 s tick it is built unconditionally, without a detector call and ahead of any other role; and at any checkpoint where two participants are publicly ready to finish it is built before the group moves on. Ticks are read from `triggerSources`, because a tick that coincides with a message opportunity is recorded with `triggerSource: "message"`.

**What is still a model judgement.** Wording quality; whether a message is "no task information" (two independent calls must agree, otherwise it is quoted); whether a point is faithful (same rule). **What cannot be guaranteed.** A scoreboard for a group that ends the discussion before any checkpoint and before 180 s remain, or that has shared fewer than two information items.

**Audit/export.** `routingDecision: "ADAPTIVE_LEDGER_SYNTHESIS"`, `synthesisLedger` (counts, per-message accounting, fallbacks with reasons, model calls, latency), `selection.guarantee`. `transcript.md` prints a "Synthesis ledger" line and any "Ledger fallbacks".

## 2026-11-15 Static-policy turn

The Adaptive Static-policy turn (no eligible Specialist, or a Specialist that failed twice) now sends the Alsobay et al. request used by the Static condition and posts its `MESSAGE` without validation. See [static-alsobay-replication.md](static-alsobay-replication.md). The grounding-ID repair described above no longer applies to it.
