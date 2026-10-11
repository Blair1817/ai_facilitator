import assert from "node:assert/strict";
import test from "node:test";

import {
  FORMAL_INITIAL_DECISION_SECONDS,
  SHARED_BREAK_READY_WINDOW_SECONDS,
  SHARED_BREAK_SECONDS,
  canAdvanceSharedBreak,
  canConfirmSharedBreak,
  personalProgressKey,
} from "../../shared/personalFlow.mjs";
import {
  registerPersonalFlow,
  sharedBreakState,
  synchroniseSharedBreak,
} from "./PersonalFlow.mjs";

function scope(id, initial = {}) {
  const data = new Map(Object.entries(initial));
  return { id, get: (key) => data.get(key), set: (key, value) => data.set(key, value), data };
}

function fixture(indices = [3, 3, 3]) {
  const round = scope("round-1", { taskIndex: 0 });
  const stage = scope("followup", { name: "Followup" });
  const game = scope("game-1");
  const key = personalProgressKey("Followup");
  const players = indices.map((index, playerIndex) => {
    const playerRound = scope(`player-round-${playerIndex}`, { [key]: { index, startedAt: 100 + playerIndex } });
    return { id: `p${playerIndex + 1}`, round: playerRound };
  });
  game.players = players;
  game.currentRound = round;
  game.currentStage = stage;
  stage.round = round;
  stage.currentGame = game;
  round.currentGame = game;
  for (const player of players) player.currentGame = game;
  const listeners = new Map();
  const mirrors = [];
  const api = {
    on: (_kind, attribute, callback) => listeners.set(attribute, callback),
    flush() {},
  };
  const mirror = (player, _round, page) => mirrors.push([player.id, page]);
  registerPersonalFlow(api, mirror);
  const request = (player, action = "sync", extra = {}) => listeners.get("sharedBreakRequest")({}, {
    player,
    sharedBreakRequest: {
      action,
      requestId: `${player.id}-${action}-${Date.now()}`,
      roundId: round.id,
      stageId: stage.id,
      index: player.round.get(key).index,
      ...extra,
    },
  });
  return { api, game, key, listeners, mirror, mirrors, players, request, round, stage };
}

function preparationFixture({ taskIndex, startedAt, initialDecision = null }) {
  const round = scope(`round-${taskIndex}`, { taskIndex });
  const stage = scope(`preparation-${taskIndex}`, { name: "Preparation" });
  const game = scope(`game-${taskIndex}`);
  const key = personalProgressKey("Preparation");
  const playerRound = scope(`player-round-${taskIndex}`, {
    [key]: { index: 2, startedAt },
    ...(initialDecision ? { initialDecision } : {}),
  });
  const player = { id: `p-${taskIndex}`, round: playerRound };
  game.players = [player];
  game.currentRound = round;
  game.currentStage = stage;
  stage.round = round;
  stage.currentGame = game;
  round.currentGame = game;
  player.currentGame = game;
  const listeners = new Map();
  const mirrors = [];
  const api = {
    on: (_kind, attribute, callback) => listeners.set(attribute, callback),
    flush() {},
  };
  registerPersonalFlow(api, (_player, _round, page) => mirrors.push(page));
  const request = () => listeners.get("personalPageRequest")({}, {
    player,
    personalPageRequest: {
      requestId: `initial-${taskIndex}`,
      roundId: round.id,
      stageId: stage.id,
      index: player.round.get(key).index,
    },
  });
  return { key, mirrors, player, request };
}

test("both formal rounds accept an Initial Decision before 300 seconds and time out at the boundary", (t) => {
  const now = 1_000_000;
  t.mock.method(Date, "now", () => now);
  assert.equal(FORMAL_INITIAL_DECISION_SECONDS, 300);

  for (const taskIndex of [0, 1]) {
    const submitted = preparationFixture({
      taskIndex,
      startedAt: now - FORMAL_INITIAL_DECISION_SECONDS * 1000 + 1,
      initialDecision: { choice: "A", confidence: 50, submittedAt: now },
    });
    submitted.request();
    assert.equal(submitted.player.round.get(submitted.key).index, 3);
    assert.equal(submitted.player.round.get("initialSubmittedAt"), now);
    assert.equal(submitted.player.round.get("initialDecisionTimeoutReason"), null);
    assert.deepEqual(submitted.mirrors, ["InitialDecision"]);

    const waiting = preparationFixture({
      taskIndex,
      startedAt: now - FORMAL_INITIAL_DECISION_SECONDS * 1000 + 1,
    });
    waiting.request();
    assert.equal(waiting.player.round.get(waiting.key).index, 2);
    assert.equal(waiting.player.round.get("initialDecisionTimeoutReason"), undefined);

    waiting.player.round.set(waiting.key, {
      index: 2,
      startedAt: now - FORMAL_INITIAL_DECISION_SECONDS * 1000,
    });
    waiting.request();
    assert.equal(waiting.player.round.get(waiting.key).index, 3);
    assert.equal(waiting.player.round.get("initialSubmittedAt"), null);
    assert.equal(waiting.player.round.get("initialDecisionTimeoutReason"), "stage_timeout");
  }
});

test("shared Break constants and exact boundary rules are five minutes and final 30 seconds", () => {
  assert.equal(SHARED_BREAK_SECONDS, 300);
  assert.equal(SHARED_BREAK_READY_WINDOW_SECONDS, 30);
  const deadline = 1_000_000;
  assert.equal(canConfirmSharedBreak(deadline, deadline - 30_001), false);
  assert.equal(canConfirmSharedBreak(deadline, deadline - 30_000), true);
  assert.equal(canAdvanceSharedBreak(deadline, true, deadline - 1), false);
  assert.equal(canAdvanceSharedBreak(deadline, false, deadline), false);
  assert.equal(canAdvanceSharedBreak(deadline, true, deadline), true);
});

test("one or two arrivals cannot start the shared Break; the third starts one persisted deadline", () => {
  const f = fixture([3, 3, 2]);
  const start = Date.now() + 60_000;
  synchroniseSharedBreak(f.stage, f.mirror, f.api, start);
  assert.equal(f.round.get("sharedBreakArrivalCount"), 2);
  assert.equal(f.round.get("sharedBreakDeadline"), undefined);

  f.players[2].round.set(f.key, { index: 3, startedAt: start + 1 });
  synchroniseSharedBreak(f.stage, f.mirror, f.api, start + 1);
  const deadline = f.round.get("sharedBreakDeadline");
  assert.equal(deadline, start + 1 + SHARED_BREAK_SECONDS * 1000);
  synchroniseSharedBreak(f.stage, f.mirror, f.api, start + 5_000);
  assert.equal(f.round.get("sharedBreakDeadline"), deadline, "refresh/reconnect must not restart the countdown");

  for (const player of f.players) player.round.set("sharedBreakReadyStatus", "ready");
  synchroniseSharedBreak(f.stage, f.mirror, f.api, deadline);
  assert.equal(f.stage.get("ended"), true);
});

test("readiness is rejected before the final 30 seconds and early readiness cannot advance before 00:00", () => {
  const f = fixture();
  f.request(f.players[0], "sync");
  const originalDeadline = f.round.get("sharedBreakDeadline");
  assert.ok(Number.isFinite(originalDeadline));

  f.request(f.players[0], "ready");
  assert.equal(f.players[0].round.get("sharedBreakReadyStatus"), "not_ready");
  assert.ok(Number.isFinite(f.players[0].round.get("sharedBreakReadyRejectedAt")));

  f.round.set("sharedBreakDeadline", Date.now() + 30_000);
  for (const player of f.players) f.request(player, "ready");
  assert.equal(sharedBreakState(f.players, "Followup", 0).allReady, true);
  assert.equal(f.stage.get("ended"), undefined, "all ready early must still wait for the full break");

  f.round.set("sharedBreakDeadline", Date.now() - 1);
  f.request(f.players[0], "sync");
  assert.equal(f.stage.get("ended"), true);
  assert.ok(f.players.every((player) => player.round.get(f.key).index === 4));
  assert.equal(f.mirrors.length, 3);
});

test("00:00 waits for every participant and the last readiness confirmation advances exactly once", () => {
  const f = fixture();
  f.request(f.players[0], "sync");
  f.round.set("sharedBreakDeadline", Date.now() - 1);
  f.players[0].round.set("sharedBreakReadyStatus", "ready");
  f.players[1].round.set("sharedBreakReadyStatus", "ready");
  f.request(f.players[0], "sync");
  assert.equal(f.stage.get("ended"), undefined);

  f.request(f.players[2], "ready");
  assert.equal(f.stage.get("ended"), true);
  assert.equal(f.mirrors.length, 3);
  f.request(f.players[2], "ready");
  assert.equal(f.mirrors.length, 3, "duplicate requests cannot complete the break twice");
});

test("legacy skipBreak requests cannot bypass the shared Break barrier", () => {
  const f = fixture();
  const before = f.players[0].round.get(f.key);
  f.listeners.get("personalPageRequest")({}, {
    player: f.players[0],
    personalPageRequest: {
      requestId: "legacy-skip",
      roundId: f.round.id,
      stageId: f.stage.id,
      index: before.index,
      skipBreak: true,
    },
  });
  assert.deepEqual(f.players[0].round.get(f.key), before);
  assert.equal(f.players[0].round.get("breakSkippedAt"), undefined);
  assert.equal(f.stage.get("ended"), undefined);
});
