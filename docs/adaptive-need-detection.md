# Adaptive need detection and role selection (updated 2026-10-30)

This document describes how the Adaptive facilitator decides which role speaks
at an automatic checkpoint. The 2026-10-30 selection update uses current
blockers and waiting time before random tie-breaking. It replaces the role-priority description in
`server/IMPLEMENTATION_LOGIC.md` and `LLM_DETECTOR_ONLY.md`, which are outdated
on this point. Automatic pacing is six human messages and a 15 s attempt cooldown for both
Static and Adaptive. Existing time floors, UI and experiment procedure remain.

## Division of labour

| Step | Done by | What |
|---|---|---|
| 1. Judge each need | LLM detector (`specialist/assessor.md`, reasoning effort `low`) | ELICIT, SCRUTINIZE and INTEGRATE are judged independently against checklists; each is null or one operation + target + exact quotes |
| 2. Verify evidence | Code (`EvidenceChecker.checkNeedAssessment`, per candidate) | Exact quotes from the cited public messages; ≥2 distinct participants for SCRUTINIZE/INTEGRATE; ≥3 messages for fragmented_evidence; operation matches need |
| 3. Choose the role | Code (`AdaptiveEvidence.selectAdaptiveAssessment`) | Summary pause, participation rule, then evidenced blocker / longest wait / role rotation / random tie-break |

Participation (inviting a quiet or silent participant) is decided by code only;
the detector never reports it.

## Selection (message-triggered Adaptive checkpoints)

1. **Participation rule (deterministic, not randomized).** At a message checkpoint,
   invite all roster participants who are quiet overall (zero messages while
   others have spoken, or fewer than half the others' mean once that mean is
   at least two), or silent across the last `SILENCE_WINDOW = 12` public
   participant messages (the latter requires at least 12 messages). All eligible
   names are invited together in one Expander message. No per-person invitation
   cap or message spacing applies; the shared six-message/15 s pacing still does.
   The detector is called first to preserve explicit participant-summary deferral;
   otherwise this code rule takes precedence over substantive candidates.
   Logged as `selection.mode = "rule_triggered"` and `participationRule`.
   It replaces the checkpoint message, adding no publication. Static is unaffected.
2. **Candidate pool.** When no participation invitation is due, use the verified
   substantive detector candidates. Participation never enters the random pool.
3. **Prioritise, then break ties.** A qualified ELICIT candidate can report
   `blocking.kind = "missing_comparison_information"` only when participants
   explicitly cannot compare/proceed because the target information is missing.
   A qualified SCRUTINIZE candidate can report `decision_reasoning_risk` only
   when an unresolved target claim/reasoning is being used to choose/end/submit
   now. Both kinds have the same priority, above ordinary needs. INTEGRATE has
   no blocker annotation; it still needs sufficient, unfinished public material.
   Code checks all blocker quotes against public participant messages, requires
   a quote among the last six messages and a quote also cited in the target.
   Invalid annotations lose priority without discarding the underlying need.
   These are source checks: the interpretation remains an LLM judgement.

   Within the highest tier, select the continuously eligible target that has
   waited the most public participant messages since first observation. Retry
   attempts and elapsed seconds do not add waiting credit. Target keys use
   operation, stable semantic issue key (legacy fallback: target label), options
   and criteria; new message IDs do not reset a stable issue. If identity changes,
   waiting credit conservatively resets. Disappeared targets are removed. Only
   successful publication removes the served target; failed generation or Static
   fallback leaves it pending. Timed scans and summary pauses preserve the queue.

   Within the remaining tie, skip a role used for the last two Specialist turns
   if another tied role exists; then draw uniformly by role, and within that role.
   Rotation never overrides a higher priority or longer wait. The exact final
   probability, priority reason, quote evidence and waiting credit are logged as
   `selection.mode = "prioritized"`. This policy is a design choice requiring
   preregistration and live-model validation; it is not an empirical optimum.
4. **Empty pool** → Static policy message (as before).
5. **Repetition rejection** by the Validator → one redraw from the remaining
   pool using the same priority/waiting policy (no new detector call); nothing left → Static policy message.

Scheduler-triggered closeout checks (180 s, 120 s, early-closeout probe) keep
their existing integration-only scope.

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
`eligibleRoles`, `recentRoles`, `redraw`), `silenceRule` (`window`, `silent`,
`eligible`), `participationRule` (`eligible`, `mode`), `optionMentionCounts`, `participationCounts`, `quietParticipants`.
Round state: `adaptivePendingCandidates` stores current target waiting records;
`participationInvites` records delivered invitation counts for audit only; it imposes no cap or spacing.

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
validation and feeds the existing bounded repair path. Persistent failure never
publishes the incomplete synthesis; the existing recovery may use a process-only
Static fallback. Round-wide synthesis cannot exclude task sources merely because
they were absent from detector seeds. The ledger is a source-verified semantic
audit, not a deterministic proof that the model understood every fact correctly;
live-model replay and human review remain required.

Generation and coverage-audit token budgets scale with public input, with at
least 8192 output tokens to accommodate structure and reasoning. Provider
`finish_reason=length` results fail closed. Existing automatic time/lifecycle
budgets remain in place, so slow or oversized work may still produce no summary;
the system must never resolve this by silently deleting required facts.
