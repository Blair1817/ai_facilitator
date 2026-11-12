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
