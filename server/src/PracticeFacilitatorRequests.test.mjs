import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { containsFacilitatorMention } from "./CheckpointManager.mjs";
import { MESSAGE_TYPES } from "./ExperimentPolicies.mjs";
import { VALIDATOR_CRITERIA } from "./SemanticValidator.js";
import { readAppendOnlyAttribute } from "./AppendOnlyAttribute.mjs";
import { FakeGame, FakeRound, FakeScope, FakeStage, makeFakePlayer } from "../test/participant_sim/fakes/fakeStore.mjs";
import { getOfflineCallbacksHarness } from "../test/participant_sim/fakes/loadCallbacks.mjs";

const callbacksSource = await readFile(new URL("./callbacks.js", import.meta.url), "utf8");
const practiceSource = await readFile(new URL("./PracticeOnboarding.mjs", import.meta.url), "utf8");

function practiceWorld() {
  const players = ["Blue", "Pink", "Green"].map((name, index) => makeFakePlayer({
    id: `practice-player-${index}`,
    name,
    hexCode: "206EEF",
  }));
  const game = new FakeGame({}, players);
  const round = new FakeRound({
    isPractice: true,
    index: 0,
    generalInfo: "Choose one of three rooms for a team meeting.",
    decisionOptions: [{ id: "MAPLE", label: "Maple Room" }, { id: "GARDEN", label: "Garden Room" }],
    practiceDiscussionStartedAt: Date.now() - 10_000,
    practiceDeadline: Date.now() + 180_000,
    practiceMessageCounts: {},
  }, game);
  const stage = new FakeStage({ name: "PracticeDiscussion", practiceStartedAt: Date.now() - 10_000 }, round);
  stage.currentGame = game;
  game.currentRound = round;
  game.currentStage = stage;
  game.set("practice_chat", []);
  for (const player of players) {
    player.currentGame = game;
    player.round = new FakeScope("playerRound");
    player.stage = new FakeScope("playerStage");
  }
  return { game, round, stage, players };
}

function providerResponse(data) {
  return new Response(JSON.stringify({
    choices: [{ message: { content: JSON.stringify(data) }, finish_reason: "stop" }],
    usage: { prompt_tokens: 20, completion_tokens: 10, total_tokens: 30 },
  }), { headers: { "content-type": "application/json" } });
}

function validatorPass() {
  return Object.fromEntries(VALIDATOR_CRITERIA.map((key) => [key, false]));
}

async function withFetch(fetchImpl, task) {
  const prior = globalThis.fetch;
  globalThis.fetch = fetchImpl;
  try {
    return await task();
  } finally {
    globalThis.fetch = prior;
  }
}

test("Practice only starts the LLM path for an accepted explicit Facilitator mention", () => {
  assert.equal(containsFacilitatorMention("Could you help, @[Facilitator]?"), true);
  assert.equal(containsFacilitatorMention("What do you think, @[Blue]?"), false);
  assert.match(callbacksSource, /practiceResult\?\.status === "accepted" && containsFacilitatorMention\(practiceResult\.content\)/);
  assert.match(callbacksSource, /handlePracticeFacilitatorRequest\(game,/);
});

test("Practice requested replies use the existing requested-Generalist generation and fallback path", () => {
  const start = callbacksSource.indexOf("async function handlePracticeFacilitatorRequest");
  const end = callbacksSource.indexOf("async function handleChat", start);
  const body = callbacksSource.slice(start, end);
  assert.ok(start >= 0 && end > start);
  assert.match(body, /getRequestedGeneralistPromptBundle\(\)/);
  assert.match(body, /runSharedGeneration\(/);
  assert.match(body, /postParticipantRequestFallback\(/);
  assert.doesNotMatch(body, /assessSemanticFactors|evaluateGate|chooseRole|recordAttempt/);
});

test("Practice publications stay in the practice transcript and out of formal counters", () => {
  assert.match(callbacksSource, /phase: "practice", source: "facilitator_api", exclude_from_primary_analysis: true/);
  assert.match(callbacksSource, /if \(!practice\) game\.set\("totalInterventions"/);
  assert.match(callbacksSource, /if \(!practice\) game\.set\("totalFallbackMessages"/);
  assert.match(callbacksSource, /finalizeAuditLogBase\(game, logEntry/);
});

test("Practice retains deterministic openings without routing them through the LLM", () => {
  assert.match(practiceSource, /PRACTICE_ICEBREAKER_OPENING/);
  assert.match(practiceSource, /content: DISCUSSION_OPENING_MESSAGE/);
  assert.match(practiceSource, /speakerType: "facilitator_fixed"/);
  assert.match(practiceSource, /facilitatorOrigin: "DETERMINISTIC_FIXED"/);
  assert.doesNotMatch(practiceSource, /getRequestedGeneralistPromptBundle|runSharedGeneration|getLLMResponse/);
  assert.match(practiceSource, /messageType: MESSAGE_TYPES\.TIMER_REMINDER/);
});

test("accepted Practice @Facilitator request reaches the API and publishes one validated Practice reply", async () => {
  const { Empirica } = await getOfflineCallbacksHarness();
  const listener = Empirica.attributeListeners.find((entry) => entry.kind === "player" && entry.key === "humanMessageRequest")?.callback;
  assert.equal(typeof listener, "function");
  const world = practiceWorld();
  let calls = 0;

  const request = {
    requestId: "practice-request-1",
    roundId: world.round.id,
    stageId: world.stage.id,
    content: "@[Facilitator] can you help us organise the comparison?",
  };
  await withFetch(async (_url, options) => {
    calls += 1;
    const system = JSON.parse(options.body).messages[0].content;
    if (system.startsWith("# validator.md")) return providerResponse(validatorPass());
    return providerResponse({
      role: "GENERALIST",
      message: "Which room criteria would you like me to help organise?",
      groundingMessageIds: [],
    });
  }, async () => {
    await listener(undefined, { player: world.players[0], humanMessageRequest: request });
    await listener(undefined, { player: world.players[0], humanMessageRequest: request });
  });

  const chat = world.game.get("practice_chat");
  assert.equal(calls, 2, "one Generator and one Validator call");
  assert.equal(chat.length, 2);
  assert.equal(chat[0].messageType, MESSAGE_TYPES.HUMAN);
  assert.equal(chat[1].messageType, MESSAGE_TYPES.FACILITATOR);
  assert.equal(chat[1].stage, "PracticeDiscussion");
  assert.equal(chat[1].phase, "practice");
  assert.equal(chat[1].source, "facilitator_api");
  assert.equal(chat[1].exclude_from_primary_analysis, true);
  assert.equal(chat[1].facilitatorTrigger, "PARTICIPANT_REQUEST");
  assert.equal(world.game.get("totalInterventions"), undefined);
  assert.deepEqual(world.game.get("llmInFlight"), {});
  assert.equal(readAppendOnlyAttribute(world.game, "llmLog").at(-1).outcome, "PUBLISHED");
});

test("Practice @Facilitator receives the neutral Practice fallback when the API is unavailable", async () => {
  const { Empirica } = await getOfflineCallbacksHarness();
  const listener = Empirica.attributeListeners.find((entry) => entry.kind === "player" && entry.key === "humanMessageRequest")?.callback;
  const world = practiceWorld();
  await withFetch(async () => { throw new Error("offline"); }, () => listener(undefined, {
    player: world.players[0],
    humanMessageRequest: {
      requestId: "practice-request-fallback",
      roundId: world.round.id,
      stageId: world.stage.id,
      content: "@[Facilitator] can you help?",
    },
  }));

  const reply = world.game.get("practice_chat").at(-1);
  assert.equal(reply.messageType, MESSAGE_TYPES.FACILITATOR);
  assert.equal(reply.stage, "PracticeDiscussion");
  assert.equal(reply.phase, "practice");
  assert.equal(reply.source, "facilitator_fallback");
  assert.equal(reply.facilitatorTrigger, "PARTICIPANT_REQUEST");
  assert.equal(world.game.get("totalFallbackMessages"), undefined);
  assert.equal(readAppendOnlyAttribute(world.game, "llmLog").at(-1).outcome, "PUBLISHED_REQUEST_FALLBACK");
});

test("ordinary Practice chat and participant mentions never call the Facilitator API", async () => {
  const { Empirica } = await getOfflineCallbacksHarness();
  const listener = Empirica.attributeListeners.find((entry) => entry.kind === "player" && entry.key === "humanMessageRequest")?.callback;
  const world = practiceWorld();
  let calls = 0;
  const send = (requestId, content) => listener(undefined, {
    player: world.players[0],
    humanMessageRequest: {
      requestId,
      roundId: world.round.id,
      stageId: world.stage.id,
      content,
    },
  });
  await withFetch(async () => {
    calls += 1;
    throw new Error("non-Facilitator Practice messages must not call fetch");
  }, async () => {
    await send("practice-message-1", "I think the Garden Room has useful features.");
    await send("practice-message-2", "What do you think, @[Blue]?");
  });

  assert.equal(calls, 0);
  assert.equal(world.game.get("practice_chat").length, 2);
  assert.ok(world.game.get("practice_chat").every((message) => message.messageType === MESSAGE_TYPES.HUMAN));
  assert.equal(readAppendOnlyAttribute(world.game, "llmLog").length, 0);
});

test("Practice discards an in-flight Facilitator response after the originating stage ends", async () => {
  const { Empirica } = await getOfflineCallbacksHarness();
  const listener = Empirica.attributeListeners.find((entry) => entry.kind === "player" && entry.key === "humanMessageRequest")?.callback;
  const world = practiceWorld();
  let calls = 0;

  await withFetch(async () => {
    calls += 1;
    world.stage.set("ended", true);
    return providerResponse({
      role: "GENERALIST",
      message: "This response must never become visible.",
      groundingMessageIds: [],
    });
  }, () => listener(undefined, {
    player: world.players[0],
    humanMessageRequest: {
      requestId: "practice-stale-response",
      roundId: world.round.id,
      stageId: world.stage.id,
      content: "@[Facilitator] can you help?",
    },
  }));

  const chat = world.game.get("practice_chat");
  assert.equal(calls, 1);
  assert.equal(chat.length, 1);
  assert.equal(chat[0].messageType, MESSAGE_TYPES.HUMAN);
  assert.equal(chat.some((message) => message.messageType === MESSAGE_TYPES.FACILITATOR), false);
  const audit = readAppendOnlyAttribute(world.game, "llmLog").at(-1);
  assert.equal(audit.outcome, "SILENT");
  assert.match(audit.reason, /Discarded stale AI result/);
});
