# Mini meeting-room practice

New games replace the old Walkthrough / Icebreaker / countdown sequence with:

Welcome → Reading → Initial choice → Discussion guide → Discussion → Group decision → Complete.

The practice round is marked `isPractice`, `phase=practice` and
`exclude_from_primary_analysis=true`. It has no formal task index or facilitation condition.
The existing Green / Blue / Pink identities are retained across the entire experiment.
Pink receives the specification's Orange information; Blue and Green receive their named reports.

## Behaviour

- Reading, initial choice, guide acknowledgement and completion wait for all three participants.
- The four-minute discussion begins only after everyone has acknowledged the guide.
- The server stores the start time, deadline, message counts and readiness state.
- The timer is hidden by default, can be toggled individually, and is forced visible in the last 30 seconds.
- Early completion requires two minutes, at least one human message from each participant,
  six human messages in total, and unanimous readiness. Readiness can be cancelled.
- The fixed Facilitator welcome is published once. Practice never enters either formal LLM pipeline.
- Group decision reuses `FinalDecision` and its existing server validation: matching choices,
  confidence from everyone, and three confirmations. The formal “Fail to reach a final decision”
  option is retained. Practice has no decision timeout or correctness feedback.
- The formal round still resets its checkpoint state and reads only its own transcript.

Configuration is in `shared/practice.mjs`. Empirica 1.12 requires a numeric stage duration;
untimed teaching steps use the supported maximum (1e9 seconds, approximately 31 years)
as a framework placeholder. No participant countdown or ordinary-session timeout applies there.

## Data and isolation

Practice messages use `game.practice_chat` and include phase, source, speaker, timestamp and
analysis-exclusion metadata. Accepted request IDs are deduplicated before incrementing counts.
Debug events use the bounded `practiceEvents.<id>` / `practiceEventsIndex` format.
Private initial-choice/confidence events stay on the owner's playerRound; other events are game-level.
These remain available in the raw Tajriba store. The research export already selects only the two
formal rounds, and practice responses/messages are excluded from the Supabase outcome mirror.

## Verification

`node --test server/src/PracticeOnboarding.test.mjs` exercises three-player state transitions,
colour/report assignment, message counting, replay deduplication, readiness, timer behaviour,
deadline recovery and completion. Existing lifecycle, quiz, experimental policy and checkpoint
tests cover the shared formal components and formal-state reset.

Before deployment, rehearse with three real Empirica clients, including a refresh during discussion
and a completed group decision. Local browser component checks use a simulated session and do
not substitute for that multi-client transport check.
