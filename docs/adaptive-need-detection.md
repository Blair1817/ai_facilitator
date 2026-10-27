# Adaptive need detection and role selection (2026-10-26)

This document describes how the Adaptive facilitator decides which role speaks
at an automatic checkpoint. It replaces the role-priority description in
`server/IMPLEMENTATION_LOGIC.md` and `LLM_DETECTOR_ONLY.md`, which are outdated
on this point. Pacing (6 human messages, 30 s cooldown, time floors), the
Static condition, the Generator/Validator prompts, the UI and the experiment
procedure are unchanged.

## Division of labour

| Step | Done by | What |
|---|---|---|
| 1. Judge each need | LLM detector (`specialist/assessor.md`, reasoning effort `low`) | ELICIT, SCRUTINIZE and INTEGRATE are judged independently against checklists; each is null or one operation + target + exact quotes |
| 2. Verify evidence | Code (`EvidenceChecker.checkNeedAssessment`, per candidate) | Exact quotes from the cited public messages; ≥2 distinct participants for SCRUTINIZE/INTEGRATE; ≥3 messages for fragmented_evidence; operation matches need |
| 3. Choose the role | Code (`AdaptiveEvidence.selectAdaptiveAssessment`) | Silence rule first; otherwise a uniform random draw among verified candidates |

Participation (inviting a quiet or silent participant) is decided by code only;
the detector never reports it.

## Selection (message-triggered Adaptive checkpoints)

1. **Silence rule (deterministic, not randomized).** A roster participant with
   no message among the last `SILENCE_WINDOW = 12` public participant messages
   (two 6-message checkpoint intervals) is invited by the Expander
   (`PARTICIPATION_ELICITATION`). No detector call is made. Not checked before
   12 public messages exist. Per participant and round: at most
   `PARTICIPATION_INVITE_CAP = 2` invitations, none within 12 human messages of
   the previous one. Several eligible participants: one is chosen at random.
   Logged as `selection.mode = "rule_triggered"`. It replaces that checkpoint's
   message, so it adds no publication. Static is unaffected.
2. **Candidate pool.** Verified detector candidates plus one code candidate for
   a quiet participant (fewer than half the others' mean message count; same
   invitation cap and spacing).
3. **Uniform draw.** A role is drawn uniformly among roles present in the pool,
   then a candidate uniformly within that role. A role that filled the last two
   Specialist turns is skipped when another role is available. The exact
   probability is logged. There is no priority between needs.
4. **Empty pool** → Static policy message (as before).
5. **Repetition rejection** by the Validator → one redraw from the remaining
   pool (no new detector call); nothing left → Static policy message.

Scheduler-triggered closeout checks (180 s, 120 s, early-closeout probe) keep
their existing integration-only scope.

## Checklists and their basis

Each item must hold for the need to be reported. "Design choice" means no
direct literature basis; these are to be pre-registered.

| Need / operation | Checklist | Basis |
|---|---|---|
| ELICIT coverage_gap | option is a task alternative and not ruled out; clearly fewer concrete public facts than other options (code supplies `OPTION_MENTION_COUNTS`); nobody currently supplying/requesting it | Coverage is the strongest predictor of decision quality (Lu et al., 2012); discussion is biased toward already-known information (Stasser & Titus, 1985 — to verify) |
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
`eligible`), `optionMentionCounts`, `participationCounts`, `quietParticipants`.
Round state: `participationInvites`.

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
