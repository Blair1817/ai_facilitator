import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { DISCUSSION_OPENING_MESSAGE } from "../../shared/discussionOpening.mjs";
import { PRACTICE_CHAT } from "../../shared/practice.mjs";
import { containsFacilitatorMention } from "./CheckpointManager.mjs";
import { buildAssessorUserContext } from "./SemanticAssessor.js";
import { handlePracticeStageStart } from "./PracticeOnboarding.mjs";
import {
  FakeGame,
  FakeRound,
  FakeStage,
} from "../test/participant_sim/fakes/fakeStore.mjs";
import { getOfflineCallbacksHarness } from "../test/participant_sim/fakes/loadCallbacks.mjs";

const dirname = path.dirname(fileURLToPath(import.meta.url));
const facilitatorContentSource = readFileSync(path.join(dirname, "../../client/src/components/FacilitatorMessageContent.jsx"), "utf8");
const clientCssSource = readFileSync(path.join(dirname, "../../client/src/index.css"), "utf8");
const callbacksSource = readFileSync(path.join(dirname, "callbacks.js"), "utf8");
const practiceSource = readFileSync(path.join(dirname, "PracticeOnboarding.mjs"), "utf8");

const EXPECTED_OPENING =
  "Hi everyone, welcome! I’m the Facilitator for this discussion. I won’t make the decision for you, but I’m here to help make sure everyone is heard and keep track of the discussion.\n\n"
  + "If you’d like to ask me something, just type @ and select Facilitator. I’ll be here throughout the discussion to support the group when needed.\n\n"
  + "As you discuss, share and compare what you each know about the options, and work together to agree on one final choice before the discussion ends. Have a great discussion!";

function formalWorld({ facilitation = "static", taskIndex = 0, game = null } = {}) {
  const currentGame = game ?? new FakeGame({ id: `formal-${facilitation}-${taskIndex}`, treatment: { gameDuration: 15 } }, []);
  const round = new FakeRound({
    id: `formal-round-${taskIndex}`,
    index: taskIndex,
    taskIndex,
    facilitation,
  }, currentGame);
  const stage = new FakeStage({ id: `formal-task-${taskIndex}`, name: "Task" }, round);
  stage.currentGame = currentGame;
  currentGame.currentRound = round;
  currentGame.currentStage = stage;
  return { game: currentGame, round, stage, chatKey: `chat_round_${taskIndex}` };
}

function practiceWorld() {
  const game = new FakeGame({ id: "practice-opening-game" }, []);
  const round = new FakeRound({ id: "practice-opening-round", isPractice: true, index: 0 }, game);
  const stage = new FakeStage({ id: "practice-discussion-stage", name: "PracticeDiscussion" }, round);
  stage.currentGame = game;
  game.currentRound = round;
  game.currentStage = stage;
  const append = (target, attribute, message) => target.append(attribute, message);
  return { game, round, stage, append };
}

async function withCapturedTimers(task) {
  const originalSetTimeout = globalThis.setTimeout;
  const scheduled = [];
  globalThis.setTimeout = (callback, delay, ...args) => {
    const handle = { unref() {} };
    scheduled.push({ callback: () => callback(...args), delay, handle });
    return handle;
  };
  try {
    return await task(scheduled);
  } finally {
    globalThis.setTimeout = originalSetTimeout;
  }
}

function humanMessage(game, roundIndex, index) {
  return {
    messageId: `opening-human-${roundIndex}-${index}`,
    groupId: game.id,
    participantId: `participant-${index % 3}`,
    roundIndex,
    stage: "Discussion",
    messageType: "human",
    speakerType: "human",
    timestamp: Date.now() + index,
    content: `Participant message ${index + 1}`,
    text: `Participant message ${index + 1}`,
    ts: Date.now() + index,
    sender: { id: `participant-${index % 3}`, name: ["Blue", "Pink", "Green"][index % 3] },
  };
}

test("the shared opening is the exact canonical three-paragraph string and both publishers reference it", () => {
  assert.equal(DISCUSSION_OPENING_MESSAGE, EXPECTED_OPENING);
  assert.deepEqual(DISCUSSION_OPENING_MESSAGE.split("\n\n"), [
    "Hi everyone, welcome! I’m the Facilitator for this discussion. I won’t make the decision for you, but I’m here to help make sure everyone is heard and keep track of the discussion.",
    "If you’d like to ask me something, just type @ and select Facilitator. I’ll be here throughout the discussion to support the group when needed.",
    "As you discuss, share and compare what you each know about the options, and work together to agree on one final choice before the discussion ends. Have a great discussion!",
  ]);
  assert.match(callbacksSource, /appendFacilitatorNudge\(stage, chatKey, DISCUSSION_OPENING_MESSAGE,/);
  assert.match(practiceSource, /content: DISCUSSION_OPENING_MESSAGE/);
  assert.doesNotMatch(callbacksSource, /const TASK_OPENING_MESSAGE/);
  assert.doesNotMatch(practiceSource, /Welcome! Start by saying hello, introducing your colour/);
});

test("Practice publishes the shared opening exactly once, including a replay on a fresh stage object", async () => {
  const world = practiceWorld();
  await withCapturedTimers(async () => {
    handlePracticeStageStart(world.stage, world.append, { flush() {} });
    handlePracticeStageStart(world.stage, world.append, { flush() {} });

    const replayStage = new FakeStage({ id: "practice-discussion-replay", name: "PracticeDiscussion" }, world.round);
    replayStage.currentGame = world.game;
    world.game.currentStage = replayStage;
    handlePracticeStageStart(replayStage, world.append, { flush() {} });
  });

  const openings = (world.game.get(PRACTICE_CHAT) ?? [])
    .filter((message) => message.facilitatorTrigger === "PRACTICE_DISCUSSION_OPENING");
  assert.equal(openings.length, 1);
  assert.equal(openings[0].content, DISCUSSION_OPENING_MESSAGE);
  assert.equal(world.round.get("practiceTotalMessages"), 0);
  assert.deepEqual(world.round.get("practiceMessageCounts"), {});
  assert.equal(world.game.get("humanMessageCount"), undefined);
});

test("Round 1/2 Static and Adaptive all publish the identical opening", async () => {
  const { handleFormalStageStart } = await getOfflineCallbacksHarness();
  await withCapturedTimers(async () => {
    for (const facilitation of ["static", "adaptive"]) {
      for (const taskIndex of [0, 1]) {
        const world = formalWorld({ facilitation, taskIndex });
        handleFormalStageStart(world.stage);
        const openings = (world.game.get(world.chatKey) ?? [])
          .filter((message) => message.facilitatorTrigger === "DISCUSSION_OPENING");
        assert.equal(openings.length, 1, `${facilitation} Round ${taskIndex + 1}`);
        assert.equal(openings[0].content, DISCUSSION_OPENING_MESSAGE, `${facilitation} Round ${taskIndex + 1}`);
      }
    }
  });
});

test("formal replay/reconnect is idempotent while Round 2 receives one new opening", async () => {
  const { handleFormalStageStart } = await getOfflineCallbacksHarness();
  const game = new FakeGame({ id: "two-round-opening-game", treatment: { gameDuration: 15 } }, []);
  await withCapturedTimers(async () => {
    const round1 = formalWorld({ facilitation: "static", taskIndex: 0, game });
    handleFormalStageStart(round1.stage);
    handleFormalStageStart(round1.stage);
    const replay = new FakeStage({ id: "formal-task-0-replay", name: "Task" }, round1.round);
    replay.currentGame = game;
    game.currentStage = replay;
    handleFormalStageStart(replay);

    const round2 = formalWorld({ facilitation: "adaptive", taskIndex: 1, game });
    handleFormalStageStart(round2.stage);
    handleFormalStageStart(round2.stage);
  });

  assert.equal((game.get("chat_round_0") ?? []).filter((m) => m.facilitatorTrigger === "DISCUSSION_OPENING").length, 1);
  assert.equal((game.get("chat_round_1") ?? []).filter((m) => m.facilitatorTrigger === "DISCUSSION_OPENING").length, 1);
});

test("opening publication neither enters Facilitator-request routing nor advances the six-message checkpoint", async () => {
  const { handleChat, handleFormalStageStart } = await getOfflineCallbacksHarness();
  const world = formalWorld({ facilitation: "static", taskIndex: 0 });
  await withCapturedTimers(async () => handleFormalStageStart(world.stage));

  const originalFetch = globalThis.fetch;
  const originalError = console.error;
  const originalTimeout = process.env.LLM_REQUEST_TIMEOUT_MS;
  let providerCalls = 0;
  process.env.LLM_REQUEST_TIMEOUT_MS = "5";
  globalThis.fetch = async () => {
    providerCalls += 1;
    throw new Error("intentional offline opening regression stub");
  };
  console.error = () => {};
  try {
    await withCapturedTimers(async () => {
      await handleChat(undefined, { game: world.game });
      assert.equal(world.game.get("humanMessageCount"), undefined);
      assert.equal(world.game.get("messagesSinceLastPublish"), undefined);
      assert.equal(world.game.get("attemptedThisRound"), undefined);
      assert.deepEqual(world.game.get("llmInFlight"), {});
      assert.equal(providerCalls, 0);

      for (let index = 0; index < 5; index += 1) {
        world.game.append(world.chatKey, humanMessage(world.game, 0, index));
        await handleChat(undefined, { game: world.game });
      }
      assert.equal(world.game.get("humanMessageCount"), 5);
      assert.equal(world.game.get("attemptedThisRound") ?? 0, 0);
      assert.equal(providerCalls, 0);

      world.game.append(world.chatKey, humanMessage(world.game, 0, 5));
      await handleChat(undefined, { game: world.game });
      assert.equal(world.game.get("humanMessageCount"), 6);
      assert.equal(world.game.get("attemptedThisRound"), 1);
      assert.equal(providerCalls, 1);
    });
  } finally {
    globalThis.fetch = originalFetch;
    console.error = originalError;
    if (originalTimeout === undefined) delete process.env.LLM_REQUEST_TIMEOUT_MS;
    else process.env.LLM_REQUEST_TIMEOUT_MS = originalTimeout;
  }

  assert.equal(containsFacilitatorMention(DISCUSSION_OPENING_MESSAGE), false);
});

test("Assessor context excludes the Facilitator opening from participant evidence", () => {
  const opening = {
    messageId: "opening",
    messageType: "facilitator",
    speakerType: "facilitator",
    text: DISCUSSION_OPENING_MESSAGE,
    sender: { id: "ai", name: "Facilitator" },
  };
  const participant = {
    messageId: "participant",
    messageType: "human",
    speakerType: "human",
    text: "The Blue report says Option A costs less.",
    sender: { id: "p1", name: "Blue" },
  };
  const context = buildAssessorUserContext({
    chat: [opening, participant],
    taskGeneralContext: "Choose one option.",
    activeParticipantNames: ["Blue", "Pink", "Green"],
  });

  assert.doesNotMatch(context.userContent, /Hi everyone, welcome!/);
  assert.match(context.userContent, /The Blue report says Option A costs less\./);
  assert.deepEqual(context.eligibleMessageIds, ["m1"]);
});

test("the publication and client plain-text contracts preserve both blank-line separators", () => {
  assert.equal((DISCUSSION_OPENING_MESSAGE.match(/\n\n/g) ?? []).length, 2);
  assert.match(facilitatorContentSource, /ai-facilitator-message-content/);
  assert.match(facilitatorContentSource, /renderPlainText\(message\.content \?\? message\.text\)/);
  assert.match(clientCssSource, /\.ai-facilitator-message-content\s*\{[\s\S]*?white-space:\s*pre-line;/);
});

test("opening remains independent of formal silence and Timer reminders", async () => {
  const { handleFormalStageStart } = await getOfflineCallbacksHarness();
  const world = formalWorld({ facilitation: "adaptive", taskIndex: 0 });
  await withCapturedTimers(async (scheduled) => {
    handleFormalStageStart(world.stage);
    assert.equal(world.game.get("humanMessageCount"), undefined);

    const silenceTimer = scheduled.find(({ delay }) => delay === 90_000);
    assert.ok(silenceTimer, "the existing 90-second watchdog must remain scheduled");
    silenceTimer.callback();
    const afterSilence = world.game.get(world.chatKey);
    assert.equal(afterSilence.at(-1).content, "Whenever you’re ready, feel free to jump in — sharing what you each know about the options is a good place to start.");

    for (const timer of scheduled.filter(({ delay }) => delay > 100_000)) timer.callback();
    const timerMessages = world.game.get(world.chatKey).filter((message) => message.messageType === "timer_reminder");
    assert.deepEqual(timerMessages.map((message) => message.content), [
      "8 minutes remain in the discussion.",
      "One minute remains in the discussion.",
    ]);
  });
});
