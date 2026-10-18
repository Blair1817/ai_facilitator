import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { PRACTICE, PRACTICE_STAGES, PRACTICE_CHAT, practiceReadiness } from "../../shared/practice.mjs";
import { DISCUSSION_OPENING_MESSAGE } from "../../shared/discussionOpening.mjs";
import { resolveTimerVisibility } from "../../shared/timerVisibility.mjs";
import { addPracticeRound, deliverPracticeDiscussionReminder, deliverPracticeSilenceNudge, initialisePractice, handlePracticeStageStart, registerPractice, handlePracticeMessage, PRACTICE_SILENCE_NUDGE_DELAY_MS } from "./PracticeOnboarding.mjs";

const dirname = path.dirname(fileURLToPath(import.meta.url));
const practiceClientSource = readFileSync(path.join(dirname, "../../client/src/practice/PracticeOnboarding.jsx"), "utf8");
const reportSource = readFileSync(path.join(dirname, "../../client/src/components/PlayerSpecificInfo.jsx"), "utf8");

function scope(id, attributes = {}) {
  const data = new Map(Object.entries(attributes));
  return { id, get: (key) => data.get(key), set: (key, value) => data.set(key, value), data };
}
function fixture(name = "PracticeDiscussion") {
  const game = scope("game"), round = scope("practice", { isPractice: true, index: 0 });
  const stage = scope("stage", { name });
  stage.round = round; stage.currentGame = game; stage.isCurrent = () => !stage.get("ended");
  round.currentGame = game; game.currentRound = round; game.currentStage = stage;
  game.players = ["Blue", "Pink", "Green"].map((colour, index) => ({
    ...scope("p" + index, { name: colour, hexCode: "206EEF" }),
    currentGame: game, round: scope("pr" + index), stage: scope("ps" + index),
  }));
  const listeners = new Map();
  const messages = [];
  const append = (_game, attribute, value) => messages.push({ attribute, ...value });
  const api = {
    on: (_kind, key, fn) => listeners.set(key, fn),
    flush: () => {},
  };
  registerPractice(api, append);
  listeners.set("start", ({ stage: startedStage }) => handlePracticeStageStart(startedStage, append, api));
  const request = (player, action, fields = {}) => listeners.get("practiceRequest")({}, {
    player, practiceRequest: { action, stageId: stage.id, roundId: round.id, ...fields },
  });
  const send = (player, id, content = "Hello") => handlePracticeMessage(player, {
    requestId: id, roundId: round.id, stageId: stage.id, content,
  }, append, api);
  return { game, round, stage, players: game.players, listeners, messages, request, send };
}

test("practice replaces the old icebreaker with a single non-formal rehearsal", () => {
  let attributes, stages = [];
  addPracticeRound({ addRound: (value) => { attributes = value; return { addStage: (s) => stages.push(s) }; } });
  assert.deepEqual(stages.map((s) => s.name), PRACTICE_STAGES);
  assert.equal(stages.find((s) => s.name === "PracticeDiscussion").duration, 240);
  assert.equal(stages.find((s) => s.name === "FinalDecision").duration, 90);
  assert.equal(attributes.isPractice, true);
  assert.equal(attributes.ai_intervention_enabled, false);
  assert.equal(attributes.taskIndex, undefined);
  assert.equal(attributes.facilitation, undefined);
});
test("reports preserve colours, share context, and give each participant distinct additional facts", () => {
  const { round, players } = fixture();
  initialisePractice(round);
  assert.match(round.get("generalInfo"), /Maple Room/);
  assert.match(players[0].round.get("playerContent"), /reliable Wi-Fi/);
  assert.match(players[1].round.get("playerContent"), /large working display/);
  assert.match(players[2].round.get("playerContent"), /arranged in a circle/);
  assert.deepEqual(players.map((p) => p.get("name")), ["Blue", "Pink", "Green"]);
  assert.doesNotMatch(JSON.stringify([...round.data]), /optimum|correct answer/i);
});
test("all three must complete reading; duplicate and stale requests do not advance", () => {
  const f = fixture("PracticeReading");
  f.request(f.players[0], "continue");
  f.request(f.players[0], "continue");
  f.request(f.players[1], "continue", { stageId: "old" });
  assert.equal(f.stage.get("ended"), undefined);
  f.request(f.players[1], "continue");
  assert.equal(f.stage.get("ended"), undefined);
  f.request(f.players[2], "continue");
  assert.equal(f.stage.get("ended"), true);
});
test("initial submission validates confidence including zero, persists privately, and waits for everyone", () => {
  const f = fixture("PracticeInitialChoice");
  f.request(f.players[0], "continue", { choice: "MAPLE", confidence: null });
  assert.equal(f.players[0].stage.get("practiceDone"), undefined);
  f.request(f.players[0], "continue", { choice: "MAPLE", confidence: 0 });
  assert.equal(f.players[0].round.get("initialDecision").confidence, 0);
  assert.equal(f.stage.get("ended"), undefined);
  assert.equal(f.game.get("practiceEventsIndex"), undefined);
  assert.equal(f.players[0].round.get("practiceEventsIndex").length, 2);
});
test("discussion start is idempotent with one fixed non-LLM Facilitator opening", () => {
  const f = fixture();
  f.listeners.get("start")({ stage: f.stage });
  const startedAt = f.round.get("practiceDiscussionStartedAt");
  f.send(f.players[0], "one");
  f.listeners.get("start")({ stage: f.stage });
  assert.equal(f.round.get("practiceDiscussionStartedAt"), startedAt);
  assert.equal(f.round.get("practiceDeadline"), startedAt + 240000);
  assert.equal(f.messages.filter((m) => m.speakerType === "facilitator_fixed").length, 1);
  const opening = f.messages.find((m) => m.facilitatorTrigger === "PRACTICE_DISCUSSION_OPENING");
  assert.equal(opening.content, DISCUSSION_OPENING_MESSAGE);
  assert.equal(f.round.get("practiceMessageCounts").p0, 1);
  assert.equal(f.game.get("humanMessageCount"), undefined);
});
test("Practice Discussion sends distinct fixed nudges for opening silence and a later lull", () => {
  const f = fixture();
  f.listeners.get("start")({ stage: f.stage });
  const append = (_game, attribute, value) => f.messages.push({ attribute, ...value });
  const startedAt = f.round.get("practiceDiscussionStartedAt");

  assert.equal(deliverPracticeSilenceNudge(f.stage, append, { flush() {} }, startedAt + PRACTICE_SILENCE_NUDGE_DELAY_MS - 1), false);
  assert.equal(deliverPracticeSilenceNudge(f.stage, append, { flush() {} }, startedAt + PRACTICE_SILENCE_NUDGE_DELAY_MS), true);
  assert.equal(deliverPracticeSilenceNudge(f.stage, append, { flush() {} }, startedAt + PRACTICE_SILENCE_NUDGE_DELAY_MS + 1), false);
  const openingNudge = f.messages.find((message) => message.messageId?.startsWith("practice-silence-opening-"));
  assert.equal(openingNudge.content, "Whenever you’re ready, feel free to jump in — sharing what you each know about the options is a good place to start.");

  f.send(f.players[0], "after-opening", "Garden has good ventilation");
  const lastHumanMessageAt = f.round.get("practiceLastHumanMessageAt");
  assert.equal(deliverPracticeSilenceNudge(f.stage, append, { flush() {} }, lastHumanMessageAt + PRACTICE_SILENCE_NUDGE_DELAY_MS - 1), false);
  assert.equal(deliverPracticeSilenceNudge(f.stage, append, { flush() {} }, lastHumanMessageAt + PRACTICE_SILENCE_NUDGE_DELAY_MS), true);
  const lullNudge = f.messages.find((message) => message.messageId?.startsWith("practice-silence-lull-"));
  assert.equal(lullNudge.content, "No rush — feel free to keep sharing your thoughts whenever you’re ready.");

  for (const nudge of [openingNudge, lullNudge]) {
    assert.equal(nudge.speakerType, "facilitator_fixed");
    assert.equal(nudge.facilitatorOrigin, "DETERMINISTIC_FIXED");
    assert.equal(nudge.facilitatorTrigger, "PRACTICE_SILENCE_NUDGE");
    assert.equal(nudge.exclude_from_primary_analysis, true);
  }
  assert.equal(f.game.get("humanMessageCount"), undefined);
});
test("participant activity replaces the silence watchdog and Discussion completion clears it", () => {
  const originalSetTimeout = globalThis.setTimeout;
  const originalClearTimeout = globalThis.clearTimeout;
  const scheduled = [];
  const cleared = [];
  globalThis.setTimeout = (callback, delay) => {
    const handle = { callback, delay, unref() {} };
    scheduled.push(handle);
    return handle;
  };
  globalThis.clearTimeout = (handle) => cleared.push(handle);
  try {
    const f = fixture();
    f.listeners.get("start")({ stage: f.stage });
    const initialWatchdog = scheduled[0];
    assert.ok(initialWatchdog.delay <= PRACTICE_SILENCE_NUDGE_DELAY_MS);

    f.send(f.players[0], "watchdog-reset", "Garden has good ventilation");
    const replacementWatchdog = scheduled.at(-1);
    assert.ok(cleared.includes(initialWatchdog));
    assert.notEqual(replacementWatchdog, initialWatchdog);

    f.round.set("practiceDiscussionStartedAt", Date.now() - 120_001);
    f.round.set("practiceMessageCounts", { p0: 2, p1: 2, p2: 2 });
    for (const player of f.players) f.request(player, "ready", { ready: true });
    assert.equal(f.stage.get("ended"), true);
    assert.ok(cleared.includes(replacementWatchdog));
  } finally {
    globalThis.setTimeout = originalSetTimeout;
    globalThis.clearTimeout = originalClearTimeout;
  }
});
test("early finish needs two minutes, every participant and six human messages", () => {
  const base = { startedAt: 0, now: 120000, counts: { a: 2, b: 2, c: 2 }, participantIds: ["a", "b", "c"] };
  assert.equal(practiceReadiness(base), true);
  assert.equal(practiceReadiness({ ...base, now: 119999 }), false);
  assert.equal(practiceReadiness({ ...base, counts: { a: 4, b: 2 } }), false);
  assert.equal(practiceReadiness({ ...base, counts: { a: 2, b: 2, c: 1 } }), false);
});
test("only accepted human messages count, retries deduplicate and mentions persist", () => {
  const f = fixture();
  f.listeners.get("start")({ stage: f.stage });
  assert.deepEqual(f.round.get("practiceMessageCounts"), {});
  const accepted = f.send(f.players[0], "one", "Hello @[Pink]");
  const duplicate = f.send(f.players[0], "one", "Hello @[Pink]");
  assert.equal(f.round.get("practiceMessageCounts").p0, 1);
  assert.equal(f.players[0].round.get("practiceMentionUsed"), true);
  assert.deepEqual(accepted, duplicate);
  assert.equal(accepted.content, "Hello @[Pink]");
  assert.equal(accepted.stage, "PracticeDiscussion");
  assert.equal(f.messages[1].phase, "practice");
  assert.equal(f.messages[1].exclude_from_primary_analysis, true);
  assert.equal(f.messages[1].attribute, PRACTICE_CHAT);
  f.round.set("practiceDeadline", Date.now() - 1);
  const rejected = f.send(f.players[1], "two");
  assert.equal(rejected.status, "rejected");
  assert.equal(f.messages.length, 2);
});
test("ready is server gated, cancellable, and finishes only on unanimous readiness", () => {
  const f = fixture();
  f.listeners.get("start")({ stage: f.stage });
  f.request(f.players[0], "ready", { ready: true });
  assert.deepEqual(f.round.get("practiceReady"), {});
  f.round.set("practiceDiscussionStartedAt", Date.now() - 120001);
  f.round.set("practiceMessageCounts", { p0: 2, p1: 2, p2: 2 });
  f.request(f.players[0], "ready", { ready: true });
  f.request(f.players[1], "ready", { ready: true });
  f.request(f.players[0], "ready", { ready: false });
  f.request(f.players[2], "ready", { ready: true });
  assert.equal(f.stage.get("ended"), undefined);
  f.request(f.players[0], "ready", { ready: true });
  assert.equal(f.stage.get("ended"), true);
  assert.equal(f.round.get("practiceDiscussionEnded"), "early");
});
test("deadline recovery is authoritative and cannot skip discussion early", () => {
  const f = fixture();
  f.listeners.get("start")({ stage: f.stage });
  f.request(f.players[0], "deadline");
  assert.equal(f.stage.get("ended"), undefined);
  f.round.set("practiceDeadline", Date.now() - 1);
  f.request(f.players[0], "deadline");
  assert.equal(f.stage.get("ended"), true);
  assert.equal(f.round.get("practiceDiscussionEnded"), "timeout");
});
test("Practice Discussion posts exactly one server-authored one-minute timer message", () => {
  const f = fixture();
  f.listeners.get("start")({ stage: f.stage });
  const deadline = f.round.get("practiceDeadline");
  const append = (_game, attribute, value) => f.messages.push({ attribute, ...value });
  const api = { flush() {} };

  assert.equal(deliverPracticeDiscussionReminder(f.stage, append, api, deadline - 120_000), false);
  assert.equal(deliverPracticeDiscussionReminder(f.stage, append, api, deadline - 60_000), true);
  assert.equal(deliverPracticeDiscussionReminder(f.stage, append, api, deadline - 59_000), false);
  assert.equal(deliverPracticeDiscussionReminder(f.stage, append, api, deadline - 30_000), false);

  const reminders = f.messages.filter((message) => message.messageType === "timer_reminder");
  assert.equal(reminders.length, 1);
  assert.equal(reminders[0].content, "One minute remains in the discussion. Please work together to agree on one final choice before the discussion ends.");
  assert.equal(reminders[0].attribute, PRACTICE_CHAT);
  assert.equal(reminders[0].exclude_from_primary_analysis, true);
  assert.equal(f.game.get("humanMessageCount"), undefined);
});
test("Practice reminder is never posted after early completion", () => {
  const f = fixture();
  f.listeners.get("start")({ stage: f.stage });
  const deadline = f.round.get("practiceDeadline");
  f.round.set("practiceDiscussionEnded", "early");
  f.stage.set("ended", true);
  const append = (_game, attribute, value) => f.messages.push({ attribute, ...value });
  assert.equal(deliverPracticeDiscussionReminder(f.stage, append, { flush() {} }, deadline - 60_000), false);
  assert.equal(f.messages.filter((message) => message.messageType === "timer_reminder").length, 0);
});
test("timer is initially hidden, toggles per participant, and cannot hide in final 30 seconds", () => {
  const f = fixture();
  f.listeners.get("start")({ stage: f.stage });
  assert.equal(f.players[0].round.get("practiceTimerVisible"), undefined);
  f.request(f.players[0], "timer_opened");
  assert.equal(f.players[0].round.get("practiceTimerVisible"), true);
  assert.equal(f.players[1].round.get("practiceTimerVisible"), undefined);
  f.request(f.players[0], "timer_hidden");
  assert.equal(f.players[0].round.get("practiceTimerVisible"), false);
  f.round.set("practiceDeadline", Date.now() + 29000);
  f.request(f.players[0], "timer_forced_visible");
  f.request(f.players[0], "timer_hidden");
  assert.equal(f.players[0].round.get("practiceTimerVisible"), true);
});
test("client preserves hidden-to-forced timer behaviour across refresh and shows one clear label", () => {
  const hidden = resolveTimerVisibility({
    collapsible: true,
    forceVisibleAtSeconds: PRACTICE.forceTimerSeconds,
    remaining: PRACTICE.forceTimerSeconds + 1,
  });
  const forced = resolveTimerVisibility({
    collapsible: true,
    forceVisibleAtSeconds: PRACTICE.forceTimerSeconds,
    remaining: PRACTICE.forceTimerSeconds,
  });
  assert.deepEqual(hidden, { forcedVisible: false, visible: false, canToggle: true, controlLabel: "Show timer" });
  assert.deepEqual(forced, { forcedVisible: true, visible: true, canToggle: false, controlLabel: null });
  assert.match(practiceClientSource, /resolveTimerVisibility\(\{/);
  assert.match(practiceClientSource, /forced && !forcedSent\.current && !player\.round\.get\("practiceTimerForced"\)/);
  assert.equal((practiceClientSource.match(/Time remaining:/g) || []).length, 1);
  assert.match(reportSource, /Some information may be different from what other group members see\./);
});
test("Practice readiness control remains clear of the fixed bottom-left Empirica menu", () => {
  assert.match(
    practiceClientSource,
    /eligible && <section className="[^"]*pb-14[^"]*">/,
  );
});
test("practice completion waits for all participants before the main experiment", () => {
  const f = fixture("PracticeComplete");
  f.players.slice(0, 2).forEach((p) => f.request(p, "continue"));
  assert.equal(f.stage.get("ended"), undefined);
  assert.equal(f.game.get("practice_complete"), undefined);
  f.request(f.players[2], "continue");
  assert.equal(f.stage.get("ended"), true);
  assert.equal(f.game.get("practice_complete"), true);
});
test("welcome icebreaker has one fixed non-LLM Facilitator opening and keeps counts separate", () => {
  const f = fixture("PracticeWelcome");
  f.listeners.get("start")({ stage: f.stage });
  assert.equal(f.round.get("practiceWelcomeGreetSent"), true);
  const greets = f.messages.filter((m) => m.messageId?.startsWith("practice-greet-"));
  assert.equal(greets.length, 1);
  assert.match(greets[0].content, /Blue, Pink, Green/);
  assert.equal(greets[0].stage, "PracticeWelcome");
  assert.equal(greets[0].facilitatorOrigin, "DETERMINISTIC_FIXED");
  // Reconnect / repeated stage start does not duplicate the greeting.
  f.listeners.get("start")({ stage: f.stage });
  assert.equal(f.messages.filter((m) => m.messageId?.startsWith("practice-greet-")).length, 1);

  // Participants can chat on the Welcome page; messages land with the right
  // stage tag and go into the separate welcome counter.
  f.send(f.players[0], "w1", "Hi everyone!");
  assert.equal(f.round.get("practiceWelcomeMessageCounts")?.p0, 1);
  assert.equal(f.round.get("practiceMessageCounts"), undefined);
  const human = f.messages.find((m) => m.messageId === "p0-w1");
  assert.equal(human.stage, "PracticeWelcome");
  // Duplicate request id deduplicates.
  f.send(f.players[0], "w1", "Hi everyone!");
  assert.equal(f.round.get("practiceWelcomeMessageCounts")?.p0, 1);

  // Clicking Start practice advances this participant's page cursor (to
  // Reading); they can no longer send welcome chat, while a participant
  // still on the Welcome page can. (Real client requests carry page: the
  // welcome page's derived name.)
  f.request(f.players[0], "continue", { page: "PracticeWelcome" });
  assert.equal(f.players[0].round.get("practicePageIndex"), 1);
  f.send(f.players[0], "w0b", "I left already");
  assert.equal(f.round.get("practiceWelcomeMessageCounts")?.p0, 1);
  f.send(f.players[1], "w2", "Hello!");
  assert.equal(f.round.get("practiceWelcomeMessageCounts")?.p1, 1);

  // Moving to the discussion stage resets nothing but counts only its own
  // messages towards the early-finish conditions.
  const discussion = fixture();
  discussion.listeners.get("start")({ stage: discussion.stage });
  assert.deepEqual(discussion.round.get("practiceMessageCounts"), {});
  discussion.send(discussion.players[0], "d1", "Garden looks good");
  assert.equal(discussion.round.get("practiceMessageCounts")?.p0, 1);
  assert.equal(discussion.round.get("practiceWelcomeMessageCounts"), undefined);
});
test("welcome chat rejects empty, oversized and stale requests", () => {
  const f = fixture("PracticeWelcome");
  f.listeners.get("start")({ stage: f.stage });
  f.send(f.players[0], "w1", "");
  f.send(f.players[0], "w2", "x".repeat(1025));
  f.send(f.players[0], "w3", "stale");
  // (w3 is valid content; stage/round ids in fixture match, so it is accepted —
  // assert the first two were rejected by the absence of any count.)
  assert.equal(f.round.get("practiceWelcomeMessageCounts")?.p0, 1);
});
