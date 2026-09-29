import test from "node:test";
import assert from "node:assert/strict";
import { PRACTICE, PRACTICE_STAGES, PRACTICE_CHAT, practiceReadiness } from "../../shared/practice.mjs";
import { addPracticeRound, initialisePractice, registerPractice, handlePracticeMessage } from "./PracticeOnboarding.mjs";

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
    onStageStart: (fn) => listeners.set("start", fn),
    on: (_kind, key, fn) => listeners.set(key, fn),
    flush: () => {},
  };
  registerPractice(api, append);
  const request = (player, action, fields = {}) => listeners.get("practiceRequest")({}, {
    player, practiceRequest: { action, stageId: stage.id, roundId: round.id, ...fields },
  });
  const send = (player, id, content = "Hello") => handlePracticeMessage(player, {
    requestId: id, roundId: round.id, stageId: stage.id, content,
  }, append);
  return { game, round, stage, players: game.players, listeners, messages, request, send };
}

test("practice replaces the old icebreaker with a single non-formal rehearsal", () => {
  let attributes, stages = [];
  addPracticeRound({ addRound: (value) => { attributes = value; return { addStage: (s) => stages.push(s) }; } });
  assert.deepEqual(stages.map((s) => s.name), PRACTICE_STAGES);
  assert.equal(stages.find((s) => s.name === "PracticeDiscussion").duration, 240);
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
test("discussion start is idempotent: one fixed welcome, unchanged deadline and counts on reconnect", () => {
  const f = fixture();
  f.listeners.get("start")({ stage: f.stage });
  const startedAt = f.round.get("practiceDiscussionStartedAt");
  f.send(f.players[0], "one");
  f.listeners.get("start")({ stage: f.stage });
  assert.equal(f.round.get("practiceDiscussionStartedAt"), startedAt);
  assert.equal(f.round.get("practiceDeadline"), startedAt + 240000);
  assert.equal(f.messages.filter((m) => m.source === "facilitator_fixed").length, 1);
  assert.equal(f.round.get("practiceMessageCounts").p0, 1);
  assert.equal(f.game.get("humanMessageCount"), undefined);
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
  f.send(f.players[0], "one", "Hello @[Pink]");
  f.send(f.players[0], "one", "Hello @[Pink]");
  assert.equal(f.round.get("practiceMessageCounts").p0, 1);
  assert.equal(f.players[0].round.get("practiceMentionUsed"), true);
  assert.equal(f.messages[1].phase, "practice");
  assert.equal(f.messages[1].exclude_from_primary_analysis, true);
  assert.equal(f.messages[1].attribute, PRACTICE_CHAT);
  f.round.set("practiceDeadline", Date.now() - 1);
  f.send(f.players[1], "two");
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
test("practice completion waits for all participants before the main experiment", () => {
  const f = fixture("PracticeComplete");
  f.players.slice(0, 2).forEach((p) => f.request(p, "continue"));
  assert.equal(f.stage.get("ended"), undefined);
  assert.equal(f.game.get("practice_complete"), undefined);
  f.request(f.players[2], "continue");
  assert.equal(f.stage.get("ended"), true);
  assert.equal(f.game.get("practice_complete"), true);
});
