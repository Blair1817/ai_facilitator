import assert from "node:assert/strict";
import test from "node:test";
import { Attribute } from "@empirica/core/player/classic";

import {
  beginPersonalPageRequest,
  FORMAL_INITIAL_DECISION_SECONDS,
  nextPersonalPageRequestAttempt,
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
  const writes = [];
  return {
    id,
    get: (key) => data.get(key),
    set: (key, value) => {
      writes.push([key, value]);
      data.set(key, value);
    },
    data,
    writes,
  };
}

let fixtureSequence = 0;

function fixture(indices = [3, 3, 3], decisionFlowVersion = 1) {
  fixtureSequence += 1;
  const round = scope(`round-${fixtureSequence}`, { taskIndex: 0, decisionFlowVersion });
  const stage = scope(`followup-${fixtureSequence}`, { name: "Followup" });
  const game = scope(`game-${fixtureSequence}`);
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
  stage.isCurrent = () => game.currentStage?.id === stage.id && !stage.get("ended");
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

function preparationFixture({ taskIndex, startedAt, initialDecision = null, receivedAt = null }) {
  const round = scope(`round-${taskIndex}`, {
    taskIndex,
    decisionOptions: [{ id: "A" }, { id: "B" }, { id: "C" }],
  });
  const stage = scope(`preparation-${taskIndex}`, { name: "Preparation" });
  const game = scope(`game-${taskIndex}`);
  const key = personalProgressKey("Preparation");
  const playerRound = scope(`player-round-${taskIndex}`, {
    [key]: { index: 2, startedAt },
    ...(initialDecision ? { initialDecision } : {}),
    ...(Number.isFinite(receivedAt) ? { initialDecisionReceivedAt: receivedAt } : {}),
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
  const request = (extra = {}) => listeners.get("personalPageRequest")({}, {
    player,
    personalPageRequest: {
      requestId: `initial-${taskIndex}`,
      roundId: round.id,
      stageId: stage.id,
      index: player.round.get(key).index,
      ...extra,
    },
  });
  return { key, mirrors, player, request, round, stage };
}

function followupFormsFixture() {
  const round = scope("round-followup-forms", { taskIndex: 1 });
  const stage = scope("followup-forms", { name: "Followup" });
  const game = scope("game-followup-forms");
  const key = personalProgressKey("Followup");
  const playerRound = scope("player-round-followup-forms", {
    [key]: { index: 1, startedAt: 1_000 },
    tlxSurvey: { mentalDemand: 25 },
  });
  const player = {
    id: "p-followup-forms",
    round: playerRound,
    get() {},
  };
  game.players = [player];
  game.currentRound = round;
  game.currentStage = stage;
  stage.round = round;
  stage.currentGame = game;
  round.currentGame = game;
  player.currentGame = game;
  const listeners = new Map();
  const mirrors = [];
  registerPersonalFlow({
    on: (_kind, attribute, callback) => listeners.set(attribute, callback),
    flush() {},
  }, (_player, _round, page) => mirrors.push(page));
  const request = (requestId) => listeners.get("personalPageRequest")({}, {
    player,
    personalPageRequest: {
      requestId,
      attemptNumber: 1,
      roundId: round.id,
      stageId: stage.id,
      index: player.round.get(key).index,
    },
  });
  return { key, mirrors, player, request };
}

test("PersonalFlow retries preserve logical identity and bypass Empirica's identical-value suppression", () => {
  const initialDecision = { choice: "B", confidence: 60, clientSubmittedAt: 123_456 };
  const started = beginPersonalPageRequest(null, { initialDecision }, () => "stable-request-id");
  const routing = { roundId: "round-1", stageId: "preparation-1", index: 2 };
  const first = nextPersonalPageRequestAttempt(started.request, routing);
  const second = nextPersonalPageRequestAttempt(first.pending, routing);

  assert.equal(started.created, true);
  assert.equal(first.transmission.requestId, "stable-request-id");
  assert.equal(second.transmission.requestId, "stable-request-id");
  assert.equal(first.transmission.attemptNumber, 1);
  assert.equal(second.transmission.attemptNumber, 2);
  assert.deepEqual(first.transmission.initialDecision, initialDecision);
  assert.deepEqual(second.transmission.initialDecision, initialDecision);
  assert.notEqual(JSON.stringify(first.transmission), JSON.stringify(second.transmission));

  const submitted = [];
  const attribute = new Attribute((attributes) => submitted.push(...attributes), "player-1", "personalPageRequest");
  attribute.set(first.transmission);
  attribute.set(first.transmission);
  assert.equal(submitted.length, 1, "Empirica suppresses an identical serialised retry");
  attribute.set(second.transmission);
  assert.equal(submitted.length, 2, "the changed attempt number causes Empirica to submit the retry");
});

test("a lost first PersonalFlow transmission is followed by a deliverable retry", (t) => {
  const startedAt = 10_000_000;
  t.mock.method(Date, "now", () => startedAt + 1_000);
  const f = preparationFixture({ taskIndex: 0, startedAt });
  const response = { choice: "A", confidence: 40, clientSubmittedAt: startedAt + 500 };
  const logical = beginPersonalPageRequest(null, { initialDecision: response }, () => "lost-then-retried");
  const routing = { roundId: f.round.id, stageId: f.stage.id, index: 2 };
  const first = nextPersonalPageRequestAttempt(logical.request, routing);
  const second = nextPersonalPageRequestAttempt(first.pending, routing);
  let transmissions = 0;
  const attribute = new Attribute((attributes) => {
    transmissions += 1;
    if (transmissions === 1) return;
    f.request(JSON.parse(attributes[0].val));
  }, f.player.id, "personalPageRequest");

  attribute.set(first.transmission);
  assert.equal(f.player.round.get(f.key).index, 2, "the deliberately lost first update cannot advance the page");
  attribute.set(second.transmission);
  assert.equal(f.player.round.get(f.key).index, 3);
  assert.equal(f.player.round.get("initialDecision").choice, "A");
  assert.deepEqual(f.mirrors, ["InitialDecision"]);
});

test("pending Initial Decision recovery retains payload, request ID, and retry sequence", () => {
  const response = { choice: "C", confidence: 100, clientSubmittedAt: 555_000 };
  const started = beginPersonalPageRequest(null, { initialDecision: response }, () => "refresh-stable-id");
  const first = nextPersonalPageRequestAttempt(started.request, {
    roundId: "round-refresh", stageId: "stage-refresh", index: 2,
  });
  const restored = JSON.parse(JSON.stringify(first.pending));
  let generatedIds = 0;
  const recovered = beginPersonalPageRequest(restored, { initialDecision: response }, () => {
    generatedIds += 1;
    return "must-not-be-used";
  });
  const retry = nextPersonalPageRequestAttempt(recovered.request, {
    roundId: "round-refresh", stageId: "stage-refresh", index: 2,
  });

  assert.equal(recovered.created, false);
  assert.equal(generatedIds, 0);
  assert.equal(retry.transmission.requestId, "refresh-stable-id");
  assert.equal(retry.transmission.attemptNumber, 2);
  assert.deepEqual(retry.transmission.initialDecision, response);
});

test("a synchronous guard prevents StrictMode-style duplicate request creation and storage", () => {
  const pendingRef = { current: null };
  const stored = [];
  let generatedIds = 0;
  const submit = () => {
    const result = beginPersonalPageRequest(
      pendingRef.current,
      { initialDecision: { choice: "A", confidence: 0, clientSubmittedAt: 99 } },
      () => `strict-${++generatedIds}`,
    );
    if (!result.created) return;
    pendingRef.current = result.request;
    stored.push(JSON.stringify(result.request));
  };

  submit();
  submit();
  assert.equal(generatedIds, 1);
  assert.equal(stored.length, 1);
  assert.equal(JSON.parse(stored[0]).requestId, pendingRef.current.requestId);
  assert.deepEqual(JSON.parse(stored[0]).initialDecision, pendingRef.current.initialDecision);
});

test("TLX and Subjective Survey still advance independently through personalPageRequest", () => {
  const f = followupFormsFixture();
  f.request("tlx-request");
  assert.equal(f.player.round.get(f.key).index, 2);
  assert.deepEqual(f.mirrors, ["TLX"]);

  f.player.round.set("subjectiveSurvey", { satisfaction: 5 });
  f.request("subjective-request");
  assert.equal(f.player.round.get(f.key).index, 3);
  assert.deepEqual(f.mirrors, ["TLX", "SubjectiveSurvey"]);
});

test("both formal rounds use server receipt time for the 300-second Initial Decision deadline", (t) => {
  let now = 1_000_000;
  t.mock.method(Date, "now", () => now);
  assert.equal(FORMAL_INITIAL_DECISION_SECONDS, 300);

  for (const taskIndex of [0, 1]) {
    const startedAt = 700_000;
    const justBefore = preparationFixture({ taskIndex, startedAt });
    now = startedAt + FORMAL_INITIAL_DECISION_SECONDS * 1000 - 1;
    justBefore.request({
      initialDecision: { choice: "A", confidence: 0, clientSubmittedAt: now - 10 },
    });
    assert.equal(justBefore.player.round.get(justBefore.key).index, 3);
    assert.equal(justBefore.player.round.get("initialDecisionReceivedAt"), now);
    assert.equal(justBefore.player.round.get("initialSubmittedAt"), now);
    assert.equal(justBefore.player.round.get("initialDecisionAcceptedOnTime"), true);
    assert.equal(justBefore.player.round.get("initialDecisionTimeoutReason"), null);
    assert.equal(justBefore.player.round.get("initialDecision").submittedAt, now);
    assert.equal(justBefore.player.round.get("initialDecision").clientSubmittedAt, now - 10);
    assert.deepEqual(justBefore.mirrors, ["InitialDecision"]);

    const exactlyAt = preparationFixture({ taskIndex, startedAt });
    now = startedAt + FORMAL_INITIAL_DECISION_SECONDS * 1000;
    exactlyAt.request({
      initialDecision: { choice: "A", confidence: 50, clientSubmittedAt: now - 1_000 },
    });
    assert.equal(exactlyAt.player.round.get(exactlyAt.key).index, 3);
    assert.equal(exactlyAt.player.round.get("initialSubmittedAt"), null);
    assert.equal(exactlyAt.player.round.get("initialDecisionAcceptedOnTime"), false);
    assert.equal(exactlyAt.player.round.get("initialDecisionTimeoutReason"), "late_submission");

    const justAfter = preparationFixture({ taskIndex, startedAt });
    now = startedAt + FORMAL_INITIAL_DECISION_SECONDS * 1000 + 1;
    justAfter.request({
      initialDecision: { choice: "B", confidence: 100, clientSubmittedAt: startedAt + 1 },
    });
    assert.equal(justAfter.player.round.get("initialSubmittedAt"), null);
    assert.equal(justAfter.player.round.get("initialDecisionReceivedAt"), now);
    assert.equal(justAfter.player.round.get("initialDecisionTimeoutReason"), "late_submission");
    assert.equal(justAfter.player.round.get("initialDecision").choice, "B", "late response remains available for audit");

    const missing = preparationFixture({ taskIndex, startedAt });
    now = startedAt + FORMAL_INITIAL_DECISION_SECONDS * 1000;
    missing.request();
    assert.equal(missing.player.round.get(missing.key).index, 3);
    assert.equal(missing.player.round.get("initialDecisionReceivedAt"), undefined);
    assert.equal(missing.player.round.get("initialSubmittedAt"), null);
    assert.equal(missing.player.round.get("initialDecisionTimeoutReason"), "stage_timeout");
  }
});

test("a timely server-received Initial Decision survives delayed progression and refresh/reconnect", (t) => {
  const startedAt = 2_000_000;
  const receivedAt = startedAt + FORMAL_INITIAL_DECISION_SECONDS * 1000 - 1;
  const response = {
    choice: "C",
    confidence: 75,
    submittedAt: receivedAt,
    serverReceivedAt: receivedAt,
    clientSubmittedAt: receivedAt - 50,
    acceptedOnTime: true,
  };
  const f = preparationFixture({ taskIndex: 1, startedAt, initialDecision: response, receivedAt });
  t.mock.method(Date, "now", () => receivedAt + 10_000);

  f.request({
    requestId: "timely-retry",
    attemptNumber: 2,
    initialDecision: {
      choice: "A",
      confidence: 10,
      clientSubmittedAt: receivedAt + 5_000,
    },
  });
  assert.equal(f.player.round.get(f.key).index, 3);
  assert.equal(f.player.round.get("initialSubmittedAt"), receivedAt);
  assert.equal(f.player.round.get("initialCompletionDurationMs"), receivedAt - startedAt);
  assert.equal(f.player.round.get("initialDecisionTimeoutReason"), null);
  assert.deepEqual(f.player.round.get("initialDecision"), response);

  f.request({ requestId: "timely-retry", attemptNumber: 3, index: 2 });
  assert.equal(f.player.round.get(f.key).index, 3);
  assert.deepEqual(f.mirrors, ["InitialDecision"], "a reconnect retry cannot submit or mirror twice");
});

test("Initial Decision rejects invalid payloads before the deadline", (t) => {
  const now = 3_000_000;
  t.mock.method(Date, "now", () => now);
  const f = preparationFixture({ taskIndex: 0, startedAt: now - 1_000 });
  for (const initialDecision of [
    { choice: "UNKNOWN", confidence: 50 },
    { choice: "A", confidence: -1 },
    { choice: "A", confidence: 101 },
    { choice: "A", confidence: Number.NaN },
  ]) f.request({ initialDecision });
  assert.equal(f.player.round.get(f.key).index, 2);
  assert.equal(f.player.round.get("initialDecision"), undefined);
  assert.deepEqual(f.mirrors, []);
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

test("periodic Break sync avoids identical writes and does not rearm the same deadline", (t) => {
  const scheduled = [];
  t.mock.method(globalThis, "setTimeout", (callback, delay) => {
    const timeout = { callback, delay, unref() {} };
    scheduled.push(timeout);
    return timeout;
  });
  t.mock.method(globalThis, "clearTimeout", () => {});
  const f = fixture();
  const now = 4_000_000;

  synchroniseSharedBreak(f.stage, f.mirror, f.api, now);
  assert.equal(scheduled.length, 1);
  const writesAfterStart = f.round.writes.length;
  synchroniseSharedBreak(f.stage, f.mirror, f.api, now + 2_000);
  assert.equal(f.round.writes.length, writesAfterStart, "unchanged counts/status must not be rewritten");
  assert.equal(scheduled.length, 1, "the same persisted deadline must retain one timer");

  for (const player of f.players) player.round.set("sharedBreakReadyStatus", "ready");
  f.game.currentStage = scope("unrelated-stage", { name: "Task" });
  scheduled[0].callback();
  assert.equal(f.stage.get("ended"), undefined, "a stale timer cannot advance a no-longer-current stage");
  assert.equal(f.mirrors.length, 0);
});

test("a lost or delayed Ready request can be retried idempotently with one request ID", (t) => {
  let now = 5_000_000;
  t.mock.method(Date, "now", () => now);
  const f = fixture();
  f.request(f.players[0], "sync");
  f.round.set("sharedBreakDeadline", now + 30_000);
  const stableRequestId = "break-ready-p1";

  // The first client send is deliberately not delivered. A later retry with
  // the same ID records exactly one logical confirmation.
  now += 1;
  f.request(f.players[0], "ready", { requestId: stableRequestId });
  assert.equal(f.players[0].round.get("sharedBreakReadyStatus"), "ready");
  assert.equal(f.players[0].round.get("sharedBreakReadyRequestId"), stableRequestId);
  const confirmedAt = f.players[0].round.get("sharedBreakReadyConfirmedAt");
  const readyWrites = f.players[0].round.writes.filter(([key]) => key === "sharedBreakReadyStatus").length;

  now += 2_000;
  f.request(f.players[0], "ready", { requestId: stableRequestId });
  assert.equal(f.players[0].round.get("sharedBreakReadyConfirmedAt"), confirmedAt);
  assert.equal(f.players[0].round.writes.filter(([key]) => key === "sharedBreakReadyStatus").length, readyWrites);
  assert.equal(f.stage.get("ended"), undefined, "one acknowledgement cannot advance the shared Break");
});

test("an early Ready rejection is request-specific and can be retried in the allowed window", (t) => {
  let now = 6_000_000;
  t.mock.method(Date, "now", () => now);
  const f = fixture();
  f.request(f.players[0], "sync");
  const requestId = "early-ready-p1";

  f.request(f.players[0], "ready", { requestId });
  assert.equal(f.players[0].round.get("sharedBreakReadyStatus"), "not_ready");
  assert.equal(f.players[0].round.get("sharedBreakReadyRejectedRequestId"), requestId);
  const rejectedAt = f.players[0].round.get("sharedBreakReadyRejectedAt");
  now += 1_000;
  f.request(f.players[0], "ready", { requestId });
  assert.equal(f.players[0].round.get("sharedBreakReadyRejectedAt"), rejectedAt,
    "duplicate delivery must not create another rejection event");

  now = f.round.get("sharedBreakDeadline") - 30_000;
  f.request(f.players[0], "ready", { requestId: "allowed-ready-p1" });
  assert.equal(f.players[0].round.get("sharedBreakReadyStatus"), "ready");
  assert.equal(f.players[0].round.get("sharedBreakReadyRequestId"), "allowed-ready-p1");
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

test("v2 shared break uses the shorter follow-up cursor and completes after the original deadline", () => {
  const f = fixture([2, 2, 1], 2), now = Date.now();
  synchroniseSharedBreak(f.stage, f.mirror, f.api, now);
  assert.equal(f.round.get("sharedBreakArrivalCount"), 2);
  assert.equal(f.round.get("sharedBreakDeadline"), undefined);
  f.players[2].round.set(f.key, { index: 2, startedAt: now });
  synchroniseSharedBreak(f.stage, f.mirror, f.api, now);
  const deadline = f.round.get("sharedBreakDeadline");
  assert.equal(deadline, now + SHARED_BREAK_SECONDS * 1000);
  for (const player of f.players) player.round.set("sharedBreakReadyStatus", "ready");
  assert.equal(synchroniseSharedBreak(f.stage, f.mirror, f.api, deadline - 1), false);
  assert.equal(synchroniseSharedBreak(f.stage, f.mirror, f.api, deadline), true);
  assert.equal(f.stage.get("ended"), true);
  assert.ok(f.players.every((player) => player.round.get(f.key).index === 3));
  assert.equal(f.mirrors.length, 3);
});
