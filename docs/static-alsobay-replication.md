# Static condition: replication of Alsobay et al.

Since 2026-11-15 the Static condition reproduces the LLM facilitator of
Alsobay et al., i.e. the upstream of this repository,
`microsoft/ai_facilitator` at commit `2a0c688`, treatment
`llmFacilitation_noCue` (`facilitation: LLM`, `llmRequestInterval: 90`,
`requireLLMMessage: true`). Verbatim copies of the original `LLMConfig.js`,
`callbacks.js` and `treatments.yaml` are kept in
`server/test/fixtures/alsobay_2a0c688/`; `server/src/AlsobayStatic.test.mjs`
compares the implementation against them.

Implementation: `server/src/AlsobayStatic.mjs` (prompt, request layout,
parsing, 90 s scheduler) and `runAlsobayStatic()` in `server/src/callbacks.js`.

## Identical to the original

| Aspect | Behaviour |
|---|---|
| Trigger | One request every 90 s from the start of the Task stage (`setInterval`); none in the last 20 s. 15-minute discussion: 90, 180, …, 810 s. |
| Skip rule | No request when the latest transcript message is from the Facilitator, or when there is no message. |
| Participant messages | Never trigger an automatic message. |
| System prompt | `llmSystemPrompts("LLM", true)` character for character, apart from the task sentence. `requireLLMMessage: true` means the "must respond" output format (`MESSAGE`, `RATIONALE`); there is no WAIT/INTERVENE choice. |
| Request | Four system messages (prompt, `Meeting attendees: …`, `[TIME ELAPSED: …]`, `[TIME REMAINING: …]`) and one user message with the transcript, each line `[<duration> ago] <name>: <text>`, using the original `formatDuration`. |
| Output | JSON-object mode; `MESSAGE` is posted exactly as returned. No word limit, no Generator/Validator checks, no repair, no retry. `max output tokens` = `LLM_MAX_OUTPUT_TOKENS` (1000). |
| @[Facilitator] | The same prompt and request, required to respond, sent immediately. Nothing is posted if the request fails (no safe fallback message). |
| Concurrency | No lock or supersession: a timed reply and an @ reply can both be posted. |

## Necessary adaptations

- **Task sentence.** The original hard-codes "which of three cities (Eldoron,
  Myloria, Cragnio) should host a large sporting event". It is replaced by this
  study's task and its options in the round's option order: Task A "which of
  three cities (…) should host the International Youth Games", Task B "which of
  three university campuses (…) should host the Global Innovation Summit".
- **Transcript.** The current round's public discussion: participants and the
  Facilitator, including the shared platform messages (opening message, silence
  nudges). Timer reminders, which did not exist in the original, are excluded
  and do not count for the skip rule.
- **Empty MESSAGE.** A reply without a non-empty `MESSAGE` string is not posted
  (the original would have posted `undefined`).
- **Transport.** Chat Completions with `response_format: {type: "json_object"}`
  (the original used the Responses API with `text.format: json_object`).
- **Robustness.** Ticks are anchored to the Task start time and the last tick
  run is stored on the round (`alsobayStaticLastTick`), so a callbacks restart
  continues at the next tick without repeating one. Posting uses the shared
  publication path, so nothing is posted after the Task stage or the game ended.
- **Model.** The same model as the Adaptive condition (`OPENAI_MODEL`), not
  GPT-4o, so the two conditions differ only in facilitation policy.

Not part of the facilitator and unchanged: group size, discussion length, task
materials, the opening message, silence nudges and timer reminders (shared by
both conditions).

## Adaptive condition

When Adaptive has no eligible Specialist (or a Specialist fails twice), its
Static-policy turn sends the same Alsobay request with the same transcript and
posts `MESSAGE` the same way. @[Facilitator] in Adaptive still uses the
participant-requested Generalist.

## Removed

The message-triggered Static scheduler (`StaticInterventionScheduler.mjs`,
`StaticRetryFeedback.mjs`), the `control_50` Static prompt path, the Static
Validator route and the Static matched delay (`STATIC_MATCHED_DELAY_MS`) are no
longer used. See `static-intervention-scheduling.md` for the earlier design.

## Consequence to keep in mind

Without validation, Static messages can misattribute a point, suggest criteria
that are not in the task, or ask for preferences, exactly as the original
could. In a live check with the study's model, four of four replies were valid
JSON and posted in 2.6–3.9 s; one attributed a Talwick drawback to Rovenna.
