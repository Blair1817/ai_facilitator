import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { FakeGame, FakeRound, FakeStage, FakeScope, makeFakePlayer } from "../test/participant_sim/fakes/fakeStore.mjs";
import { getOfflineCallbacksHarness } from "../test/participant_sim/fakes/loadCallbacks.mjs";
import { buildCanonicalMessage } from "./ExperimentPolicies.mjs";
import { FACTOR_KEYS } from "./EvidenceChecker.js";
import { VALIDATOR_CRITERIA } from "./SemanticValidator.js";
import { readAppendOnlyAttribute } from "./AppendOnlyAttribute.mjs";

const dirname = path.dirname(fileURLToPath(import.meta.url));
process.argv[1] = path.join(dirname, "fake-entry.js");

function world(facilitation = "static") {
  const players = ["Alex", "Casey", "Jordan"].map((name, index) => makeFakePlayer({
    id: `reliability-${index}`,
    name,
    hexCode: "ffffff",
  }));
  const game = new FakeGame({}, players);
  const round = new FakeRound({
    index: 0,
    taskIndex: 0,
    taskVersion: "A",
    facilitation,
    generalInfo: "Choose City A or City B using public transport and cost evidence.",
    decisionOptions: [{ id: "a", label: "City A" }, { id: "b", label: "City B" }],
  }, game);
  const stage = new FakeStage({ name: "Task" }, round);
  stage.currentGame = game;
  game.currentRound = round;
  game.currentStage = stage;
  for (const player of players) {
    player.currentGame = game;
    player.round = new FakeScope("playerRound");
    player.stage = new FakeScope("playerStage");
  }
  game.set("deadline", Date.now() + 400_000);
  game.set("taskStartTime", Date.now() - 100_000);
  game.set("humanMessageCount", 5);
  game.set("messagesSinceLastPublish", 5);
  const lines = [
    "I prefer City B.",
    "City A transport is 12 minutes.",
    "City B transport is 18 minutes.",
    "City A cost is 25000.",
    "City B cost is 32000.",
    "Those are my reported figures.",
  ];
  game.set("chat_round_0", lines.map((content, index) => humanMessage(game, players[index % players.length], content, index)));
  return { game, round, stage, players };
}

function humanMessage(game, player, content, index) {
  return buildCanonicalMessage({
    messageId: `reliability-human-${index}`,
    groupId: game.id,
    participantId: player.id,
    roundIndex: 0,
    stage: "Discussion",
    messageType: "human",
    speakerType: "human",
    timestamp: Date.now() + index,
    sequencePosition: index,
    content,
    sender: { id: player.id, name: player.get("name") },
  });
}

function response(data) {
  return new Response(JSON.stringify({
    choices: [{ message: { content: JSON.stringify(data) }, finish_reason: "stop" }],
    usage: { total_tokens: 10 },
  }), { headers: { "content-type": "application/json" } });
}

function absentFactors() {
  return {
    ...Object.fromEntries(FACTOR_KEYS.map((key) => [key, {
      status: "absent",
      strength: 0,
      message_ids: [],
      evidence: [],
    }])),
    evidenceRelations: [],
    cognitiveTargets: [],
  };
}

function validatorPass() {
  return Object.fromEntries(VALIDATOR_CRITERIA.map((key) => [key, false]));
}

function validResponseFor(body) {
  const system = body.messages[0].content;
  if (system.startsWith("# assessor.md")) return response(absentFactors());
  if (system.startsWith("# validator.md")) return response(validatorPass());
  return response({
    role: system.includes("# requested_generalist.md") || system.includes("# generalist.md") ? "GENERALIST" : "STATIC",
    message: "What public evidence should the group compare next?",
    groundingMessageIds: [],
  });
}

function transitionToNextStage(w) {
  w.stage.set("ended", true);
  const next = new FakeStage({ name: "FinalDecision" }, w.round);
  next.currentGame = w.game;
  w.game.currentStage = next;
}

async function waitUntil(predicate) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setImmediate(resolve));
  }
  assert.fail("Timed out waiting for callback checkpoint");
}

async function withMockedFetch(fetchImpl, task) {
  const priorFetch = globalThis.fetch;
  const priorSetTimeout = globalThis.setTimeout;
  const priorError = console.error;
  const priorWarn = console.warn;
  const timers = [];
  globalThis.fetch = fetchImpl;
  globalThis.setTimeout = (...args) => {
    const timer = priorSetTimeout(...args);
    timers.push(timer);
    return timer;
  };
  console.error = () => {};
  console.warn = () => {};
  try {
    return await task();
  } finally {
    globalThis.fetch = priorFetch;
    globalThis.setTimeout = priorSetTimeout;
    timers.forEach(clearTimeout);
    console.error = priorError;
    console.warn = priorWarn;
  }
}

function published(w) {
  return w.game.get("chat_round_0").filter((message) => message.sender?.id === "ai");
}

test("formal stage transitions during Assessor, Generator, or Validator execution prevent publication", async () => {
  const { handleChat } = await getOfflineCallbacksHarness();
  for (const phase of ["assessor", "generator", "validator"]) {
    const w = world(phase === "assessor" ? "adaptive" : "static");
    let transitioned = false;
    await withMockedFetch(async (_url, options) => {
      const body = JSON.parse(options.body);
      const system = body.messages[0].content;
      const currentPhase = system.startsWith("# assessor.md")
        ? "assessor"
        : system.startsWith("# validator.md") ? "validator" : "generator";
      if (!transitioned && currentPhase === phase) {
        transitioned = true;
        transitionToNextStage(w);
      }
      return validResponseFor(body);
    }, () => handleChat(undefined, { game: w.game }));
    assert.equal(transitioned, true, `${phase} transition hook must execute`);
    assert.equal(published(w).length, 0, `${phase} result must not publish after a formal transition`);
  }
});

test("formal stage ending in the final pre-publication flush closes the append race", async () => {
  const { handleChat, Empirica } = await getOfflineCallbacksHarness();
  const w = world("static");
  Empirica.setFlusher({
    async flush() {
      const active = Object.values(w.game.get("llmInFlight") || {});
      if (active.some((entry) => entry.visibleResponsePending === true)) w.stage.set("ended", true);
    },
  });
  try {
    await withMockedFetch(async (_url, options) => validResponseFor(JSON.parse(options.body)),
      () => handleChat(undefined, { game: w.game }));
  } finally {
    Empirica.setFlusher(undefined);
  }
  assert.equal(published(w).length, 0);
  assert.match(readAppendOnlyAttribute(w.game, "llmLog").at(-1).reason, /before publication/);
});

test("participant-requested generation cannot publish or fall back after its formal stage changes", async () => {
  const { handleChat } = await getOfflineCallbacksHarness();
  const w = world("static");
  const chat = w.game.get("chat_round_0");
  chat.at(-1).content += " @[Facilitator]";
  chat.at(-1).text = chat.at(-1).content;
  let transitioned = false;
  await withMockedFetch(async (_url, options) => {
    if (!transitioned) {
      transitioned = true;
      transitionToNextStage(w);
    }
    return validResponseFor(JSON.parse(options.body));
  }, () => handleChat(undefined, { game: w.game }));
  assert.equal(published(w).length, 0);
  assert.equal(w.game.get("totalFallbackMessages") || 0, 0);
  assert.deepEqual(w.game.get("llmInFlight"), {});
});

test("a stalled automatic request times out, finalizes its audit, and leaves no visible typing state", async () => {
  const { handleChat } = await getOfflineCallbacksHarness();
  const w = world("static");
  const priorTimeout = process.env.LLM_REQUEST_TIMEOUT_MS;
  process.env.LLM_REQUEST_TIMEOUT_MS = "5";
  try {
    await withMockedFetch(() => new Promise(() => {}), () => handleChat(undefined, { game: w.game }));
  } finally {
    if (priorTimeout === undefined) delete process.env.LLM_REQUEST_TIMEOUT_MS;
    else process.env.LLM_REQUEST_TIMEOUT_MS = priorTimeout;
  }
  const last = readAppendOnlyAttribute(w.game, "llmLog").at(-1);
  assert.equal(last.outcome, "SILENT");
  assert.equal(last.failureStage, "generator_api");
  assert.match(last.reason, /timed out after 5ms/);
  assert.deepEqual(w.game.get("llmInFlight"), {});
  assert.equal(published(w).length, 0);
});

test("a participant-requested timeout keeps the safe fallback and finalizes cleanly", async () => {
  const { handleChat } = await getOfflineCallbacksHarness();
  const w = world("static");
  const chat = w.game.get("chat_round_0");
  chat.at(-1).content += " @[Facilitator]";
  chat.at(-1).text = chat.at(-1).content;
  const priorTimeout = process.env.LLM_REQUEST_TIMEOUT_MS;
  process.env.LLM_REQUEST_TIMEOUT_MS = "5";
  try {
    await withMockedFetch(() => new Promise(() => {}), () => handleChat(undefined, { game: w.game }));
  } finally {
    if (priorTimeout === undefined) delete process.env.LLM_REQUEST_TIMEOUT_MS;
    else process.env.LLM_REQUEST_TIMEOUT_MS = priorTimeout;
  }
  const last = readAppendOnlyAttribute(w.game, "llmLog").at(-1);
  assert.equal(last.outcome, "PUBLISHED_REQUEST_FALLBACK");
  assert.equal(last.fallbackUsed, "PARTICIPANT_REQUEST_SAFE_CLARIFICATION");
  assert.equal(published(w).length, 1);
  assert.deepEqual(w.game.get("llmInFlight"), {});
});

test("overlapping automatic callbacks do not start a second pipeline or publish stale context", async () => {
  const { handleChat } = await getOfflineCallbacksHarness();
  const w = world("static");
  let resolveFirst;
  const firstResponse = new Promise((resolve) => { resolveFirst = resolve; });
  let requests = 0;
  await withMockedFetch(async (_url, options) => {
    requests += 1;
    if (requests === 1) return firstResponse;
    return validResponseFor(JSON.parse(options.body));
  }, async () => {
    const first = handleChat(undefined, { game: w.game });
    await waitUntil(() => requests === 1);
    const chat = w.game.get("chat_round_0");
    // 2026-10-25: up to two new human messages are tolerated; three make the
    // older automatic result stale.
    chat.push(humanMessage(w.game, w.players[0], "A later public fact.", 6));
    chat.push(humanMessage(w.game, w.players[1], "Another later fact.", 7));
    chat.push(humanMessage(w.game, w.players[2], "And one more.", 8));
    w.game.set("lastAttemptTimestamp", Date.now() - 31_000);
    const second = handleChat(undefined, { game: w.game });
    await second;
    assert.equal(requests, 1, "the overlapping automatic callback must not reach the provider");
    resolveFirst(validResponseFor({ messages: [{ content: "# static.md" }] }));
    await first;
  });
  assert.equal(w.game.get("attemptedThisRound"), 1);
  assert.equal(w.game.get("publishedThisRound") || 0, 0);
  assert.equal(published(w).length, 0, "the older automatic result is stale after more than two later human messages");
  assert.ok(readAppendOnlyAttribute(w.game, "llmLog").some((entry) => entry.outcome === "SILENT_AUTOMATIC_IN_FLIGHT"));
});

test("Static still publishes when one human message arrives while its Generator is running", async () => {
  const { handleChat } = await getOfflineCallbacksHarness();
  const w = world("static");
  let resolveFirst;
  const firstResponse = new Promise((resolve) => { resolveFirst = resolve; });
  let requests = 0;
  await withMockedFetch(async (_url, options) => {
    requests += 1;
    if (requests === 1) return firstResponse;
    return validResponseFor(JSON.parse(options.body));
  }, async () => {
    const first = handleChat(undefined, { game: w.game });
    await waitUntil(() => requests === 1);
    w.game.get("chat_round_0").push(humanMessage(w.game, w.players[0], "A later public fact.", 6));
    await handleChat(undefined, { game: w.game });   // counted; blocked by cooldown
    resolveFirst(validResponseFor({ messages: [{ content: "# static.md" }] }));
    await first;
  });
  assert.equal(published(w).length, 1, "one new message must not discard the Static checkpoint");
  assert.equal(w.game.get("publishedThisRound"), 1);
  assert.equal(w.game.get("messagesSinceLastPublish"), 0);
});

test("duplicate chat callbacks are idempotent while the first provider request is slow", async () => {
  const { handleChat } = await getOfflineCallbacksHarness();
  const w = world("static");
  let resolveFirst;
  const firstResponse = new Promise((resolve) => { resolveFirst = resolve; });
  let requests = 0;
  await withMockedFetch(async (_url, options) => {
    requests += 1;
    if (requests === 1) return firstResponse;
    return validResponseFor(JSON.parse(options.body));
  }, async () => {
    const first = handleChat(undefined, { game: w.game });
    await waitUntil(() => requests === 1);
    await handleChat(undefined, { game: w.game });
    assert.equal(requests, 1);
    assert.equal(w.game.get("humanMessageCount"), 6);
    resolveFirst(validResponseFor({ messages: [{ content: "# static.md" }] }));
    await first;
  });
  assert.equal(published(w).length, 1);
  assert.equal(w.game.get("attemptedThisRound"), 1);
});

test("participant request remains immediate during an automatic pipeline and supersedes its stale publication", async () => {
  const { handleChat } = await getOfflineCallbacksHarness();
  const w = world("static");
  let resolveAutomatic;
  const automaticResponse = new Promise((resolve) => { resolveAutomatic = resolve; });
  let requests = 0;
  await withMockedFetch(async (_url, options) => {
    requests += 1;
    if (requests === 1) return automaticResponse;
    return validResponseFor(JSON.parse(options.body));
  }, async () => {
    const automatic = handleChat(undefined, { game: w.game });
    await waitUntil(() => requests === 1);
    const chat = w.game.get("chat_round_0");
    chat.push(humanMessage(w.game, w.players[1], "@[Facilitator] please help organise this.", 6));
    await handleChat(undefined, { game: w.game });
    assert.equal(published(w).length, 1, "the participant-requested reply should not wait for the automatic pipeline");
    assert.equal(published(w)[0].facilitatorTrigger, "PARTICIPANT_REQUEST");
    resolveAutomatic(validResponseFor({ messages: [{ content: "# static.md" }] }));
    await automatic;
  });
  assert.equal(published(w).length, 1, "the older automatic response must not publish after the requested reply");
  assert.deepEqual(w.game.get("llmInFlight"), {});
});

// Synthetic public discussion; checks real callback/prompt delivery, not
// live-model effectiveness.
test("requested criteria, recap and terminology use requested validation in both conditions", async () => {
  const { handleChat } = await getOfflineCallbacksHarness();
  const cases = [
    ["what are some criteria", "Criteria are factors used to compare options, such as the transport times and costs you have discussed."],
    ["what we have discussed", "You have shared transport times and costs for both cities. City A was reported as 12 minutes and 25000. City B was reported as 18 minutes and 32000."],
    ['what do you mean by "criterion"', "A criterion is a factor used to compare options; transport time is one example from your discussion."],
  ];
  for (const condition of ["static", "adaptive"]) {
    for (const [request, answer] of cases) {
      const w = world(condition);
      w.game.get("chat_round_0").push(buildCanonicalMessage({
        sequencePosition: 6, messageId: "prior-ai", groupId: w.game.id, speakerId: "ai", roundIndex: 0, stage: "Discussion",
        messageType: "facilitator", speakerType: "facilitator", timestamp: Date.now(),
        content: "Which shared criterion should you use to compare the options next?",
        sender: { id: "ai", name: "Facilitator" },
      }));
      w.game.get("chat_round_0").push(humanMessage(w.game, w.players[0], `@[Facilitator] ${request}`, 7));
      let audits = 0;
      await withMockedFetch(async (_url, options) => {
        const { messages } = JSON.parse(options.body);
        assert.match(messages[1].content, /\[PARTICIPANT_REQUEST\]/);
        assert.ok(messages[1].content.includes(request));
        if (messages[0].content.startsWith("# validator.md")) {
          audits++;
          assert.match(messages[0].content, /PARTICIPANT-REQUESTED SCOPE/);
          assert.match(messages[0].content, /requested recap, explanation, or renewed/);
          assert.match(messages[1].content, /Which shared criterion/);
          return response(validatorPass());
        }
        assert.match(messages[0].content, /Requested clarification and repetition/);
        return response({ role: "GENERALIST", message: answer, groundingMessageIds: ["m1", "m2", "m3", "m4"] });
      }, () => handleChat(undefined, { game: w.game }));
      assert.equal(audits, 1);
      assert.equal(published(w).at(-1).content, answer);
      assert.equal(readAppendOnlyAttribute(w.game, "llmLog").at(-1).outcome, "PUBLISHED");
      assert.equal(w.game.get("totalFallbackMessages") || 0, 0);
      assert.equal(w.game.get("publishedThisRound") || 0, 0);
    }
  }
});

test("requested rejection repairs once and never publishes unsafe or repeated candidates", async () => {
  const { handleChat } = await getOfflineCallbacksHarness();
  for (const criterion of ["repetition", "recommendationDetected", "hiddenInformationInference", "notGrounded"]) {
    const w = world("adaptive");
    w.game.get("chat_round_0").push(humanMessage(w.game, w.players[0], "@[Facilitator] what have we discussed?", 6));
    let audits = 0;
    let generations = 0;
    await withMockedFetch(async (_url, options) => {
      const { messages } = JSON.parse(options.body);
      if (messages[0].content.startsWith("# validator.md")) {
        audits++;
        return response({ ...validatorPass(), [criterion]: true });
      }
      generations++;
      return response({ role: "GENERALIST", message: "What information should the group compare next?", groundingMessageIds: [] });
    }, () => handleChat(undefined, { game: w.game }));
    assert.equal(generations, 2);
    assert.equal(audits, 2);
    assert.equal(published(w).length, 1);
    assert.equal(published(w)[0].facilitatorOrigin, "NON_LLM_FALLBACK");
    assert.match(published(w)[0].content, /couldn’t complete that reply/);
    assert.doesNotMatch(published(w)[0].content, /correct|which option/);
    const audit = readAppendOnlyAttribute(w.game, "llmLog").at(-1);
    assert.match(audit.reason, new RegExp(criterion));
    assert.equal(audit.outcome, "PUBLISHED_REQUEST_FALLBACK");
  }
});
