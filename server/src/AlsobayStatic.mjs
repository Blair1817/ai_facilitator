/** Static facilitator replicated from Alsobay et al.
 *
 * Source of truth: microsoft/ai_facilitator, commit 2a0c688
 * (server/src/callbacks.js and server/src/LLMConfig.js), treatment
 * `llmFacilitation_noCue` (facilitation LLM, llmRequestInterval 90,
 * requireLLMMessage true).
 *
 * Reproduced exactly: the system prompt text (requireLLMMessage = true, so the
 * "must respond" output format is used for automatic and @[Facilitator]
 * requests), the four-message request layout, the transcript line format,
 * JSON-object output, no word limit, no validation and no retry: the returned
 * MESSAGE is posted as is.
 *
 * Kept from this study's design (2026-11-16), as a control variable shared with
 * the Adaptive condition: WHEN Static speaks. Automatic requests are made at
 * the shared six-message checkpoint (cooldown, time floor, one automatic
 * pipeline at a time), not on the original 90 s timer.
 *
 * Necessary adaptations (documented in docs/static-alsobay-replication.md):
 * - the task sentence names this study's task and its options instead of the
 *   hard-coded "three cities (Eldoron, Myloria, Cragnio)";
 * - the transcript is the current round's public discussion (participants and
 *   Facilitator, including the shared platform messages); timer reminders are
 *   excluded, as they did not exist in the original;
 * - an empty or missing MESSAGE is not posted (the original would have posted
 *   "undefined").
 */

export const ALSOBAY_SOURCE_COMMIT = "2a0c688";

// Task sentence substituted for "which of three cities (Eldoron, Myloria, Cragnio) should host a large sporting event".
const TASK_SUBJECT = {
  A: { plural: "cities", purpose: "should host the International Youth Games" },
  B: { plural: "university campuses", purpose: "should host the Global Innovation Summit" },
};
export function alsobayTaskSentence(taskVersion, optionLabels = []) {
  const subject = TASK_SUBJECT[taskVersion] ?? { plural: "options", purpose: "should be chosen" };
  const count = ["zero", "one", "two", "three", "four", "five"][optionLabels.length] ?? String(optionLabels.length);
  return `which of ${count} ${subject.plural} (${optionLabels.join(", ")}) ${subject.purpose}`;
}

/** LLMConfig.js llmSystemPrompts("LLM", true), verbatim apart from the task sentence. */
export function alsobaySystemPrompt(taskSentence) {
  const llmMustRespond = `MESSAGE: Include the text of your message here -- DO NOT USE MARKDOWN, but you can add newlines for formatting.
    RATIONALE: Explain why you chose the message you did. `;
  return `A group of decision makers are meeting to decide on ${taskSentence}. 
    As a facilitator for this meeting, your specific role is help the group make a decision by, first, making sure that everyone is heard from and shares what they know and, second, acting as a scoreboard and keeping track of pros and cons. 
    People may have different information about what is being discussed in this meeting, so encourage everyone to share all of the relevant information they have.
    You will periodically receive the transcript of the group's conversation so far (as well as any previous messages you've sent the group), and you will be able to provide your input.
    Messages you have previously sent to the group will be included in the transcript you receive, and will be shown as sent by the "Facilitator". 
    You're given the time remaining for the group to make a decision, and each message in the transcript has a timestamp. 
    When given the transcript, you should respond with a JSON containing the following: 
    
    ${llmMustRespond}
    
    Remember the following: 
    When intervening, you should aim to be as concise as possible while still providing all the necessary guidance.
    You can tag a specific person in your message by using the "@" symbol followed by their name in square brackets (e.g. "@[NAME]"). If you do not use the square brackets, the tag will not work.
    ONLY RESPOND IN JSON FORMAT, DO NOT RESPOND IN PLAIN TEXT!`;
}

/** callbacks.js formatDuration, verbatim. */
export function formatDuration(duration) {
  const totalSeconds = Math.floor(duration / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  const formattedMinutes = minutes > 0 ? `${minutes} mins` : '';
  const formattedSeconds = `${seconds} seconds`;
  return `${formattedMinutes}${formattedMinutes && formattedSeconds ? ', ' : ''}${formattedSeconds}`;
}

const isTimer = m => m?.speakerType === "timer_reminder" || m?.messageType === "timer_reminder" || m?.sender?.id === "system";
const isDiscussion = m => (m?.stage ?? "Discussion") === "Discussion";
/** The messages the original transcript would have contained. */
export function alsobayTranscript(chat) {
  return (Array.isArray(chat) ? chat : []).filter(m => m && isDiscussion(m) && !isTimer(m)
    && typeof (m.text ?? m.content) === "string");
}

/** The exact request layout of the original (after its four unshift calls). */
export function buildAlsobayMessages({ chat, attendees, taskSentence, now, taskStartTime, deadline }) {
  const transcript = alsobayTranscript(chat);
  return [
    { content: alsobaySystemPrompt(taskSentence), role: "system" },
    { content: `Meeting attendees: ${attendees.join(", ")}`, role: "system" },
    { content: `[TIME ELAPSED: ${formatDuration(now - taskStartTime)}]`, role: "system" },
    { content: `[TIME REMAINING: ${formatDuration(deadline - now)}]`, role: "system" },
    { content: transcript.map(m => `[${formatDuration(now - (m.ts ?? m.timestamp))} ago] ${m.sender?.name}: ${m.text ?? m.content}`).join("\n"), role: "user" },
  ];
}

/** JSON.parse of the returned text, as in the original; MESSAGE must be a non-empty string. */
export function parseAlsobayResponse(rawText) {
  let llmAction;
  try { llmAction = JSON.parse(rawText); } catch (error) { return { ok: false, error: `Invalid JSON: ${error.message}` }; }
  if (!llmAction || typeof llmAction !== "object" || typeof llmAction.MESSAGE !== "string" || !llmAction.MESSAGE.trim())
    return { ok: false, error: "LLM response missing a non-empty MESSAGE", llmAction };
  return { ok: true, llmAction };
}
