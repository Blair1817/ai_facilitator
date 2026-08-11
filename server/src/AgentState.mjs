/**
 * AgentState.mjs
 *
 * Phase 3 (v2 design): the structured, read-only view of the
 * facilitation agent's external memory that the pipeline consumes.
 *
 * The State is built fresh on every checkpoint trigger from the
 * authoritative state on the `game` and `round` Empirica objects --
 * it is NOT a separate persistent store. Callers should treat the
 * returned object as immutable for the duration of one checkpoint's
 * pipeline; if a downstream stage needs to record a derived value
 * (e.g. Semantic Assessor's raw factors, or an "unresolved need"
 * after the gate decided Abstain), it must write back through
 * `writeAgentStateField(store, key, value)` so the next checkpoint
 * sees the update.
 *
 * Privacy boundary (architecture doc §6 节点 15, also Word §11
 * "Privacy & Access"):
 *   - ONLY public transcript + public task description are read here.
 *   - No private profile content, no correct-answer data, no
 *     participant identity beyond the colour/alias already shown in
 *     the chat. The helpers below enforce this by name (e.g. there
 *     is intentionally NO `privateProfileContent()` helper) -- the
 *     privacy contract is structural, not just a comment.
 *
 * The shape mirrors the audit's §4 "structured AgentState" list, plus
 * the per-checkpoint operating fields needed by the Controller and
 * the policy/repair phases. All fields are documented in place.
 */

import { readCheckpointState } from "./CheckpointManager.mjs";

/**
 * @typedef {Object} MessageView
 * @property {string} messageId   -- "m0", "m1", ... (positional, per DynamicContext.withMessageIds)
 * @property {string} text
 * @property {string} senderId    -- player.id, or "ai" for facilitator
 * @property {string} senderName  -- "Red", "Pink", "Blue", "Green", "Facilitator"
 * @property {number} ts          -- unix ms
 */

/**
 * @typedef {Object} InterventionRecord
 * @property {number} timestamp
 * @property {string} role         -- STATIC | GENERALIST | INFORMATION_EXPANDER | ...
 * @property {string|null} messageId
 * @property {string} outcome      -- "PUBLISHED" | "SILENT_blocked" | "SILENT_abstain" | "SILENT_error" | ...
 */

/**
 * @typedef {Object} AgentState
 * @property {string} currentRoundId
 * @property {number} currentRoundIndex
 * @property {string} currentStageName
 * @property {string|null} facilitation        -- "static" | "adaptive"
 * @property {string|null} generalInfo         -- task description
 * @property {MessageView[]} cumulativeContext  -- all messages, public + AI, with positional ids
 * @property {MessageView[]} localContext       -- last 6 HUMAN messages
 * @property {MessageView[]} recentAiMessages   -- last 3 AI messages
 * @property {string[]} eligibleMessageIds
 * @property {string[]} aiOrSystemMessageIds
 * @property {string[]} recentAiMessageTexts
 *
 * @property {number} humanMessageCount
 * @property {number} messagesSinceLastPublish
 * @property {number} attemptedThisRound
 * @property {number} publishedThisRound
 * @property {number} lastAttemptTimestamp
 * @property {number} lastHandledCheckpoint
 *
 * @property {string|null} lastRole
 * @property {object|null} lastCheckedFactors
 * @property {InterventzionRecord[]} interventionHistory
 * @property {number} postInterventionUptake   -- 0 = no, 1 = surface, 2 = reasoning
 *
 * @property {string|null} unresolvedNeed
 * @property {number} remainingTimeMs
 * @property {number} elapsedTimeMs
 * @property {number} deltaSinceLastCheckpoint -- human messages since last checkpoint
 *
 * @property {EvidenceRelation[]} evidenceRelations  -- Delibra spec §3 Node 3,
 *   2026-08-11: per-message 6-boolean relations (mentioned/attributed/
 *   evaluated/compared/countered/integrated). Sourced from
 *   `lastCheckedFactors.evidenceRelations` (Assessor output, validated by
 *   EvidenceChecker.js). The Controller uses this to drive role decisions
 *   (e.g. "mentioned but not compared" → Synthesiser). Empty array on
 *   early checkpoints before any relations tracking has happened.
 */

/**
 * Build the AgentState view. Pure / deterministic / no side effects.
 *
 * @param {Object} game          -- Empirica game (or a test fake with .get / .currentRound)
 * @param {Object} round         -- Empirica round (or a test fake with .get)
 * @param {Object} chat          -- array of {text, ts, sender}
 * @param {Object} [opts]
 * @param {number} [opts.now]
 * @param {number} [opts.localContextSize=6]
 * @param {number} [opts.recentAiSize=3]
 */
export function buildAgentState(game, round, chat, opts = {}) {
  const now = opts.now ?? Date.now();
  const localContextSize = opts.localContextSize ?? 6;
  const recentAiSize = opts.recentAiSize ?? 3;

  const checkpoint = readCheckpointState(game);

  // -- Positional, deterministic message IDs (per DynamicContext.withMessageIds).
  const withIds = chat.map((m, idx) => ({ ...m, messageId: `m${idx}` }));
  const allHuman = withIds.filter((m) => m.sender.id !== "ai");
  const allAi = withIds.filter((m) => m.sender.id === "ai");
  const localHuman = allHuman.slice(-localContextSize);
  const recentAi = allAi.slice(-recentAiSize);

  // -- delta since last checkpoint: how many human messages have
  // arrived since `lastHandledCheckpoint` (0 if no prior checkpoint).
  const delta = checkpoint.lastHandledCheckpoint > 0
    ? checkpoint.humanMessageCount - checkpoint.lastHandledCheckpoint
    : checkpoint.humanMessageCount;

  const remainingTimeMs = (() => {
    const deadline = game.get ? game.get("deadline") : null;
    if (typeof deadline !== "number") return 0;
    return Math.max(0, deadline - now);
  })();

  const taskStartTime = game.get ? game.get("taskStartTime") : null;
  const elapsedTimeMs = typeof taskStartTime === "number" ? now - taskStartTime : 0;

  return {
    // -- identity / scope
    currentRoundId: round.id,
    currentRoundIndex: round.get("index"),
    currentStageName: game.currentStage?.get("name") ?? null,
    facilitation: round.get("facilitation") ?? null,
    generalInfo: round.get("generalInfo") ?? "",

    // -- public context
    cumulativeContext: withIds,
    localContext: localHuman,
    recentAiMessages: recentAi,
    eligibleMessageIds: allHuman.map((m) => m.messageId),
    aiOrSystemMessageIds: allAi.map((m) => m.messageId),
    recentAiMessageTexts: recentAi.map((m) => m.text),

    // -- counters (mirrors CheckpointManager)
    humanMessageCount: checkpoint.humanMessageCount,
    messagesSinceLastPublish: checkpoint.messagesSinceLastPublish,
    attemptedThisRound: checkpoint.attemptedThisRound,
    publishedThisRound: checkpoint.publishedThisRound,
    lastAttemptTimestamp: checkpoint.lastAttemptTimestamp,
    lastHandledCheckpoint: checkpoint.lastHandledCheckpoint,

    // -- history
    lastRole: checkpoint.lastRole,
    lastCheckedFactors: checkpoint.lastCheckedFactors,
    interventionHistory: checkpoint.interventionHistory,
    postInterventionUptake: checkpoint.postInterventionUptake,

    // -- deliberation state
    unresolvedNeed: checkpoint.unresolvedNeed,
    remainingTimeMs,
    elapsedTimeMs,
    deltaSinceLastCheckpoint: delta,

    // -- evidence-use relations (Delibra spec §3 Node 3, 2026-08-11)
    // 6 booleans per participant messageId, from Assessor → EvidenceChecker.
    // Empty array when no Assessor has run yet (early checkpoints) or
    // when the Assessor returned an empty list.
    evidenceRelations: Array.isArray(checkpoint.lastCheckedFactors?.evidenceRelations)
      ? checkpoint.lastCheckedFactors.evidenceRelations
      : [],
  };
}

/**
 * Write a single field back to the persistent store. The
 * `AgentState` returned by `buildAgentState` is intentionally
 * decoupled from the live store; updates have to go through this
 * helper so we have a single audit point for state mutations.
 *
 * `store` is the `game` Empirica object (game.set) -- NOT the
 * `round`, because the agent's state is game-level per the
 * existing convention (see callbacks.js#onRoundStart).
 */
export function writeAgentStateField(store, key, value) {
  store.set(key, value);
}

/**
 * Convenience: write multiple fields at once.
 */
export function writeAgentStateFields(store, updates) {
  for (const [k, v] of Object.entries(updates)) {
    store.set(k, v);
  }
}
