// CheckpointManager.test.mjs
//
// Phase 3 tests for the unified Checkpoint Manager. Covers:
//   - v2 design invariant: failed checkpoints do NOT consume opportunity
//   - cooldown / cap / dedup / time floor / stage guard
//   - the 6-human-message opportunity gate
//   - Static and Adaptive share the same trigger conditions
//   - recordPublish resets opportunity + appends to interventionHistory
//
// Uses an in-memory `store` fake with .get/.set -- no Empirica, no I/O.

import assert from "node:assert/strict";
import test from "node:test";

import {
  CHECKPOINT_DEFAULTS,
  emptyCheckpointState,
  readCheckpointState,
  shouldEvaluateCheckpoint,
  recordAttempt,
  recordPublish,
  recordParticipantRequest,
  recordParticipantRequestedPublish,
  resetRoundState,
  containsFacilitatorMention,
  FACILITATOR_MENTION_MARKER,
} from "./CheckpointManager.mjs";

function makeStore(initial = {}) {
  const data = { ...initial };
  return {
    get: (k) => (k in data ? data[k] : undefined),
    set: (k, v) => { data[k] = v; },
    _data: data,
  };
}

const NOW = 1_700_000_000_000;
const T_DEFAULTS = CHECKPOINT_DEFAULTS;

function baseArgs(overrides = {}) {
  return {
    store: makeStore(),
    humanMessageCount: T_DEFAULTS.messagesBetweenInterventions,
    currentStageName: "Task",
    remainingTimeMs: 60_000,
    chatKeyPresent: true,
    now: NOW,
    ...overrides,
  };
}

// ── emptyCheckpointState / readCheckpointState ─────────────────────────────

test("emptyCheckpointState has the expected default field shape", () => {
  const s = emptyCheckpointState();
  assert.equal(s.humanMessageCount, 0);
  assert.equal(s.messagesSinceLastPublish, 0);
  assert.equal(s.attemptedThisRound, 0);
  assert.equal(s.publishedThisRound, 0);
  assert.equal(s.lastRole, null);
  assert.equal(s.lastCheckedFactors, null);
  assert.equal(s.synthesiserFired, false);
  assert.deepEqual(s.interventionHistory, []);
  assert.equal(s.postInterventionUptake, 0);
  assert.equal(s.unresolvedNeed, null);
  assert.equal(s.lastAttemptTimestamp, 0);
  assert.equal(s.lastHandledCheckpoint, 0);
});

test("readCheckpointState fills missing keys with defaults (no undefined leakage)", () => {
  const store = makeStore({ humanMessageCount: 5 });  // other keys absent
  const s = readCheckpointState(store);
  assert.equal(s.humanMessageCount, 5);
  assert.equal(s.messagesSinceLastPublish, 0);
  assert.equal(s.attemptedThisRound, 0);
});

// ── shouldEvaluateCheckpoint: stage / chat / time floor ────────────────────

test("trigger = false when chat is not present yet", () => {
  const r = shouldEvaluateCheckpoint(baseArgs({ chatKeyPresent: false }));
  assert.equal(r.trigger, false);
  assert.equal(r.reason, "chat_key_not_present");
});

test("trigger = false when current stage is not 'Task' (TLX, Survey, Quiz, ...)", () => {
  for (const stage of ["Introduction", "Walkthrough", "TLX", "SubjectiveSurvey", "FinalDecision", "ReviewQuiz"]) {
    const r = shouldEvaluateCheckpoint(baseArgs({ currentStageName: stage }));
    assert.equal(r.trigger, false, `expected false for stage ${stage}`);
    assert.match(r.reason, /stage_not_task/);
  }
});

test("trigger = false when remaining time is at or below the floor", () => {
  const r1 = shouldEvaluateCheckpoint(baseArgs({ remainingTimeMs: T_DEFAULTS.minTimeForInterventionMs }));
  assert.equal(r1.trigger, false);
  assert.match(r1.reason, /time_floor/);
  const r2 = shouldEvaluateCheckpoint(baseArgs({ remainingTimeMs: T_DEFAULTS.minTimeForInterventionMs - 1 }));
  assert.equal(r2.trigger, false);
  const r3 = shouldEvaluateCheckpoint(baseArgs({ remainingTimeMs: 0 }));
  assert.equal(r3.trigger, false);
});

// ── shouldEvaluateCheckpoint: opportunity gate ─────────────────────────────

test("trigger = false when fewer than 6 new human messages since the last publish", () => {
  const r = shouldEvaluateCheckpoint(baseArgs({ humanMessageCount: 5 }));
  assert.equal(r.trigger, false);
  assert.match(r.reason, /opportunity_gate/);
});

test("trigger = true exactly at 6th human message since the last publish", () => {
  // handleChat increments messagesSinceLastPublish BEFORE calling
  // shouldEvaluateCheckpoint, so the state at the 6th message has
  // counter == 6. The trigger fires when 6 >= 6.
  const store = makeStore({ messagesSinceLastPublish: 6 });
  const r = shouldEvaluateCheckpoint({ ...baseArgs({ store, humanMessageCount: 6 }), store });
  assert.equal(r.trigger, true, `expected true; reason was ${r.reason}`);
  assert.equal(r.reason, "ok");
});

// ── shouldEvaluateCheckpoint: cap ──────────────────────────────────────────

test("trigger = false when intervention cap has been reached", () => {
  const store = makeStore({
    attemptedThisRound: T_DEFAULTS.interventionCapPerRound,
    messagesSinceLastPublish: T_DEFAULTS.messagesBetweenInterventions,
  });
  const r = shouldEvaluateCheckpoint({ ...baseArgs({ store }), store });
  assert.equal(r.trigger, false);
  assert.match(r.reason, /cap_reached/);
});

test("cap counts attempts (success or fail), not just publishes", () => {
  // 3 attempts (cap); a 4th message that meets the 6-human gate must NOT trigger.
  const store = makeStore({
    attemptedThisRound: 3,
    messagesSinceLastPublish: 12,  // well past the 6-message gate
  });
  const r = shouldEvaluateCheckpoint({ ...baseArgs({ store, humanMessageCount: 12 }), store });
  assert.equal(r.trigger, false);
  assert.match(r.reason, /cap_reached/);
});

// ── shouldEvaluateCheckpoint: cooldown ─────────────────────────────────────

test("trigger = false within cooldown window after the last attempt", () => {
  const store = makeStore({
    lastAttemptTimestamp: NOW - (T_DEFAULTS.cooldownMs - 1000),  // 1s before cooldown ends
    messagesSinceLastPublish: T_DEFAULTS.messagesBetweenInterventions,
  });
  const r = shouldEvaluateCheckpoint({ ...baseArgs({ store }), store });
  assert.equal(r.trigger, false);
  assert.match(r.reason, /cooldown/);
});

test("trigger = true once cooldown window has fully elapsed", () => {
  const store = makeStore({
    lastAttemptTimestamp: NOW - T_DEFAULTS.cooldownMs,  // exactly cooldown ago
    messagesSinceLastPublish: T_DEFAULTS.messagesBetweenInterventions,
  });
  const r = shouldEvaluateCheckpoint({ ...baseArgs({ store }), store });
  assert.equal(r.trigger, true, `expected true; reason was ${r.reason}`);
});

// ── shouldEvaluateCheckpoint: dedup ────────────────────────────────────────

test("trigger = false on duplicate event for the same humanMessageCount (dedup)", () => {
  const store = makeStore({
    messagesSinceLastPublish: T_DEFAULTS.messagesBetweenInterventions,
    lastHandledCheckpoint: 6,
  });
  const r = shouldEvaluateCheckpoint({ ...baseArgs({ store, humanMessageCount: 6 }), store });
  assert.equal(r.trigger, false);
  assert.match(r.reason, /dedup/);
});

// ── shouldEvaluateCheckpoint: evaluation is side-effect free ───────────────

test("shouldEvaluateCheckpoint does NOT mutate the store (pure check)", () => {
  const store = makeStore({
    attemptedThisRound: 1,
    messagesSinceLastPublish: T_DEFAULTS.messagesBetweenInterventions,
  });
  const before = JSON.stringify(store._data);
  shouldEvaluateCheckpoint({ ...baseArgs({ store, humanMessageCount: 6 }), store });
  const after = JSON.stringify(store._data);
  assert.equal(before, after, "store must not change after shouldEvaluateCheckpoint");
});

// ── recordAttempt / recordPublish / resetRoundState ────────────────────────

test("recordAttempt increments attemptedThisRound, sets lastAttemptTimestamp + lastHandledCheckpoint", () => {
  const store = makeStore();
  recordAttempt(store, 6, NOW);
  const s = readCheckpointState(store);
  assert.equal(s.attemptedThisRound, 1);
  assert.equal(s.lastAttemptTimestamp, NOW);
  assert.equal(s.lastHandledCheckpoint, 6);
});

test("recordAttempt does NOT reset messagesSinceLastPublish (Q3 v2 design: failed attempt must not consume opportunity)", () => {
  const store = makeStore({ messagesSinceLastPublish: 6 });
  recordAttempt(store, 6, NOW);
  const s = readCheckpointState(store);
  assert.equal(s.messagesSinceLastPublish, 6, "messagesSinceLastPublish must NOT reset on a failed attempt");
});

test("recordPublish resets messagesSinceLastPublish, increments publishedThisRound, appends to interventionHistory", () => {
  const store = makeStore({ messagesSinceLastPublish: 6, publishedThisRound: 0, interventionHistory: [] });
  recordPublish(store, { role: "STATIC", messageId: "m-fake", now: NOW });
  const s = readCheckpointState(store);
  assert.equal(s.messagesSinceLastPublish, 0);
  assert.equal(s.publishedThisRound, 1);
  assert.equal(s.lastRole, "STATIC");
  assert.equal(s.interventionHistory.length, 1);
  assert.equal(s.interventionHistory[0].role, "STATIC");
  assert.equal(s.interventionHistory[0].timestamp, NOW);
});

test("recordPublish with role='synthesiser' sets synthesiserFired=true", () => {
  const store = makeStore();
  recordPublish(store, { role: "INFORMATION_SYNTHESISER", messageId: "m1", now: NOW });
  const s = readCheckpointState(store);
  assert.equal(s.synthesiserFired, true);
});

test("recordPublish with role != 'synthesiser' does not set synthesiserFired", () => {
  const store = makeStore();
  recordPublish(store, { role: "INFORMATION_EXPANDER", messageId: "m1", now: NOW });
  const s = readCheckpointState(store);
  assert.equal(s.synthesiserFired, false);
});

test("recordParticipantRequest deduplicates without consuming automatic attempt budget", () => {
  const store = makeStore({ attemptedThisRound: 2, lastAttemptTimestamp: NOW - 5_000 });
  recordParticipantRequest(store, 9);
  const state = readCheckpointState(store);
  assert.equal(state.lastHandledCheckpoint, 9);
  assert.equal(state.attemptedThisRound, 2);
  assert.equal(state.lastAttemptTimestamp, NOW - 5_000);
});

test("recordParticipantRequestedPublish does not change automatic opportunity or controller state", () => {
  const store = makeStore({ messagesSinceLastPublish: 4, publishedThisRound: 2, lastRole: "challenger" });
  recordParticipantRequestedPublish(store, { role: "REQUESTED_GENERALIST", messageId: "request-1", now: NOW });
  const state = readCheckpointState(store);
  assert.equal(state.messagesSinceLastPublish, 4);
  assert.equal(state.publishedThisRound, 2);
  assert.equal(state.lastRole, "challenger");
  assert.equal(state.interventionHistory[0].participantRequested, true);
});

test("resetRoundState wipes all per-round state to defaults", () => {
  const store = makeStore({
    humanMessageCount: 12,
    messagesSinceLastPublish: 3,
    attemptedThisRound: 2,
    publishedThisRound: 1,
    lastAttemptTimestamp: NOW,
    lastHandledCheckpoint: 12,
    lastRole: "INFORMATION_EXPANDER",
    synthesiserFired: true,
    interventionHistory: [{ role: "INFORMATION_EXPANDER", messageId: "m1" }],
    postInterventionUptake: 2,
    unresolvedNeed: "negotiate option B",
  });
  resetRoundState(store);
  const s = readCheckpointState(store);
  assert.equal(s.humanMessageCount, 0);
  assert.equal(s.messagesSinceLastPublish, 0);
  assert.equal(s.attemptedThisRound, 0);
  assert.equal(s.publishedThisRound, 0);
  assert.equal(s.lastAttemptTimestamp, 0);
  assert.equal(s.lastHandledCheckpoint, 0);
  assert.equal(s.lastRole, null);
  assert.equal(s.synthesiserFired, false);
  assert.equal(s.interventionHistory.length, 0);
  assert.equal(s.postInterventionUptake, 0);
  assert.equal(s.unresolvedNeed, null);
});

// ── v2 design invariants: Static and Adaptive share trigger conditions ─────

test("Static and Adaptive have identical trigger conditions (the manager has no condition field)", () => {
  // Same inputs -> same trigger. The post-trigger pipeline is what
  // differs between Static and Adaptive (Static goes straight to
  // Static AI bundle; Adaptive runs feature extraction + Assessor +
  // Controller). The trigger itself must be identical so the two
  // conditions see the same number of opportunities.
  const args = baseArgs({ humanMessageCount: 6, store: makeStore({ messagesSinceLastPublish: 6 }) });
  const r1 = shouldEvaluateCheckpoint(args);
  const r2 = shouldEvaluateCheckpoint({ ...args, store: makeStore({ messagesSinceLastPublish: 6 }) });
  assert.equal(r1.trigger, true);
  assert.equal(r2.trigger, true);
  assert.equal(r1.reason, r2.reason);
});

// ── Minimal-pair test: failure-doesn't-consume-opportunity (Q3) ──────────

test("Q3 invariant: a failed attempt does not consume the participant's next opportunity", () => {
  // Sequence:
  //   1. 6th human message arrives -> messagesSinceLastPublish becomes 6
  //      (handleChat increments before calling shouldEvaluateCheckpoint).
  //      The attempt fires, FAILS (no reset of messagesSinceLastPublish).
  //   2. Messages 7-12 arrive, messagesSinceLastPublish advances to 12.
  //   3. The 12th message triggers a second attempt (opportunity gate
  //      not blocked by the prior failure).
  const store = makeStore();
  // Step 1a: 6th message, counter increments to 6, trigger fires.
  // handleChat does this BEFORE calling shouldEvaluateCheckpoint, so
  // the store has messagesSinceLastPublish=6 by the time we ask.
  store.set("messagesSinceLastPublish", 6);
  const r1 = shouldEvaluateCheckpoint({ ...baseArgs({ store, humanMessageCount: 6 }), store });
  assert.equal(r1.trigger, true);
  recordAttempt(store, 6, NOW);
  // Step 1b: failure does not reset messagesSinceLastPublish. (Q3.)
  assert.equal(readCheckpointState(store).messagesSinceLastPublish, 6,
    "messagesSinceLastPublish must NOT reset on a failed attempt");
  // Step 2: 12th message arrives; controller advances counter to 12.
  store.set("messagesSinceLastPublish", 12);
  const t2 = NOW + T_DEFAULTS.cooldownMs + 1_000;
  const r2 = shouldEvaluateCheckpoint({ ...baseArgs({ store, humanMessageCount: 12, now: t2 }), store });
  // The 6-message gate is satisfied (12 >= 6), cap is 1/3, cooldown ok.
  // The attempt can fire.
  assert.equal(r2.trigger, true, `expected second attempt to fire; reason was ${r2.reason}`);
});

// ── v2 design invariant: failed attempt counts against the cap ─────────────

test("intervention cap is on attempts (success or fail), not just publishes", () => {
  // 3 failed attempts -> 4th message that meets the opportunity gate
  // must NOT trigger.
  const store = makeStore({
    attemptedThisRound: 3,
    messagesSinceLastPublish: 12,
  });
  const r = shouldEvaluateCheckpoint({ ...baseArgs({ store, humanMessageCount: 12 }), store });
  assert.equal(r.trigger, false);
  assert.match(r.reason, /cap_reached/);
});

// ── Phase 6.4 (Q8 = "即时"): @-Facilitator mention bypasses pacing gates ───

test("containsFacilitatorMention: matches the canonical client-side marker", () => {
  // The marker is the literal substring the react-mentions UI emits
  // (client/src/components/CustomChat.jsx, `markup="@[__display__]"`).
  assert.equal(containsFacilitatorMention("Hello @[Facilitator] can you summarise?"), true);
  // Case-insensitive on the display name.
  assert.equal(containsFacilitatorMention("hello @[facilitator] hi"), true);
  assert.equal(containsFacilitatorMention("hello @[FACILITATOR] hi"), true);
  // No false positives on near-misses.
  assert.equal(containsFacilitatorMention("Hello everyone"), false);
  assert.equal(containsFacilitatorMention("I disagree with Facilitator's last point"), false);
  assert.equal(containsFacilitatorMention("@Facilitator without brackets"), false);
  // Defensive: non-strings, empty string.
  assert.equal(containsFacilitatorMention(""), false);
  assert.equal(containsFacilitatorMention(null), false);
  assert.equal(containsFacilitatorMention(undefined), false);
  assert.equal(containsFacilitatorMention(42), false);
});

test("FACILITATOR_MENTION_MARKER: is the single source of truth shared with the client", () => {
  // The client uses `@[__display__]` markup, so the marker must include
  // the literal "[Facilitator]" inside. Locking this down so any future
  // rename forces a test update.
  assert.equal(FACILITATOR_MENTION_MARKER, "@[Facilitator]");
});

test("isMentionCheckpoint=true: bypasses the opportunity gate (would normally fail)", () => {
  // 1st human message, no publish yet -> opportunity gate would say
  // "1 < 6, no trigger". With mention, the gate is bypassed.
  const store = makeStore({ messagesSinceLastPublish: 1 });
  const r = shouldEvaluateCheckpoint({
    ...baseArgs({ store, humanMessageCount: 1 }),
    store,
    isMentionCheckpoint: true,
  });
  assert.equal(r.trigger, true, `expected mention to bypass opportunity gate; reason was ${r.reason}`);
  assert.equal(r.reason, "participant_request");
});

test("isMentionCheckpoint=true: bypasses the cooldown (would normally fail)", () => {
  // Last attempt was 1ms ago -> cooldown would block.
  const store = makeStore({
    lastAttemptTimestamp: NOW - 1,
    messagesSinceLastPublish: 6,
  });
  const r = shouldEvaluateCheckpoint({
    ...baseArgs({ store, humanMessageCount: 6, now: NOW }),
    store,
    isMentionCheckpoint: true,
  });
  assert.equal(r.trigger, true, `expected mention to bypass cooldown; reason was ${r.reason}`);
  assert.equal(r.reason, "participant_request");
});

test("isMentionCheckpoint=true: retains per-message dedup", () => {
  const store = makeStore({ lastHandledCheckpoint: 5, messagesSinceLastPublish: 6 });
  const r = shouldEvaluateCheckpoint({
    ...baseArgs({ store, humanMessageCount: 5 }),
    store,
    isMentionCheckpoint: true,
  });
  assert.equal(r.trigger, false);
  assert.match(r.reason, /dedup/);
});

test("isMentionCheckpoint=true: bypasses the automatic intervention cap", () => {
  const store = makeStore({
    attemptedThisRound: 3,
    messagesSinceLastPublish: 1,
  });
  const r = shouldEvaluateCheckpoint({
    ...baseArgs({ store, humanMessageCount: 1 }),
    store,
    isMentionCheckpoint: true,
  });
  assert.equal(r.trigger, true);
  assert.equal(r.reason, "participant_request");
});

test("isMentionCheckpoint=true: STILL respects the Task stage guard", () => {
  // Mention during TLX -> still no trigger.
  const r = shouldEvaluateCheckpoint({
    ...baseArgs({ currentStageName: "TLX" }),
    isMentionCheckpoint: true,
  });
  assert.equal(r.trigger, false);
  assert.match(r.reason, /stage_not_task/);
});

test("isMentionCheckpoint=true: bypasses the automatic time-floor", () => {
  const r = shouldEvaluateCheckpoint({
    ...baseArgs({ remainingTimeMs: 5_000 }),
    isMentionCheckpoint: true,
  });
  assert.equal(r.trigger, true);
  assert.equal(r.reason, "participant_request");
});

test("isMentionCheckpoint=true: STILL respects chat_key_present", () => {
  const r = shouldEvaluateCheckpoint({
    ...baseArgs({ chatKeyPresent: false }),
    isMentionCheckpoint: true,
  });
  assert.equal(r.trigger, false);
  assert.equal(r.reason, "chat_key_not_present");
});

test("isMentionCheckpoint=false (default): behaves exactly as before the Phase 6.4 change", () => {
  // Sanity: a normal call with the default flag must produce the
  // existing paced behaviour, not the mention-bypass path.
  const store = makeStore({ messagesSinceLastPublish: 1 });
  const r = shouldEvaluateCheckpoint({ ...baseArgs({ store, humanMessageCount: 1 }), store });
  assert.equal(r.trigger, false);
  assert.match(r.reason, /opportunity_gate/);
});
