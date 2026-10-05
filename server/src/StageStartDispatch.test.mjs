import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { handlePersonalFlowStageStart } from "./PersonalFlow.mjs";
import {
  handlePracticeStageStart,
  registerPractice,
} from "./PracticeOnboarding.mjs";

const dirname = path.dirname(fileURLToPath(import.meta.url));
const callbacksSource = readFileSync(path.join(dirname, "callbacks.js"), "utf8");
const practiceSource = readFileSync(path.join(dirname, "PracticeOnboarding.mjs"), "utf8");
const personalFlowSource = readFileSync(path.join(dirname, "PersonalFlow.mjs"), "utf8");

function scope(id, attributes = {}) {
  const data = new Map(Object.entries(attributes));
  return {
    id,
    data,
    get: (key) => data.get(key),
    set: (key, value) => data.set(key, value),
  };
}

function gameFixture() {
  const game = scope("game", { treatment: { gameDuration: 10 } });
  game.players = ["Blue", "Pink", "Green"].map((name, index) => ({
    ...scope(`p${index}`, { name, hexCode: "206EEF" }),
    currentGame: game,
    round: scope(`practice-player-round-${index}`),
    stage: scope(`practice-player-stage-${index}`),
  }));
  return game;
}

function attachStage(game, name, roundAttributes) {
  const round = scope(`${name}-round`, roundAttributes);
  const stage = scope(`${name}-stage`, { name });
  round.currentGame = game;
  stage.round = round;
  stage.currentGame = game;
  stage.isCurrent = () => !stage.get("ended");
  game.currentRound = round;
  game.currentStage = stage;
  return { round, stage };
}

test("production registers exactly one Empirica onStageStart dispatcher", () => {
  assert.equal((callbacksSource.match(/Empirica\.onStageStart\s*\(/g) ?? []).length, 1);
  assert.doesNotMatch(practiceSource, /\.onStageStart\s*\(/);
  assert.doesNotMatch(personalFlowSource, /\.onStageStart\s*\(/);
  assert.match(
    callbacksSource,
    /Empirica\.onStageStart\(\(\{ stage \}\) => \{\s*handlePracticeStageStart\([\s\S]*handlePersonalFlowStageStart\(stage\);[\s\S]*handleFormalStageStart\(stage\);\s*\}\);/,
  );
});

test("single dispatch preserves PracticeWelcome and PracticeDiscussion initialisation", () => {
  const game = gameFixture();
  const messages = [];
  const append = (_game, key, message) => messages.push({ key, ...message });
  const api = { flush() {} };

  const welcome = attachStage(game, "PracticeWelcome", { isPractice: true, index: 0 });
  handlePracticeStageStart(welcome.stage, append, api);
  const welcomeStartedAt = welcome.stage.get("practiceStartedAt");
  handlePracticeStageStart(welcome.stage, append, api);
  assert.equal(welcome.round.get("practiceState"), "PracticeWelcome");
  assert.equal(welcome.round.get("practiceStarted"), true);
  assert.ok(Number.isFinite(welcomeStartedAt));
  assert.equal(welcome.stage.get("practiceStartedAt"), welcomeStartedAt);
  assert.equal(messages.filter((message) => message.stage === "PracticeWelcome").length, 1);

  const discussion = attachStage(game, "PracticeDiscussion", { isPractice: true, index: 0 });
  handlePracticeStageStart(discussion.stage, append, api);
  const startedAt = discussion.round.get("practiceDiscussionStartedAt");
  assert.ok(Number.isFinite(startedAt));
  assert.equal(discussion.round.get("practiceDeadline"), startedAt + 240000);
  assert.deepEqual(discussion.round.get("practiceMessageCounts"), {});
  assert.equal(discussion.round.get("practiceTotalMessages"), 0);
  assert.deepEqual(discussion.round.get("practiceReady"), {});
});

test("three PracticeComplete participants enter formal Preparation with personal cursors", () => {
  const game = gameFixture();
  const practice = attachStage(game, "PracticeComplete", { isPractice: true, index: 0 });
  const listeners = new Map();
  const api = {
    on: (_kind, key, callback) => listeners.set(key, callback),
    flush() {},
  };
  registerPractice(api);
  for (const player of game.players) {
    listeners.get("practiceRequest")({}, {
      player,
      practiceRequest: {
        action: "continue",
        page: "PracticeComplete",
        roundId: practice.round.id,
        stageId: practice.stage.id,
      },
    });
  }
  assert.equal(practice.stage.get("ended"), true);
  assert.equal(game.get("practice_complete"), true);

  const preparation = attachStage(game, "Preparation", { taskIndex: 0 });
  for (const [index, player] of game.players.entries()) {
    player.round = scope(`formal-player-round-${index}`);
  }
  handlePracticeStageStart(preparation.stage, () => {}, api);
  handlePersonalFlowStageStart(preparation.stage);

  for (const player of game.players) {
    const progress = player.round.get("personalProgress_Preparation");
    assert.equal(progress.index, 0);
    assert.ok(Number.isFinite(progress.startedAt));
  }
});

test("formal Followup receives an idempotent cursor for all three participants", () => {
  const game = gameFixture();
  for (const [index, player] of game.players.entries()) player.round = scope(`formal-player-round-${index}`);
  const { stage } = attachStage(game, "Followup", { taskIndex: 0 });
  handlePersonalFlowStageStart(stage);
  const timestamps = game.players.map((player) => player.round.get("personalProgress_Followup").startedAt);
  handlePersonalFlowStageStart(stage);
  assert.deepEqual(
    game.players.map((player) => player.round.get("personalProgress_Followup").startedAt),
    timestamps,
  );
  assert.ok(timestamps.every(Number.isFinite));
});

test("Practice FinalDecision still passes through the existing FinalDecision initialisation", () => {
  const start = callbacksSource.indexOf("export function handleFormalStageStart(stage)");
  const end = callbacksSource.indexOf("Empirica.onStageStart", start);
  const handler = callbacksSource.slice(start, end);
  assert.match(handler, /stage\.round\.get\("isPractice"\) && stageName !== "FinalDecision"/);
  assert.match(handler, /if \(stageName === "FinalDecision"\)/);
  assert.match(handler, /finalDecisionAgreementStatus", "not_agreed"/);
  assert.match(handler, /for \(const participant of assignedHumanPlayers\(game\)\)/);
  assert.match(handler, /if \(!stage\.round\.get\("isPractice"\)\) setTimeout/);
});
