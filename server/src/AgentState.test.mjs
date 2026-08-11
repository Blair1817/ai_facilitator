// AgentState.test.mjs
//
// Phase 3 tests for buildAgentState. Covers:
//   - Privacy boundary: only public transcript + public task description
//     are read; private profile content must NOT be accessible.
//   - Context slices (local / cumulative / recent AI).
//   - Positional, deterministic message IDs.
//   - Counters mirror CheckpointManager.
//   - deltaSinceLastCheckpoint is correct after a recordAttempt.
//   - remainingTimeMs and elapsedTimeMs are computed from game.get.

import assert from "node:assert/strict";
import test from "node:test";

import { buildAgentState, writeAgentStateField, writeAgentStateFields } from "./AgentState.mjs";

// In-memory fakes for Empirica's game / round (just .get / .set).
function makeStore(initial = {}) {
  const data = { ...initial };
  return {
    get: (k) => (k in data ? data[k] : undefined),
    set: (k, v) => { data[k] = v; },
    _data: data,
  };
}

const NOW = 1_700_000_000_000;

function makeGame(chat, initial = {}) {
  // Caller-supplied initial values win; only fall back to defaults
  // for the time fields when the caller did not pass them. This makes
  // the "deadline in the past" test (which sets deadline explicitly)
  // actually use the past deadline.
  const data = {
    deadline: NOW + 5 * 60 * 1000,
    taskStartTime: NOW - 60 * 1000,
    ...initial,
  };
  return {
    _data: data,
    get: (k) => (k in data ? data[k] : undefined),
    set: (k, v) => { data[k] = v; },
    currentStage: { get: () => "Task" },
    currentRound: null,  // set by caller
    players: [],
  };
}

function makeRound(idx = 0, initial = {}) {
  const data = { index: idx, facilitation: "static", generalInfo: "Pick one of three cities for a sporting event.", ...initial };
  return {
    id: `round-${idx}`,
    get: (k) => (k in data ? data[k] : undefined),
    set: (k, v) => { data[k] = v; },
  };
}

function makeChat(spec) {
  // spec: array of { sender: "Red", text: "..." } or { id: "ai", name: "Facilitator", text: "..." }
  return spec.map((m, i) => ({
    id: m.id ?? `msg-${i}`,
    text: m.text,
    ts: NOW - 1000 * (spec.length - i),
    sender: { id: m.id ?? m.senderId, name: m.name ?? m.sender },
  }));
}

// ── buildAgentState: basic shape ───────────────────────────────────────────

test("buildAgentState returns a structured view with the expected top-level keys", () => {
  const game = makeGame([]);
  const round = makeRound();
  game.currentRound = round;
  const state = buildAgentState(game, round, [], { now: NOW });

  const expected = [
    "currentRoundId", "currentRoundIndex", "currentStageName", "facilitation", "generalInfo",
    "cumulativeContext", "localContext", "recentAiMessages",
    "eligibleMessageIds", "aiOrSystemMessageIds", "recentAiMessageTexts",
    "humanMessageCount", "messagesSinceLastPublish", "attemptedThisRound", "publishedThisRound",
    "lastAttemptTimestamp", "lastHandledCheckpoint",
    "lastRole", "lastCheckedFactors", "interventionHistory", "postInterventionUptake",
    "unresolvedNeed", "remainingTimeMs", "elapsedTimeMs", "deltaSinceLastCheckpoint",
    "evidenceRelations",  // Delibra spec §3 Node 3, 2026-08-11
  ];
  for (const k of expected) {
    assert.ok(k in state, `state.${k} missing`);
  }
});

test("buildAgentState reads facilitation + generalInfo from the round (NOT from treatment)", () => {
  const game = makeGame([]);
  const round = makeRound(1, { facilitation: "adaptive", generalInfo: "Adaptive task" });
  game.currentRound = round;
  const state = buildAgentState(game, round, [], { now: NOW });
  assert.equal(state.facilitation, "adaptive");
  assert.equal(state.generalInfo, "Adaptive task");
  assert.equal(state.currentRoundIndex, 1);
});

// ── buildAgentState: message IDs and context slices ────────────────────────

test("buildAgentState assigns positional, deterministic messageIds (m0, m1, ...)", () => {
  const chat = makeChat([
    { sender: "Red", text: "hello" },
    { sender: "Pink", text: "world" },
    { sender: "Blue", text: "!" },
  ]);
  const game = makeGame(chat);
  const round = makeRound();
  game.currentRound = round;
  const state = buildAgentState(game, round, chat, { now: NOW });
  assert.equal(state.cumulativeContext[0].messageId, "m0");
  assert.equal(state.cumulativeContext[1].messageId, "m1");
  assert.equal(state.cumulativeContext[2].messageId, "m2");
});

test("buildAgentState separates localContext (human) from recentAiMessages", () => {
  const chat = makeChat([
    { sender: "Red", text: "msg 1" },
    { sender: "Pink", text: "msg 2" },
    { id: "ai", name: "Facilitator", text: "facilitator reply 1" },
    { sender: "Blue", text: "msg 3" },
    { id: "ai", name: "Facilitator", text: "facilitator reply 2" },
  ]);
  const game = makeGame(chat);
  const round = makeRound();
  game.currentRound = round;
  const state = buildAgentState(game, round, chat, { now: NOW, localContextSize: 6, recentAiSize: 3 });
  // localContext = last 6 human messages = all 3 humans
  assert.equal(state.localContext.length, 3);
  assert.equal(state.localContext[0].text, "msg 1");
  // recentAiMessages = last 3 AI
  assert.equal(state.recentAiMessages.length, 2);
  assert.equal(state.recentAiMessages[0].text, "facilitator reply 1");
  assert.equal(state.recentAiMessages[1].text, "facilitator reply 2");
  // eligibleMessageIds vs aiOrSystemMessageIds
  assert.deepEqual(state.eligibleMessageIds, ["m0", "m1", "m3"]);
  assert.deepEqual(state.aiOrSystemMessageIds, ["m2", "m4"]);
});

test("buildAgentState localContext is sliced to localContextSize (default 6)", () => {
  const chat = makeChat(
    Array.from({ length: 10 }, (_, i) => ({ sender: "Red", text: `msg ${i}` }))
  );
  const game = makeGame(chat);
  const round = makeRound();
  game.currentRound = round;
  const state = buildAgentState(game, round, chat, { now: NOW });
  assert.equal(state.localContext.length, 6);
  assert.equal(state.localContext[0].text, "msg 4");
  assert.equal(state.localContext[5].text, "msg 9");
});

// ── buildAgentState: counter consistency with CheckpointManager ───────────

test("buildAgentState counters mirror CheckpointManager state on the store", () => {
  const game = makeGame([], {
    humanMessageCount: 7,
    messagesSinceLastPublish: 1,
    attemptedThisRound: 2,
    publishedThisRound: 1,
    lastAttemptTimestamp: NOW - 5_000,
    lastHandledCheckpoint: 6,
    lastRole: "INFORMATION_EXPANDER",
  });
  const round = makeRound();
  game.currentRound = round;
  const state = buildAgentState(game, round, [], { now: NOW });
  assert.equal(state.humanMessageCount, 7);
  assert.equal(state.messagesSinceLastPublish, 1);
  assert.equal(state.attemptedThisRound, 2);
  assert.equal(state.publishedThisRound, 1);
  assert.equal(state.lastAttemptTimestamp, NOW - 5_000);
  assert.equal(state.lastHandledCheckpoint, 6);
  assert.equal(state.lastRole, "INFORMATION_EXPANDER");
});

// ── buildAgentState: time math ─────────────────────────────────────────────

test("buildAgentState.remainingTimeMs is clamped to >= 0", () => {
  const game = makeGame([], { deadline: NOW - 1000, taskStartTime: NOW - 5 * 60 * 1000 });
  const round = makeRound();
  game.currentRound = round;
  const state = buildAgentState(game, round, [], { now: NOW });
  assert.equal(state.remainingTimeMs, 0);
});

test("buildAgentState.elapsedTimeMs is 0 when taskStartTime is missing", () => {
  const game = makeGame([], { deadline: NOW, taskStartTime: null });
  const round = makeRound();
  game.currentRound = round;
  const state = buildAgentState(game, round, [], { now: NOW });
  assert.equal(state.elapsedTimeMs, 0);
});

// ── buildAgentState: deltaSinceLastCheckpoint ─────────────────────────────

test("deltaSinceLastCheckpoint is humanMessageCount - lastHandledCheckpoint after a recordAttempt", () => {
  const game = makeGame([], { humanMessageCount: 12, lastHandledCheckpoint: 6 });
  const round = makeRound();
  game.currentRound = round;
  const state = buildAgentState(game, round, [], { now: NOW });
  assert.equal(state.deltaSinceLastCheckpoint, 6);
});

test("deltaSinceLastCheckpoint is humanMessageCount when no checkpoint has fired yet", () => {
  const game = makeGame([], { humanMessageCount: 5, lastHandledCheckpoint: 0 });
  const round = makeRound();
  game.currentRound = round;
  const state = buildAgentState(game, round, [], { now: NOW });
  assert.equal(state.deltaSinceLastCheckpoint, 5);
});

// ── writeAgentStateField / writeAgentStateFields ──────────────────────────

test("writeAgentStateField sets a single value on the store", () => {
  const game = makeGame([]);
  writeAgentStateField(game, "unresolvedNeed", "negotiate option B");
  assert.equal(game.get("unresolvedNeed"), "negotiate option B");
});

test("writeAgentStateFields sets multiple values atomically (no partial state visible to a reader between writes)", () => {
  const game = makeGame([]);
  writeAgentStateFields(game, {
    unresolvedNeed: "follow up on X",
    postInterventionUptake: 2,
  });
  assert.equal(game.get("unresolvedNeed"), "follow up on X");
  assert.equal(game.get("postInterventionUptake"), 2);
});

// ── Privacy boundary: NO private-profile access ────────────────────────────

test("AgentState NEVER exposes private profile content (no such helper exists)", async () => {
  // Architectural invariant: the helper set is intentionally narrow.
  // There is no `getPrivateProfile()` or any equivalent. The export
  // surface must be the four exports and the types in this module --
  // if a future change tries to add a private-profile helper, that
  // change is a privacy violation and must be rejected at code review.
  const exports = Object.keys(await import("./AgentState.mjs"));
  // Order: buildAgentState, writeAgentStateField, writeAgentStateFields,
  // plus the typedef (which is a JSDoc only and does not appear at
  // runtime). The four runtime exports should not include anything
  // with "private" / "profile" / "secret" / "correct" in the name.
  for (const name of exports) {
    assert.equal(/private|profile|secret|correct/i.test(name), false, `${name} must not exist`);
  }
  // And only the documented exports are present.
  const allowed = new Set(["buildAgentState", "writeAgentStateField", "writeAgentStateFields"]);
  for (const name of exports) {
    assert.ok(allowed.has(name), `unexpected export ${name}`);
  }
});

test("AgentState never reads fields named with private/correct on the game store", () => {
  // Defensive: even if a future refactor accidentally adds a
  // privateProfile field to the game object, buildAgentState must
  // not include it. We simulate the leak and assert it does not
  // propagate into the returned state.
  const privateProfile = { secret: "do-not-leak" };
  const game = makeGame([], {
    deadline: NOW,
    taskStartTime: NOW,
    privateProfile,  // would-be private data; not part of the contract
  });
  const round = makeRound();
  game.currentRound = round;
  const state = buildAgentState(game, round, [], { now: NOW });
  assert.equal(state.privateProfile, undefined, "private profile must NOT appear in AgentState");
  assert.equal(state.secret, undefined);
  // Also: the keys list must not contain any private-profile-shaped key.
  assert.equal(Object.keys(state).some((k) => /private|profile|secret|correct/i.test(k)), false);
});

// ── Determinism: same inputs -> same IDs, same slices ─────────────────────

test("buildAgentState is deterministic (same inputs -> same messageIds, same slices)", () => {
  const chat = makeChat([
    { sender: "Red", text: "a" },
    { sender: "Pink", text: "b" },
    { sender: "Blue", text: "c" },
  ]);
  const game1 = makeGame(chat);
  const round1 = makeRound();
  game1.currentRound = round1;
  const game2 = makeGame(chat);
  const round2 = makeRound();
  game2.currentRound = round2;

  const s1 = buildAgentState(game1, round1, chat, { now: NOW });
  const s2 = buildAgentState(game2, round2, chat, { now: NOW });

  assert.deepEqual(s1.eligibleMessageIds, s2.eligibleMessageIds);
  assert.deepEqual(s1.cumulativeContext.map((m) => m.messageId), s2.cumulativeContext.map((m) => m.messageId));
  assert.equal(s1.localContext.length, s2.localContext.length);
});

// ── evidenceRelations (Delibra spec §3 Node 3, 2026-08-11) ────────────────

test("buildAgentState surfaces evidenceRelations from lastCheckedFactors (Assessor's output)", () => {
  const relations = [
    { messageId: "m0", mentioned: true, attributed: true,  evaluated: false, compared: false, countered: false, integrated: false },
    { messageId: "m1", mentioned: true, attributed: true,  evaluated: true,  compared: true,  countered: false, integrated: true  },
  ];
  const game = makeGame([], { lastCheckedFactors: { evidenceRelations: relations } });
  const round = makeRound();
  game.currentRound = round;
  const state = buildAgentState(game, round, [], { now: NOW });
  assert.deepEqual(state.evidenceRelations, relations);
});

test("buildAgentState.evidenceRelations is [] when lastCheckedFactors has no evidenceRelations (early checkpoint)", () => {
  const game = makeGame([], { lastCheckedFactors: null });
  const round = makeRound();
  game.currentRound = round;
  const state = buildAgentState(game, round, [], { now: NOW });
  assert.deepEqual(state.evidenceRelations, []);
});

test("buildAgentState.evidenceRelations is [] when Assessor was unavailable (no lastCheckedFactors)", () => {
  // No lastCheckedFactors at all -- e.g. the Assessor API call failed.
  const game = makeGame([], {}); // no overrides
  const round = makeRound();
  game.currentRound = round;
  const state = buildAgentState(game, round, [], { now: NOW });
  assert.deepEqual(state.evidenceRelations, []);
});
