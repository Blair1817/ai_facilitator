# Static condition: replication of Alsobay et al.

Since 2026-11-15 the Static condition sends the LLM facilitator request of
Alsobay et al. and posts its reply as they did. The upstream is
`microsoft/ai_facilitator` at commit `2a0c688`, treatment
`llmFacilitation_noCue` (`facilitation: LLM`, `llmRequestInterval: 90`,
`requireLLMMessage: true`). Verbatim copies of the original `LLMConfig.js`,
`callbacks.js` and `treatments.yaml` are kept in
`server/test/fixtures/alsobay_2a0c688/`; `server/src/AlsobayStatic.test.mjs`
compares the implementation against them.

Implementation: `server/src/AlsobayStatic.mjs` (prompt, request layout,
parsing) and `alsobayStaticTurn()` / `runAlsobayStatic()` in
`server/src/callbacks.js`.

**When Static speaks is kept from this study's design** (decided 2026-11-16):
experimental conditions and control variables are unchanged, so Static uses the
same message checkpoint as Adaptive (six participant messages since the last
automatic message, the 15 s cooldown, the 10 s time floor, one automatic
request at a time), not the original 90 s timer.

## Identical to the original

| Aspect | Behaviour |
|---|---|
| System prompt | `llmSystemPrompts("LLM", true)` character for character, apart from the task sentence. `requireLLMMessage: true` means the "must respond" output format (`MESSAGE`, `RATIONALE`); there is no WAIT/INTERVENE choice. |
| Request | Four system messages (prompt, `Meeting attendees: …`, `[TIME ELAPSED: …]`, `[TIME REMAINING: …]`) and one user message with the transcript, each line `[<duration> ago] <name>: <text>`, using the original `formatDuration`. |
| Output | JSON-object mode; `MESSAGE` is posted exactly as returned. No word limit, no Generator/Validator checks, no repair, no retry. `max output tokens` = `LLM_MAX_OUTPUT_TOKENS` (1000). |
| @[Facilitator] | The same prompt and request, required to respond, sent immediately. Nothing is posted if the request fails (no safe fallback message). |
| Requests and replies | No supersession: an automatic reply and an @ reply can both be posted. |

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
- **Timing (study control).** See above: the shared six-message checkpoint
  instead of the 90 s timer and its "skip if the Facilitator spoke last" rule.
- **Posting** uses the shared publication path, so nothing is posted after the
  Task stage or the game ended.
- **Model.** The same model as the Adaptive condition (`OPENAI_MODEL`), not
  GPT-4o, a study control.

Unchanged study design: group size, discussion length, task materials, the
checkpoint timing above, the opening message, silence nudges and timer
reminders (shared by both conditions).

## Adaptive condition

When Adaptive has no eligible Specialist (or a Specialist fails twice), its
Static-policy turn sends the same Alsobay request with the same transcript and
posts `MESSAGE` the same way. @[Facilitator] in Adaptive still uses the
participant-requested Generalist.

## Removed

The Static opportunity scheduler (`StaticInterventionScheduler.mjs`, with its
outer retries and retry feedback in `StaticRetryFeedback.mjs`), the `control_50`
Static prompt path, the Static Validator route and the Static matched delay
(`STATIC_MATCHED_DELAY_MS`) are no longer used. A failed Static request is not
retried; the next eligible checkpoint makes a new one, as in Adaptive. See `static-intervention-scheduling.md` for the earlier design.

On 2026-11-19 the unused prompt package was deleted rather than left in place:
`runtime/control_50/` (Static and automatic-Generalist base, prompts, Validator
and schemas, plus the simulator copy), the `static` and `generalist` routes in
`runtime/manifest.json`, `getStaticPromptBundle()`, `getGeneralistPromptBundle()`,
the Static branch of `buildGeneratorContext()` and `buildStaticUserContext()`.
`llmSystemPrompts("static")` and `llmSystemPrompts("adaptive", "generalist")`
now return a blocked result, and asking for a generation schema or Validator for
an automatic non-Specialist role throws or blocks instead of reading a missing
file. `frozen_control/` (participant-requested Generalist, plus the historical
baseline `frozen_control/static.md`) and the legacy `prompts/source/*.md` are
kept.

## Consequence to keep in mind

Without validation, Static messages can misattribute a point, suggest criteria
that are not in the task, or ask for preferences, exactly as the original
could. In a live check with the study's model, four of four replies were valid
JSON and posted in 2.6–3.9 s; one attributed a Talwick drawback to Rovenna.
