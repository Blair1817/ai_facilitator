/** Static facilitator replicated from Alsobay et al.
 *
 * Source of truth: microsoft/ai_facilitator, commit 2a0c688
 * (server/src/callbacks.js and server/src/LLMConfig.js), treatment
 * `llmFacilitation_noCue` (facilitation LLM, llmRequestInterval 90,
 * requireLLMMessage true).
 *
 * Reproduced exactly: the system prompt text (requireLLMMessage = true, so the
 * "must respond" output format is used both for timed requests and for
 * @[Facilitator] requests), the four-message request layout, the transcript
 * line format, a request every 90 s from the start of the Task stage, no
 * request when the latest transcript message is from the Facilitator, no
 * request in the last 20 s, JSON-object output, no word limit, no validation
 * and no retry: the returned MESSAGE is posted as is.
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
export const ALSOBAY_REQUEST_INTERVAL_MS = 90_000;
export const ALSOBAY_STOP_BEFORE_END_MS = 20_000;

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
export function lastSenderIsFacilitator(chat) {
  return alsobayTranscript(chat).at(-1)?.sender?.id === "ai";
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

/** Next 90 s tick after `now`, counted from the Task stage start; null once inside the last 20 s. */
export function nextAlsobayTick({ taskStartTime, deadline, now, completedThrough = 0 }) {
  if (!Number.isFinite(taskStartTime) || !Number.isFinite(deadline)) return null;
  let index = Math.max(completedThrough + 1, Math.floor((now - taskStartTime) / ALSOBAY_REQUEST_INTERVAL_MS) + 1);
  const at = taskStartTime + index * ALSOBAY_REQUEST_INTERVAL_MS;
  if (at >= deadline - ALSOBAY_STOP_BEFORE_END_MS) return null;
  return { index, at };
}

/** One timer per Static Task stage. `run(game, { tickIndex })` performs the request. */
export function createAlsobayStaticScheduler({ run, now = () => Date.now(), setTimer = (...a) => setTimeout(...a), clearTimer = h => clearTimeout(h), onError = () => {} }) {
  const entries = new Map();
  const current = e => e.game.currentRound?.id === e.round.id && e.game.currentStage?.id === e.stage.id
    && e.stage.get("name") === "Task" && !e.stage.get("ended") && !e.game.get("ended") && !e.game.get("endedAt");
  function cancel(game) {
    const e = entries.get(game?.id);
    if (!e) return;
    clearTimer(e.timer);
    entries.delete(game.id);
  }
  function schedule(e) {
    clearTimer(e.timer);
    const next = nextAlsobayTick({ taskStartTime: e.game.get("taskStartTime"), deadline: e.game.get("deadline"), now: now(),
      completedThrough: e.round.get("alsobayStaticLastTick") || 0 });
    if (!next) { entries.delete(e.game.id); return; }
    e.next = next;
    e.timer = setTimer(() => tick(e, next.index), Math.max(0, next.at - now()));
    e.timer?.unref?.();
  }
  async function tick(e, index) {
    if (entries.get(e.game.id) !== e) return;
    if (!current(e)) { cancel(e.game); return; }
    // At most one request per tick, also across a callbacks restart.
    if ((e.round.get("alsobayStaticLastTick") || 0) < index) {
      e.round.set("alsobayStaticLastTick", index);
      try { await run(e.game, { tickIndex: index }); } catch (error) { onError(error); }
    }
    if (entries.get(e.game.id) === e && current(e)) schedule(e);
  }
  function register(game) {
    const round = game?.currentRound, stage = game?.currentStage;
    if (round?.get("facilitation") !== "static" || round.get("isPractice") || stage?.get("name") !== "Task") return null;
    const old = entries.get(game.id);
    if (old?.round.id === round.id && old.stage.id === stage.id) return old;
    if (old) cancel(game);
    const e = { game, round, stage, timer: null, next: null };
    entries.set(game.id, e);
    schedule(e);
    return entries.get(game.id) ?? null;
  }
  return { register, cancel, pending: game => entries.get(game?.id)?.next ?? null };
}
