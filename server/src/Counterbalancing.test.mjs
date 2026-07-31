// Unit + adapter tests for Counterbalancing.mjs (GRAIL-native stabilization
// revision: this module is a small sequence-mapping + Round-creation
// helper, not a lifecycle framework -- no idempotent recovery, no
// conflict-check, no allocation ledger). Uses Node's built-in test runner,
// matching the existing convention in this directory.
//
// Deliberately does NOT import callbacks.js itself (same reason documented
// in RoutingIntegration.test.mjs: it registers real Empirica listeners and
// touches dotenv/fetch on import).

import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import _ from "lodash"; // used only by the random-block-allocation reproduction near the bottom of this file

import {
  SEQUENCE_IDS,
  SEQUENCES,
  getSequenceAssignment,
  buildRoundAssignments,
  buildRoundFields,
  ROUND_FIELD_KEYS,
  validateGamePlayerCount,
  setUpRoundsFromSequence,
} from "./Counterbalancing.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ── Mock scopes: implement exactly the minimal duck-typed interface real
// Empirica Game/Round/Stage Scope objects expose (game.addRound returns an
// object whose fields come only from the attributes passed into that one
// call -- mirroring the real Gate-4 SDK behavior this module works around). ──

class MockStage {
  constructor(name, duration) {
    this._attrs = new Map([["name", name], ["duration", duration]]);
  }
  get(key) { return this._attrs.get(key); }
}

class MockRound {
  constructor(id, index, attributes) {
    this.id = id;
    this._attrs = new Map([["index", index], ...Object.entries(attributes)]);
    this.stages = [];
  }
  get(key) { return this._attrs.has(key) ? this._attrs.get(key) : undefined; }
  addStage({ name, duration }) {
    const stage = new MockStage(name, duration);
    this.stages.push(stage);
    return stage;
  }
}

class MockGame {
  constructor(id, { playerCount = 3 } = {}) {
    this.id = id;
    this._attrs = new Map([["treatment", { playerCount }]]);
    this.players = Array.from({ length: playerCount }, (_, i) => ({ id: `player-${i}` }));
    this.rounds = [];
    this._nextRoundIndex = 0;
  }
  get(key) { return this._attrs.has(key) ? this._attrs.get(key) : undefined; }
  addRound(attributes) {
    const { name, ...fields } = attributes;
    const round = new MockRound(`round-${this._nextRoundIndex}`, this._nextRoundIndex, fields);
    this._nextRoundIndex += 1;
    this.rounds.push(round);
    return round;
  }
}

// ── 1. Pure sequence table correctness (S1-S4 mapping) ─────────────────────

test("S1-S4 map to the exact frozen round1/round2 facilitation+task table, with taskVersion derived correctly", () => {
  const expected = {
    S1: { round1: { facilitation: "static",   taskIndex: 0, taskVersion: "A" }, round2: { facilitation: "adaptive", taskIndex: 1, taskVersion: "B" } },
    S2: { round1: { facilitation: "static",   taskIndex: 1, taskVersion: "B" }, round2: { facilitation: "adaptive", taskIndex: 0, taskVersion: "A" } },
    S3: { round1: { facilitation: "adaptive", taskIndex: 0, taskVersion: "A" }, round2: { facilitation: "static",   taskIndex: 1, taskVersion: "B" } },
    S4: { round1: { facilitation: "adaptive", taskIndex: 1, taskVersion: "B" }, round2: { facilitation: "static",   taskIndex: 0, taskVersion: "A" } },
  };

  for (const sequenceId of SEQUENCE_IDS) {
    const rounds = buildRoundAssignments(sequenceId);
    assert.deepEqual(rounds.round1, expected[sequenceId].round1, `${sequenceId} round1`);
    assert.deepEqual(rounds.round2, expected[sequenceId].round2, `${sequenceId} round2`);
  }
});

test("every sequence has exactly one static and one adaptive Round, and both taskIndex values 0/1 appear once each", () => {
  for (const sequenceId of SEQUENCE_IDS) {
    const { round1, round2 } = buildRoundAssignments(sequenceId);
    assert.deepEqual([round1.facilitation, round2.facilitation].sort(), ["adaptive", "static"]);
    assert.deepEqual([round1.taskIndex, round2.taskIndex].sort(), [0, 1]);
  }
});

test("getSequenceAssignment / buildRoundAssignments throw on an invalid sequenceId (never fall back to a default sequence)", () => {
  assert.throws(() => getSequenceAssignment("S5"), /invalid sequenceId/);
  assert.throws(() => getSequenceAssignment(""), /invalid sequenceId/);
  assert.throws(() => getSequenceAssignment("s1"), /invalid sequenceId/); // case-sensitive
  assert.throws(() => getSequenceAssignment(undefined), /invalid sequenceId/);
  assert.throws(() => buildRoundAssignments("NOT_A_SEQUENCE"), /invalid sequenceId/);
});

test("SEQUENCES table is frozen (cannot be mutated at runtime)", () => {
  assert.throws(() => { SEQUENCES.S1.round1.facilitation = "adaptive"; });
});

// ── 2. buildRoundFields: writes exactly the lean field set ─────────────────

test("buildRoundFields returns exactly facilitation/taskIndex/taskVersion, nothing else", () => {
  const fields = buildRoundFields({ facilitation: "static", taskIndex: 0, taskVersion: "A" });
  assert.deepEqual(Object.keys(fields).sort(), ["facilitation", "taskIndex", "taskVersion"]);
  assert.deepEqual(Object.keys(fields).sort(), [...ROUND_FIELD_KEYS].sort());
  assert.equal(fields.facilitation, "static");
  assert.equal(fields.taskIndex, 0);
  assert.equal(fields.taskVersion, "A");
});

test("buildRoundFields does not include sequenceId or roundIndex (traced to have no live reader -- see Counterbalancing.mjs header comment)", () => {
  const fields = buildRoundFields({ facilitation: "adaptive", taskIndex: 1, taskVersion: "B" });
  assert.equal("sequenceId" in fields, false);
  assert.equal("roundIndex" in fields, false);
});

// ── 3. validateGamePlayerCount ───────────────────────────────────────────────

test("validateGamePlayerCount passes when players.length matches treatment.playerCount", () => {
  const game = new MockGame("g1", { playerCount: 3 });
  assert.deepEqual(validateGamePlayerCount(game), { expectedPlayerCount: 3, actualPlayerCount: 3 });
});

test("validateGamePlayerCount throws on an under/overfilled game", () => {
  const underfilled = new MockGame("g-under", { playerCount: 3 });
  underfilled.players = underfilled.players.slice(0, 2);
  assert.throws(() => validateGamePlayerCount(underfilled), /has 2 assigned player/);
});

// ── 4. setUpRoundsFromSequence: treatment.sequenceId creates exactly two
// correct Rounds (+ their six Stages), the real production callback boundary ──

const EXPECTED_STAGE_NAMES = ["transitionToIntroduction", "Introduction", "transitionToTask", "InitialDecision", "Task", "FinalDecision"];
const VALID_DURATIONS = { introDuration: 2, phase1Duration: 3, gameDuration: 10 };

for (const sequenceId of SEQUENCE_IDS) {
  test(`setUpRoundsFromSequence(${sequenceId}) creates exactly two Rounds with the correct facilitation/taskIndex/taskVersion pairing`, () => {
    const game = new MockGame(`g-${sequenceId}`);
    const result = setUpRoundsFromSequence({ game, sequenceId, stageDurations: VALID_DURATIONS });

    assert.equal(game.rounds.length, 2);
    const table = SEQUENCES[sequenceId];
    assert.equal(result.round1.get("facilitation"), table.round1.facilitation);
    assert.equal(result.round1.get("taskIndex"), table.round1.taskIndex);
    assert.equal(result.round2.get("facilitation"), table.round2.facilitation);
    assert.equal(result.round2.get("taskIndex"), table.round2.taskIndex);
    // Round ordering comes from Empirica's own native index, not a custom field.
    assert.equal(result.round1.get("index"), 0);
    assert.equal(result.round2.get("index"), 1);
    // Exactly one Static and one Adaptive Round, and the correct A/B pairing.
    assert.deepEqual([result.round1.get("facilitation"), result.round2.get("facilitation")].sort(), ["adaptive", "static"]);
    assert.deepEqual([result.round1.get("taskIndex"), result.round2.get("taskIndex")].sort(), [0, 1]);
  });
}

test("setUpRoundsFromSequence creates exactly the six expected Stages per Round, with durations from the treatment (in seconds)", () => {
  const game = new MockGame("g-stages");
  const result = setUpRoundsFromSequence({ game, sequenceId: "S1", stageDurations: VALID_DURATIONS });

  for (const round of [result.round1, result.round2]) {
    assert.deepEqual(round.stages.map((s) => s.get("name")), EXPECTED_STAGE_NAMES);
  }
  const introStage = result.round1.stages.find((s) => s.get("name") === "Introduction");
  assert.equal(introStage.get("duration"), 2 * 60);
  const taskStage = result.round1.stages.find((s) => s.get("name") === "Task");
  assert.equal(taskStage.get("duration"), 10 * 60);
});

test("setUpRoundsFromSequence throws (creates nothing) if the Game is under/overfilled -- never creates a Round for a bad player count", () => {
  const game = new MockGame("g-bad-count", { playerCount: 3 });
  game.players = game.players.slice(0, 1);
  assert.throws(() => setUpRoundsFromSequence({ game, sequenceId: "S1", stageDurations: VALID_DURATIONS }), /has 1 assigned player/);
  assert.equal(game.rounds.length, 0);
});

test("setUpRoundsFromSequence throws on an invalid sequenceId, creating no Round -- never falls back to a random/default sequence", () => {
  const game = new MockGame("g-bad-sequence");
  assert.throws(() => setUpRoundsFromSequence({ game, sequenceId: "NOT_REAL", stageDurations: VALID_DURATIONS }), /invalid sequenceId/);
  assert.equal(game.rounds.length, 0);
  const gameUndefined = new MockGame("g-undefined-sequence");
  assert.throws(() => setUpRoundsFromSequence({ game: gameUndefined, sequenceId: undefined, stageDurations: VALID_DURATIONS }), /invalid sequenceId/);
});

test("setUpRoundsFromSequence fails clearly (does not substitute a default) when a required duration is missing", () => {
  const game = new MockGame("g-missing-duration");
  assert.throws(
    () => setUpRoundsFromSequence({ game, sequenceId: "S1", stageDurations: { introDuration: 2, phase1Duration: 3 /* gameDuration missing */ } }),
    /missing or invalid required treatment duration "gameDuration"/
  );
});

test("setUpRoundsFromSequence fails clearly when a required duration is present but invalid (zero/negative/non-numeric)", () => {
  const game1 = new MockGame("g-zero-duration");
  assert.throws(() => setUpRoundsFromSequence({ game: game1, sequenceId: "S1", stageDurations: { ...VALID_DURATIONS, gameDuration: 0 } }), /missing or invalid required treatment duration "gameDuration"/);
  const game2 = new MockGame("g-nan-duration");
  assert.throws(() => setUpRoundsFromSequence({ game: game2, sequenceId: "S1", stageDurations: { ...VALID_DURATIONS, introDuration: "two" } }), /missing or invalid required treatment duration "introDuration"/);
});

// ── 5. legacy-random-logic-removed / new-wiring static checks ──────────────

// NOTE (random-block-allocation feature): callbacks.js no longer imports or
// calls Counterbalancing.mjs's setUpRoundsFromSequence at all -- it now
// performs its own randomized-block S1-S4 allocation (claimNextSequence())
// and inlines the SEQUENCES table directly, per that feature's explicit
// requirement not to use/extend Counterbalancing.mjs. Counterbalancing.mjs
// itself is unchanged and unused by production code as of this revision
// (still covered by its own unit tests above, and left in place rather than
// deleted).
test("callbacks.js no longer generates facilitationOrder/taskOrder via independent Math.random() < 0.5 coin flips, does not use the old ledger allocator, and does not import Counterbalancing.mjs", () => {
  const callbacksSource = readFileSync(path.join(__dirname, "callbacks.js"), "utf8");
  assert.doesNotMatch(callbacksSource, /Math\.random\(\)\s*<\s*0\.5\s*\?\s*\[\s*"static"/);
  assert.doesNotMatch(callbacksSource, /Math\.random\(\)\s*<\s*0\.5\s*\?\s*\[0,\s*1\]/);
  // The old ledger-backed allocator is fully gone -- neither the deprecated
  // per-Batch adapter nor the study-level ledger orchestrator is called.
  assert.doesNotMatch(callbacksSource, /resolveGameAssignment\(\{/);
  assert.doesNotMatch(callbacksSource, /setUpCounterbalancedGame\(\{/);
  assert.doesNotMatch(callbacksSource, /StudyCounterbalanceStore/);
  // Counterbalancing.mjs is not used for this feature (explicit requirement).
  assert.doesNotMatch(callbacksSource, /setUpRoundsFromSequence/);
  assert.doesNotMatch(callbacksSource, /from\s*"\.\/Counterbalancing\.mjs"/);
  // The randomized-block allocator IS wired in.
  assert.match(callbacksSource, /function claimNextSequence\(/);
  assert.match(callbacksSource, /_\.shuffle\(SEQUENCE_IDS\)/);
  assert.match(callbacksSource, /sequenceId/);
});

test("Counterbalancing.mjs contains no idempotent-recovery/conflict-check lifecycle machinery (GRAIL-native stabilization)", () => {
  const counterbalancingSource = readFileSync(path.join(__dirname, "Counterbalancing.mjs"), "utf8");
  // "game.rounds" may still appear in the header comment's historical note
  // about what was removed -- what must be absent is actual code that
  // searches/iterates it looking for an existing Round.
  assert.doesNotMatch(counterbalancingSource, /game\.rounds\.(find|map|filter|forEach)\(/, "must not search game.rounds for an existing Round");
  assert.doesNotMatch(counterbalancingSource, /pendingFields\s*=\s*\{\}/, "must not use a .set()-recording shim");
  assert.doesNotMatch(counterbalancingSource, /existingRound/, "must not have an existing-Round recovery code path");
});

test("treatment metadata cannot override the Round-level facilitation assignment: buildRoundFields's returned fields never include a treatment reference", () => {
  const counterbalancingSource = readFileSync(path.join(__dirname, "Counterbalancing.mjs"), "utf8");
  const bodyStart = counterbalancingSource.indexOf("export function buildRoundFields");
  const bodyEnd = counterbalancingSource.indexOf("\nexport function validateGamePlayerCount", bodyStart);
  const body = counterbalancingSource.slice(bodyStart, bodyEnd !== -1 ? bodyEnd : bodyStart + 600);
  assert.doesNotMatch(body, /game\.get\("treatment"\)/, "buildRoundFields must never read game.get(\"treatment\") to determine a Round's facilitation");
});

// ── Random-block S1-S4 allocation (feature lives inline in callbacks.js,
// not Counterbalancing.mjs -- per that feature's explicit requirement).
// callbacks.js cannot be imported in tests (registers real Empirica
// listeners, touches dotenv/fetch on import -- see this file's own header
// comment and RoutingIntegration.test.mjs's). This section instead:
//   (a) faithfully reproduces claimNextSequence()'s exact algorithm (same
//       shuffle-then-drain-a-block logic, same lodash _.shuffle) to
//       behaviorally verify the allocation policy itself;
//   (b) reproduces the onGameStart idempotency guard as its own small,
//       literal 3-line mirror;
//   (c) statically confirms, by reading callbacks.js's real source, that
//       the real implementation matches this shape (function name, shuffle
//       call, metadata game.set() calls, Round field wiring) -- so a
//       future edit to callbacks.js that silently diverges from this
//       reproduction has a chance of being caught.
// This is the same "reproduce the exact small guard, then also check the
// real source structurally" pattern already used in
// CallbacksAdaptiveIntegration.test.mjs for the checkpoint marker. ────────

const CALLBACKS_SEQUENCES = {
  S1: { facilitationOrder: ["static", "adaptive"], taskOrder: [0, 1] },
  S2: { facilitationOrder: ["adaptive", "static"], taskOrder: [0, 1] },
  S3: { facilitationOrder: ["static", "adaptive"], taskOrder: [1, 0] },
  S4: { facilitationOrder: ["adaptive", "static"], taskOrder: [1, 0] },
};
const CALLBACKS_SEQUENCE_IDS = Object.keys(CALLBACKS_SEQUENCES);

function makeAllocator() {
  let currentSequenceBlock = [];
  let allocationBlockId = 0;
  let nextAllocationPosition = 0;
  return function claimNextSequence() {
    if (nextAllocationPosition >= currentSequenceBlock.length) {
      currentSequenceBlock = _.shuffle(CALLBACKS_SEQUENCE_IDS);
      allocationBlockId += 1;
      nextAllocationPosition = 0;
    }
    const sequenceId = currentSequenceBlock[nextAllocationPosition];
    nextAllocationPosition += 1;
    return { sequenceId, allocationBlockId, allocationPosition: nextAllocationPosition, blockOrder: [...currentSequenceBlock] };
  };
}

test("claimNextSequence: one block -- 4 consecutive claims are exactly {S1,S2,S3,S4} once each, in some order", () => {
  const claimNextSequence = makeAllocator();
  const claims = [1, 2, 3, 4].map(() => claimNextSequence());
  assert.deepEqual(claims.map((c) => c.sequenceId).sort(), ["S1", "S2", "S3", "S4"]);
  assert.deepEqual(claims.map((c) => c.allocationPosition), [1, 2, 3, 4]);
  assert.ok(claims.every((c) => c.allocationBlockId === claims[0].allocationBlockId), "all 4 claims in one block share the same allocationBlockId");
});

test("claimNextSequence: two blocks -- 8 consecutive claims split into two balanced blocks with distinct block IDs and positions 1-4 each", () => {
  const claimNextSequence = makeAllocator();
  const claims = Array.from({ length: 8 }, () => claimNextSequence());
  const block1 = claims.slice(0, 4);
  const block2 = claims.slice(4, 8);
  assert.deepEqual(block1.map((c) => c.sequenceId).sort(), ["S1", "S2", "S3", "S4"], "claims 1-4 contain S1-S4 exactly once");
  assert.deepEqual(block2.map((c) => c.sequenceId).sort(), ["S1", "S2", "S3", "S4"], "claims 5-8 contain S1-S4 exactly once");
  assert.deepEqual(block1.map((c) => c.allocationPosition), [1, 2, 3, 4]);
  assert.deepEqual(block2.map((c) => c.allocationPosition), [1, 2, 3, 4]);
  assert.notEqual(block1[0].allocationBlockId, block2[0].allocationBlockId, "the two blocks have different allocationBlockId values");
  // Deliberately NOT asserting block1's order differs from block2's order --
  // two independent shuffles can coincidentally produce the same permutation.
});

test("claimNextSequence: a 5th claim starts a brand-new (3rd) block, only after the first block of 4 is fully drained", () => {
  const claimNextSequence = makeAllocator();
  const firstBlock = Array.from({ length: 4 }, () => claimNextSequence());
  const fifth = claimNextSequence();
  assert.equal(fifth.allocationPosition, 1, "the 5th claim is position 1 of a new block");
  assert.notEqual(fifth.allocationBlockId, firstBlock[0].allocationBlockId);
});

test("Game idempotency: reusing an already-assigned sequenceId does not claim a new slot or advance the block", () => {
  // Mirrors the onGameStart guard exactly:
  //   let sequenceId = game.get("sequenceId");
  //   if (!sequenceId) { const claim = claimNextSequence(); ...game.set(...) }
  const claimNextSequence = makeAllocator();
  const mockGame = new Map();

  function simulateOnGameStart(game) {
    let sequenceId = game.get("sequenceId");
    if (!sequenceId) {
      const claim = claimNextSequence();
      sequenceId = claim.sequenceId;
      game.set("sequenceId", claim.sequenceId);
      game.set("allocationBlockId", claim.allocationBlockId);
      game.set("allocationPosition", claim.allocationPosition);
    }
    return sequenceId;
  }

  const first = simulateOnGameStart(mockGame);
  const secondGameSequenceId = simulateOnGameStart(mockGame); // simulates onGameStart firing again for the SAME Game
  assert.equal(secondGameSequenceId, first, "sequenceId must not change on a repeated call for the same Game");

  // A separate, third Game claims the block's 2nd position -- proving the
  // repeated call above did not consume an extra slot.
  const otherGameClaim = claimNextSequence();
  assert.equal(otherGameClaim.allocationPosition, 2, "the next NEW Game gets position 2, not 3 -- the repeated call for the first Game consumed nothing");
});

test("S1-S4 Round mapping matches the required table exactly (Round1/Round2 facilitation+taskIndex)", () => {
  const expected = {
    S1: { round1: { facilitation: "static", taskIndex: 0 }, round2: { facilitation: "adaptive", taskIndex: 1 } },
    S2: { round1: { facilitation: "adaptive", taskIndex: 0 }, round2: { facilitation: "static", taskIndex: 1 } },
    S3: { round1: { facilitation: "static", taskIndex: 1 }, round2: { facilitation: "adaptive", taskIndex: 0 } },
    S4: { round1: { facilitation: "adaptive", taskIndex: 1 }, round2: { facilitation: "static", taskIndex: 0 } },
  };
  for (const sequenceId of CALLBACKS_SEQUENCE_IDS) {
    const s = CALLBACKS_SEQUENCES[sequenceId];
    const round1 = { facilitation: s.facilitationOrder[0], taskIndex: s.taskOrder[0] };
    const round2 = { facilitation: s.facilitationOrder[1], taskIndex: s.taskOrder[1] };
    assert.deepEqual(round1, expected[sequenceId].round1, `${sequenceId} round1`);
    assert.deepEqual(round2, expected[sequenceId].round2, `${sequenceId} round2`);
  }
});

test("callbacks.js source: SEQUENCES table matches the required mapping, and Round creation wires facilitationOrder/taskOrder into round1/round2 without swapping", () => {
  const callbacksSource = readFileSync(path.join(__dirname, "callbacks.js"), "utf8");
  assert.match(callbacksSource, /S1:\s*\{\s*\n\s*facilitationOrder:\s*\["static",\s*"adaptive"\],\s*\n\s*taskOrder:\s*\[0,\s*1\],/);
  assert.match(callbacksSource, /S2:\s*\{\s*\n\s*facilitationOrder:\s*\["adaptive",\s*"static"\],\s*\n\s*taskOrder:\s*\[0,\s*1\],/);
  assert.match(callbacksSource, /S3:\s*\{\s*\n\s*facilitationOrder:\s*\["static",\s*"adaptive"\],\s*\n\s*taskOrder:\s*\[1,\s*0\],/);
  assert.match(callbacksSource, /S4:\s*\{\s*\n\s*facilitationOrder:\s*\["adaptive",\s*"static"\],\s*\n\s*taskOrder:\s*\[1,\s*0\],/);
  // round2's fields come from index [1] of the arrays, and are applied to
  // round2 (not round1 a second time -- the exact bug this feature's own
  // spec calls out).
  const round2Block = callbacksSource.slice(callbacksSource.indexOf('const round2 = game.addRound('), callbacksSource.indexOf('round2.addStage({ name: "transitionToIntroduction"'));
  assert.match(round2Block, /facilitation:\s*sequence\.facilitationOrder\[1\]/);
  assert.match(round2Block, /taskIndex:\s*sequence\.taskOrder\[1\]/);
});

test("callbacks.js source: every Game saves sequenceId, allocationBlockId, allocationPosition, and allocationBlockOrder metadata", () => {
  const callbacksSource = readFileSync(path.join(__dirname, "callbacks.js"), "utf8");
  assert.match(callbacksSource, /game\.set\("sequenceId",\s*claim\.sequenceId\)/);
  assert.match(callbacksSource, /game\.set\("allocationBlockId",\s*claim\.allocationBlockId\)/);
  assert.match(callbacksSource, /game\.set\("allocationPosition",\s*claim\.allocationPosition\)/);
  assert.match(callbacksSource, /game\.set\("allocationBlockOrder",/);
});

test("callbacks.js source: onGameStart checks game.get(\"sequenceId\") before claiming, so a re-invocation for the same Game cannot claim a second slot", () => {
  const callbacksSource = readFileSync(path.join(__dirname, "callbacks.js"), "utf8");
  const onGameStartStart = callbacksSource.indexOf("Empirica.onGameStart(");
  const onGameStartBody = callbacksSource.slice(onGameStartStart, callbacksSource.indexOf("// ── onRoundStart", onGameStartStart));
  const idempotencyCheckIndex = onGameStartBody.indexOf('game.get("sequenceId")');
  const claimCallIndex = onGameStartBody.indexOf("claimNextSequence()");
  assert.ok(idempotencyCheckIndex !== -1 && claimCallIndex !== -1 && idempotencyCheckIndex < claimCallIndex, "the sequenceId check must precede the claim call");
  assert.match(onGameStartBody, /if\s*\(!sequenceId\)\s*\{/, "claiming must be gated by an if(!sequenceId) check");
});

test("callbacks.js source: facilitationOrder/taskOrder game attributes are still saved (not removed without checking for other consumers)", () => {
  const callbacksSource = readFileSync(path.join(__dirname, "callbacks.js"), "utf8");
  assert.match(callbacksSource, /game\.set\("facilitationOrder",\s*sequence\.facilitationOrder\)/);
  assert.match(callbacksSource, /game\.set\("taskOrder",\s*sequence\.taskOrder\)/);
});
