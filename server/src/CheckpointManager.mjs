/**
 * CheckpointManager.mjs
 *
 * Phase 3 (v2 design): the single source of truth for "should this
 * human message trigger a facilitation checkpoint right now?". Shared
 * by the Static AI facilitator and the Adaptive AI facilitator --
 * the trigger conditions are identical for both; only the post-trigger
 * pipeline differs.
 *
 * v2 design invariants (audited in `audit-phase1.md` v3):
 *   1. Every checkpoint consumes one "opportunity" only if it results
 *      in a PUBLISHED message. A blocked / SILENT / errored checkpoint
 *      does NOT consume opportunity -- the next valid 6-human-message
 *      gate is unchanged from the participant's perspective (Q3
 *      research-team decision).
 *   2. "Attempt" is decoupled from "publish": `attemptedThisRound`
 *      counts every checkpoint trigger, `publishedThisRound` counts
 *      only successful publishes. The intervention cap (default 3
 *      attempts per round) is on `attemptedThisRound` to prevent
 *      failure-storms from burning through cap budget; the publish
 *      budget is naturally bounded by the 6-message opportunity gate.
 *   3. Cooldown is on wall-clock time between any two attempts
 *      (success or fail) so a hot loop of failures can't bypass the
 *      intervention cap.
 *
 * This module is a pure function library over a thin state surface
 * (the `game` and `round` Empirica objects) -- no I/O, no LLM calls,
 * no Empirica lifecycle imports -- so it can be unit-tested directly
 * with a fake `game` object, same convention as utils.js and
 * SemanticAssessor.js.
 */

// Default config (Phase 3 placeholder values, frozen per Q4).
// Phase 8 will lock these once the pilot / Method M replay confirms
// they are usable; until then they are conservative defaults.
export const CHECKPOINT_DEFAULTS = Object.freeze({
  messagesBetweenInterventions: 6,   // 6 human messages between publishes
  cooldownMs: 30_000,                 // 30 seconds between any two attempts
  interventionCapPerRound: 3,        // max 3 attempts per round (Static + Adaptive)
  minTimeForInterventionMs: 10_000,   // 10s before deadline
});

// Phase 6.4 (Q8 = "即时"): the @-Facilitator mention marker. The client
// (client/src/components/CustomChat.jsx, `markup="@[__display__]"`) tags
// every mention in the rendered text with this exact substring. Kept as
// a single exported constant here so the client-side markup and the
// server-side detector can never drift apart (the constant is the
// single source of truth). Case-insensitive on the display name so
// "@[facilitator]", "@[FACILITATOR]", etc. all match -- matches the
// client's react-mentions behaviour, which is itself case-insensitive
// on the display string.
export const FACILITATOR_MENTION_MARKER = "@[Facilitator]";

/**
 * Phase 6.4 (Q8 = "即时"): returns true iff the given message text
 * contains an @-Facilitator mention. Used by callbacks.js#handleChat
 * to decide whether to pass `isMentionCheckpoint: true` to
 * shouldEvaluateCheckpoint, which bypasses the cooldown / opportunity
 * gate / dedup so a participant who explicitly addresses the Facilitator
 * gets a response on the very next handler tick, not 6 messages later.
 */
export function containsFacilitatorMention(text) {
  if (typeof text !== "string" || text.length === 0) return false;
  return text.toLowerCase().includes(FACILITATOR_MENTION_MARKER.toLowerCase());
}

/**
 * Build a default-shaped empty state object. Used by tests, by
 * onRoundStart (to initialise round-scoped fields), and by callers
 * that want a snapshot of "what the manager expects to read".
 */
export function emptyCheckpointState(overrides = {}) {
  return {
    humanMessageCount: 0,
    messagesSinceLastPublish: 0,
    lastAttemptTimestamp: 0,
    lastHandledCheckpoint: 0,
    attemptedThisRound: 0,
    publishedThisRound: 0,
    lastRole: null,
    lastCheckedFactors: null,
    synthesiserFired: false,
    interventionHistory: [],
    postInterventionUptake: 0,
    unresolvedNeed: null,
    ...overrides,
  };
}

/**
 * Read a checkpoint-shaped view over an arbitrary state object (in
 * production: a `game` Empirica instance; in tests: a plain object
 * with the same field names). Returns a plain object; the caller may
 * mutate it freely without touching the underlying store.
 */
export function readCheckpointState(store) {
  return emptyCheckpointState({
    humanMessageCount: store.get("humanMessageCount") ?? 0,
    messagesSinceLastPublish: store.get("messagesSinceLastPublish") ?? 0,
    lastAttemptTimestamp: store.get("lastAttemptTimestamp") ?? 0,
    lastHandledCheckpoint: store.get("lastHandledCheckpoint") ?? 0,
    attemptedThisRound: store.get("attemptedThisRound") ?? 0,
    publishedThisRound: store.get("publishedThisRound") ?? 0,
    lastRole: store.get("lastRole") ?? null,
    lastCheckedFactors: store.get("lastCheckedFactors") ?? null,
    synthesiserFired: store.get("synthesiserFired") ?? false,
    interventionHistory: store.get("interventionHistory") ?? [],
    postInterventionUptake: store.get("postInterventionUptake") ?? 0,
    unresolvedNeed: store.get("unresolvedNeed") ?? null,
  });
}

function writeCheckpointState(store, state) {
  for (const [k, v] of Object.entries(state)) {
    store.set(k, v);
  }
}

/**
 * Evaluate whether a checkpoint should be triggered for the given
 * human message. Returns one of:
 *   { trigger: true,  state, reason: "ok" | "participant_request" }
 *   { trigger: false, state, reason: "<one of the trigger conditions below>" }
 *
 * The reason is suitable for inclusion in the llmLog `reason` field.
 * The function does NOT mutate the state -- callers must call
 * `recordAttempt` / `recordPublish` explicitly, which makes it safe
 * to call speculatively (e.g. for log-only diagnostics) without
 * side effects.
 *
 * Required inputs:
 *   - store: a `game`-shaped object (get/set API)
 *   - humanMessageCount: the new total after this message was counted
 *   - currentStageName: e.g. "Task", "TLX", etc.
 *   - remainingTimeMs: ms until current round's deadline (0 if unknown)
 *   - now: timestamp (ms) for cooldown check; default Date.now()
 *   - config: override of CHECKPOINT_DEFAULTS; pass nothing to use defaults
 *   - chatKeyPresent: whether the round's chat array exists (false on
 *                     the very first message of a stage before the
 *                     transcript is initialised)
 *   - isMentionCheckpoint: an explicit participant request. During Task it
 *     bypasses automatic pacing, time-floor, and intervention-cap rules.
 *     Per-message dedup remains so one request yields exactly one response.
 */
export function shouldEvaluateCheckpoint({
  store,
  humanMessageCount,
  currentStageName,
  remainingTimeMs,
  chatKeyPresent = true,
  now = Date.now(),
  config = CHECKPOINT_DEFAULTS,
  isMentionCheckpoint = false,
}) {
  const state = readCheckpointState(store);

  // -- Trigger condition 1: chat is ready
  if (!chatKeyPresent) {
    return { trigger: false, state, reason: "chat_key_not_present" };
  }

  // -- Trigger condition 2: stage must be "Task"
  // (Static / Adaptive must NEVER fire during TLX, Survey, Quiz, etc.)
  if (currentStageName !== "Task") {
    return { trigger: false, state, reason: `stage_not_task (${currentStageName ?? "undefined"})` };
  }

  // Participant-requested turns are not automatic intervention
  // opportunities. Keep the chat/stage guards above and per-message dedup,
  // but do not let automatic timing or budget policy suppress a reply.
  if (isMentionCheckpoint) {
    if (state.lastHandledCheckpoint === humanMessageCount) {
      return {
        trigger: false,
        state,
        reason: `dedup (lastHandled=${state.lastHandledCheckpoint} === ${humanMessageCount})`,
      };
    }
    return { trigger: true, state, reason: "participant_request" };
  }

  // -- Trigger condition 3: minimum time remaining
  if (remainingTimeMs <= config.minTimeForInterventionMs) {
    return {
      trigger: false,
      state,
      reason: `time_floor (remaining=${remainingTimeMs}ms <= ${config.minTimeForInterventionMs}ms)`,
    };
  }

  // -- Trigger condition 4: per-round intervention cap
  // Counts every automatic attempt (success or fail) so a failure storm
  // cannot burn through the budget. Participant requests returned above.
  if (state.attemptedThisRound >= config.interventionCapPerRound) {
    return {
      trigger: false,
      state,
      reason: `cap_reached (attempted=${state.attemptedThisRound} >= ${config.interventionCapPerRound})`,
    };
  }

  // -- Trigger conditions 5/6/7: automatic pacing gates. Explicit
  // participant requests returned above.

  // -- Trigger condition 5: cooldown (wall-clock since last attempt)
  if (state.lastAttemptTimestamp > 0) {
    const elapsed = now - state.lastAttemptTimestamp;
    if (elapsed < config.cooldownMs) {
      return {
        trigger: false,
        state,
        reason: `cooldown (elapsed=${elapsed}ms < ${config.cooldownMs}ms)`,
      };
    }
  }

  // -- Trigger condition 6: 6-human-message opportunity gate
  // This is the "opportunity" gate per Q3: only PUBLISHED messages
  // reset it. Failed attempts do NOT reset it. (See audit-phase1.md
  // v3 §2 contract 1 for the data-driven rationale.)
  if (state.messagesSinceLastPublish < config.messagesBetweenInterventions) {
    return {
      trigger: false,
      state,
      reason: `opportunity_gate (since_last_publish=${state.messagesSinceLastPublish} < ${config.messagesBetweenInterventions})`,
    };
  }

  // -- Trigger condition 7: per-checkpoint dedup
  // Two events firing for the same humanMessageCount (e.g. retry of
  // a stale TCP message) must not double-trigger.
  if (state.lastHandledCheckpoint === humanMessageCount) {
    return {
      trigger: false,
      state,
      reason: `dedup (lastHandled=${state.lastHandledCheckpoint} === ${humanMessageCount})`,
    };
  }

  return { trigger: true, state, reason: "ok" };
}

/**
 * Record that a checkpoint was ATTEMPTED, regardless of outcome.
 * Always called by callbacks.js after `shouldEvaluateCheckpoint` says
 * trigger=true and the pipeline has run. Updates:
 *   - attemptedThisRound += 1
 *   - lastAttemptTimestamp = now
 *   - lastHandledCheckpoint = humanMessageCount (dedup bookkeeping)
 *
 * Does NOT reset messagesSinceLastPublish -- a failed attempt must
 * not consume the participant's opportunity to receive a real message
 * on the next 6-message window (Q3).
 */
export function recordAttempt(store, humanMessageCount, now = Date.now()) {
  const state = readCheckpointState(store);
  const updates = {
    attemptedThisRound: state.attemptedThisRound + 1,
    lastAttemptTimestamp: now,
    lastHandledCheckpoint: humanMessageCount,
  };
  writeCheckpointState(store, { ...state, ...updates });
}

/** Record a participant request for dedup without consuming automatic budget. */
export function recordParticipantRequest(store, humanMessageCount) {
  const state = readCheckpointState(store);
  writeCheckpointState(store, { ...state, lastHandledCheckpoint: humanMessageCount });
}

/** Audit a requested reply without resetting the automatic opportunity gate. */
export function recordParticipantRequestedPublish(store, { role, messageId, now = Date.now() }) {
  const state = readCheckpointState(store);
  const intervention = {
    timestamp: now,
    role,
    messageId: messageId ?? null,
    participantRequested: true,
  };
  writeCheckpointState(store, {
    ...state,
    interventionHistory: [...state.interventionHistory, intervention],
  });
}

/**
 * Record that a checkpoint resulted in a PUBLISHED facilitator message.
 * Resets the opportunity gate (so the next 6 human messages will be
 * the next opportunity), updates role/uptake bookkeeping, and appends
 * to the intervention history.
 */
export function recordPublish(store, { role, messageId, now = Date.now() }) {
  const state = readCheckpointState(store);
  const intervention = {
    timestamp: now,
    role,
    messageId: messageId ?? null,
    // Round/stage identity is appended at the call site if needed;
    // here we just keep the per-round slice.
  };
  const updates = {
    messagesSinceLastPublish: 0,
    publishedThisRound: state.publishedThisRound + 1,
    lastRole: role,
    postInterventionUptake: 0,   // reset; will be re-classified by Phase 4 uptake tracking
    interventionHistory: [...state.interventionHistory, intervention],
  };
  if (role === "synthesiser" || role === "INFORMATION_SYNTHESISER") {
    // Mark that the forced-synthesiser nudge has fired so it can't
    // fire twice in the same round. The Adaptive Controller reads
    // this in chooseRole(). Both the controller-internal key
    // ("synthesiser") and the generation-schema enum value
    // ("INFORMATION_SYNTHESISER") are accepted so callers from
    // either side of the prompt boundary record the flag correctly.
    updates.synthesiserFired = true;
  }
  writeCheckpointState(store, { ...state, ...updates });
}

/**
 * Initialise / reset the round-scoped checkpoint state. Called by
 * `onRoundStart` for each new round.
 */
export function resetRoundState(store) {
  writeCheckpointState(store, emptyCheckpointState());
}
