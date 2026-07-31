/**
 * Counterbalancing.mjs
 *
 * GRAIL-native stabilization revision: a small sequence-mapping + Round-
 * creation helper module, not a lifecycle framework. Empirica's own
 * treatment mechanism (`.empirica/treatments.yaml`'s four `sequence-S1`..
 * `sequence-S4` treatments) decides which sequence a Game gets -- this
 * module only maps that sequenceId to the two Round assignments and
 * creates the Rounds/Stages using the standard Empirica pattern
 * (`game.addRound({...})` then `round.addStage({...})`), once, in
 * `onGameStart`.
 *
 * Removed in this revision (present in an earlier scope-reduction pass,
 * confirmed to have no live consumer -- see the stabilization audit):
 *   - searching game.rounds for an already-existing Round and idempotently
 *     recovering/backfilling it;
 *   - field-by-field conflict comparison against an existing Round;
 *   - the pendingFields .set()-recording shim (only needed to feed that
 *     recovery path);
 *   - resolveStagesForRound's idempotent missing-Stage backfill;
 *   - the custom `sequenceId`/`roundIndex` Round-level fields (traced: read
 *     back nowhere in production code -- `sequenceId` already lives on
 *     `game.get("treatment").sequenceId`, and Empirica's own
 *     `round.get("index")` already provides Round ordering; every place
 *     that previously might have read the custom fields reads the native
 *     ones instead).
 * None of that machinery has a live caller: `onGameStart` runs exactly
 * once per Game in the real Empirica lifecycle, so idempotent recovery for
 * a repeated invocation was speculative, untriggered complexity.
 *
 * Preserved: the frozen S1-S4 sequence table (the actual within-subject
 * counterbalancing design), and the critical Empirica SDK correctness fact
 * this module still works around -- `game.addRound(attributes)` does NOT
 * return a live Round scope instance; a `round.set()` call made AFTER
 * `game.addRound()` returns is silently lost (confirmed against a real
 * running Empirica backend, not assumed from source alone;
 * @empirica/core@1.12.0, chunk-CA6WWEPS.js). A Round's full field set is
 * therefore still computed BEFORE `game.addRound()` and passed directly
 * into that one call -- this is exactly the bug the pre-refactor codebase
 * hit once already (Round 2's taskIndex silently staying undefined), and
 * removing the recovery machinery above does not reopen it.
 *
 * Data contract:
 *   - facilitation: "static" / "adaptive" -- required experimental field.
 *   - taskIndex: 0 / 1 (server/src/HPTConfig.json's `tasks` array) --
 *     required experimental field, read by callbacks.js's onRoundStart.
 *   - taskVersion: "A" / "B", derived as `taskIndex === 0 ? "A" : "B"` --
 *     retained because it is read live by the client
 *     (FinalDecision.jsx / InitialDecision.jsx), not merely descriptive.
 */

// ── Fixed sequence table (per the frozen 2x2 within-subject design) ────────
export const SEQUENCE_IDS = ["S1", "S2", "S3", "S4"];

// conditionOrder/taskOrder/taskOrderCode/facilitationOrder are pure,
// static, descriptive facts about each sequence (not lifecycle state --
// nothing here is allocated, mutated, or persisted onto any Game/Round).
// They are NOT written onto Game/Round objects; they exist only so callers
// (tests, analysis scripts) can introspect the sequence structure without
// re-deriving it from round1/round2.
export const SEQUENCES = Object.freeze({
  S1: Object.freeze({
    round1: Object.freeze({ facilitation: "static", taskIndex: 0 }),
    round2: Object.freeze({ facilitation: "adaptive", taskIndex: 1 }),
    conditionOrder: "SA",
    taskOrder: Object.freeze([0, 1]),
    taskOrderCode: "AB",
    facilitationOrder: Object.freeze(["static", "adaptive"]),
  }),
  S2: Object.freeze({
    round1: Object.freeze({ facilitation: "static", taskIndex: 1 }),
    round2: Object.freeze({ facilitation: "adaptive", taskIndex: 0 }),
    conditionOrder: "SA",
    taskOrder: Object.freeze([1, 0]),
    taskOrderCode: "BA",
    facilitationOrder: Object.freeze(["static", "adaptive"]),
  }),
  S3: Object.freeze({
    round1: Object.freeze({ facilitation: "adaptive", taskIndex: 0 }),
    round2: Object.freeze({ facilitation: "static", taskIndex: 1 }),
    conditionOrder: "AS",
    taskOrder: Object.freeze([0, 1]),
    taskOrderCode: "AB",
    facilitationOrder: Object.freeze(["adaptive", "static"]),
  }),
  S4: Object.freeze({
    round1: Object.freeze({ facilitation: "adaptive", taskIndex: 1 }),
    round2: Object.freeze({ facilitation: "static", taskIndex: 0 }),
    conditionOrder: "AS",
    taskOrder: Object.freeze([1, 0]),
    taskOrderCode: "BA",
    facilitationOrder: Object.freeze(["adaptive", "static"]),
  }),
});

function taskIndexToVersion(taskIndex) {
  return taskIndex === 0 ? "A" : "B";
}

/** Fails loudly (never falls back to a random/default sequence). */
export function getSequenceAssignment(sequenceId) {
  const entry = SEQUENCES[sequenceId];
  if (!entry) {
    throw new Error(
      `Counterbalancing: invalid sequenceId ${JSON.stringify(sequenceId)}. Must be one of ${SEQUENCE_IDS.join(", ")}.`
    );
  }
  return entry;
}

/** Per-round facilitation/taskIndex/taskVersion for a given sequenceId. */
export function buildRoundAssignments(sequenceId) {
  const { round1, round2 } = getSequenceAssignment(sequenceId);
  return {
    round1: { facilitation: round1.facilitation, taskIndex: round1.taskIndex, taskVersion: taskIndexToVersion(round1.taskIndex) },
    round2: { facilitation: round2.facilitation, taskIndex: round2.taskIndex, taskVersion: taskIndexToVersion(round2.taskIndex) },
  };
}

// The only Round-level fields this module persists. Deliberately does NOT
// include sequenceId/roundIndex -- traced (see this file's header comment)
// to have no live reader; sequenceId already lives on
// `game.get("treatment").sequenceId`, and Round ordering is already
// Empirica's own `round.get("index")`.
export const ROUND_FIELD_KEYS = ["facilitation", "taskIndex", "taskVersion"];

/**
 * Pure: the Round attributes for one round assignment, in the exact shape
 * `game.addRound({ name, ...fields })` needs. Returns a plain object --
 * does not touch any Empirica/mock object -- because those fields must be
 * passed directly INTO `game.addRound()`'s one construction call (see this
 * file's header comment on why `round.set()` after the fact is unsafe).
 */
export function buildRoundFields(roundAssignment) {
  const values = {
    facilitation: roundAssignment.facilitation,
    taskIndex: roundAssignment.taskIndex,
    taskVersion: roundAssignment.taskVersion,
  };
  for (const key of Object.keys(values)) {
    if (!ROUND_FIELD_KEYS.includes(key)) delete values[key];
  }
  return values;
}

export function validateGamePlayerCount(game) {
  const treatment = (typeof game.get === "function" && game.get("treatment")) || {};
  const expectedPlayerCount = treatment.playerCount;
  if (!Number.isInteger(expectedPlayerCount) || expectedPlayerCount <= 0) {
    throw new Error(
      `Counterbalancing: game ${game.id} has an invalid/missing treatment.playerCount (${JSON.stringify(expectedPlayerCount)}).`
    );
  }
  const players = Array.isArray(game.players) ? game.players : [];
  const actualPlayerCount = players.length;
  if (actualPlayerCount !== expectedPlayerCount) {
    throw new Error(
      `Counterbalancing: game ${game.id} has ${actualPlayerCount} assigned player(s), but its treatment requires exactly ${expectedPlayerCount} -- refusing to create any Round for an underfilled/overfilled game.`
    );
  }
  return { expectedPlayerCount, actualPlayerCount };
}

const ROUND_STAGE_PLAN = [
  { name: "transitionToIntroduction", duration: 10, durationKey: null },
  { name: "Introduction", duration: null, durationKey: "introDuration" },
  { name: "transitionToTask", duration: 10, durationKey: null },
  { name: "InitialDecision", duration: null, durationKey: "phase1Duration" },
  { name: "Task", duration: null, durationKey: "gameDuration" },
  { name: "FinalDecision", duration: 120, durationKey: null },
];

/**
 * Resolves one Stage's duration in seconds. Required durations (intro/
 * phase1/game) must come from the real Empirica treatment
 * (`stageDurations`, passed straight from `game.get("treatment")` in
 * callbacks.js) -- a missing or invalid value fails clearly instead of
 * silently substituting a default, per this task's explicit requirement.
 */
function computeStageDuration(stagePlanEntry, stageDurations) {
  if (stagePlanEntry.duration !== null) return stagePlanEntry.duration;
  const minutes = stageDurations ? stageDurations[stagePlanEntry.durationKey] : undefined;
  if (!Number.isFinite(minutes) || minutes <= 0) {
    throw new Error(
      `Counterbalancing: missing or invalid required treatment duration "${stagePlanEntry.durationKey}" for Stage "${stagePlanEntry.name}" (got ${JSON.stringify(minutes)}). Check .empirica/treatments.yaml.`
    );
  }
  return minutes * 60;
}

/**
 * Creates Round 1 + Round 2 and their Stages for one Game, from a
 * sequenceId already resolved by Empirica's own treatment mechanism (no
 * ledger, no allocation, no recovery). Standard GRAIL/Empirica pattern:
 * `game.addRound({...})` then `round.addStage({...})`, called exactly
 * once per Game (onGameStart's real, single-invocation lifecycle) -- see
 * this file's header comment for why the previous idempotent-recovery
 * machinery had no live caller and was removed.
 */
export function setUpRoundsFromSequence({ game, sequenceId, stageDurations }) {
  validateGamePlayerCount(game);
  const roundAssignments = buildRoundAssignments(sequenceId); // throws on an invalid sequenceId -- never falls back

  const round1 = game.addRound({ name: "Round 1", ...buildRoundFields(roundAssignments.round1) });
  for (const stagePlanEntry of ROUND_STAGE_PLAN) {
    round1.addStage({ name: stagePlanEntry.name, duration: computeStageDuration(stagePlanEntry, stageDurations) });
  }

  const round2 = game.addRound({ name: "Round 2", ...buildRoundFields(roundAssignments.round2) });
  for (const stagePlanEntry of ROUND_STAGE_PLAN) {
    round2.addStage({ name: stagePlanEntry.name, duration: computeStageDuration(stagePlanEntry, stageDurations) });
  }

  return { sequenceId, roundAssignments, round1, round2 };
}
