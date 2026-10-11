import {
  appendToAttribute,
  readAppendOnlyAttribute,
  ensureAppendOnlyAttribute,
} from "./AppendOnlyAttribute.mjs";

export const IN_FLIGHT_KEY = "llmInFlight";
export const LLM_LOG_INDEX_KEY = "llmLogIndex";
export const LLM_LOG_NAMESPACE = "llmLog";

// Empirica batches scalar Attribute writes and flushes them asynchronously.
// Two overlapping callbacks can therefore read different snapshots of the
// same whole-object Attribute and commit them out of order. Keep the very
// small llmInFlight/log mutation transactions ordered per Game while leaving
// the expensive LLM work itself fully concurrent.
const lifecycleMutationTails = new Map();

function lifecycleQueueKey(store) {
  return typeof store?.id === "string" && store.id.length > 0 ? store.id : store;
}

function enqueueLifecycleMutation(store, operation) {
  const key = lifecycleQueueKey(store);
  const previous = lifecycleMutationTails.get(key) || Promise.resolve();
  const run = previous.then(operation);
  // A rejected mutation must reach its caller without poisoning every later
  // lifecycle update for the same Game.
  const settled = run.then(() => undefined, () => undefined);
  lifecycleMutationTails.set(key, settled);
  settled.then(() => {
    if (lifecycleMutationTails.get(key) === settled) {
      lifecycleMutationTails.delete(key);
    }
  });
  return run;
}

async function flushLifecycleMutation(flush) {
  if (flush === undefined) return;
  if (typeof flush !== "function") {
    throw new TypeError("In-flight lifecycle flush must be a function");
  }
  await flush();
}

function terminalLogKey(auditRequestId) {
  return `${LLM_LOG_NAMESPACE}.${auditRequestId}`;
}

function terminalLog(store, auditRequestId) {
  if (typeof auditRequestId !== "string" || auditRequestId.length === 0) return null;
  const existing = store.get(terminalLogKey(auditRequestId));
  return existing && typeof existing === "object" && !Array.isArray(existing) ? existing : null;
}

function activeInFlight(store) {
  const raw = store.get(IN_FLIGHT_KEY);
  const source = raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {};
  const active = {};
  let pruned = source !== raw;

  for (const [requestId, entry] of Object.entries(source)) {
    // A per-request terminal audit is immutable authority. A stale aggregate
    // snapshot must never be allowed to turn that request back into PENDING.
    if (terminalLog(store, requestId)) {
      pruned = true;
      continue;
    }
    active[requestId] = entry;
  }

  return { active, pruned };
}

/**
 * Read the ordered llmLog entries for `store` (a game).
 *
 * Replaces the previous `store.get("llmLog")` read API. Callers that
 * only need a count or the latest entry should use the explicit helpers
 * in this module (`getLlmLogCount`, `getLatestLlmLogEntry`) to avoid
 * materialising the full list.
 */
export function getLlmLog(store) {
  return readAppendOnlyAttribute(store, LLM_LOG_NAMESPACE);
}

export function getLlmLogCount(store) {
  const index = store.get(LLM_LOG_INDEX_KEY);
  return Array.isArray(index) ? index.length : 0;
}

export function getLatestLlmLogEntry(store) {
  const all = getLlmLog(store);
  return all.length > 0 ? all[all.length - 1] : null;
}

function appendLog(store, entry) {
  // The previous implementation stored the full growing array under a
  // single `llmLog` Attribute, which caused `tajriba.json` to accumulate
  // O(N^2) bytes in a single line and eventually exceed Tajriba's Go
  // `bufio.Scanner` token limit on reload. The bounded per-entry +
  // index pattern in AppendOnlyAttribute keeps each line sized to one
  // entry instead of the cumulative log.
  const id = entry?.auditRequestId;
  // A repeated terminal callback for the same lifecycle is an idempotent
  // retry, not a second audit event. Keep the first append immutable while
  // still allowing recovery from a partial write whose index or entry is
  // missing. Invalid ids continue into appendToAttribute and fail loudly.
  const index = Array.isArray(store.get(LLM_LOG_INDEX_KEY)) ? store.get(LLM_LOG_INDEX_KEY) : [];
  const existing = typeof id === "string" && id.length > 0
    ? terminalLog(store, id)
    : null;
  if (existing) {
    // The per-request entry is canonical. Repair a missing index reference,
    // but never overwrite the first terminal outcome on a retry/recovery.
    if (!index.includes(id)) {
      store.set(LLM_LOG_INDEX_KEY, [...index, id]);
    }
    return id;
  }
  if (typeof id === "string" && id.length > 0 && index.includes(id)) {
    // Complete an index-first partial append without adding the same request
    // to the ordered index a second time.
    store.set(terminalLogKey(id), { ...entry, id });
    return id;
  }
  // Write the canonical lifecycle id last so an incidental `id: undefined`
  // field on a producer payload cannot overwrite it during object spread.
  return appendToAttribute(store, LLM_LOG_NAMESPACE, { ...entry, id });
}

export function beginInFlight(store, entry, flush) {
  if (!entry?.auditRequestId) throw new Error("An in-flight audit entry requires auditRequestId");
  return enqueueLifecycleMutation(store, async () => {
    const { active, pruned } = activeInFlight(store);
    if (terminalLog(store, entry.auditRequestId) || active[entry.auditRequestId]) {
      if (pruned) store.set(IN_FLIGHT_KEY, active);
      await flushLifecycleMutation(flush);
      return false;
    }
    store.set(IN_FLIGHT_KEY, {
      ...active,
      [entry.auditRequestId]: { ...entry, visibleResponsePending: false },
    });
    await flushLifecycleMutation(flush);
    return true;
  });
}

/**
 * Mark whether an audited checkpoint is actively preparing a participant-
 * visible Facilitator response. This is intentionally separate from the
 * broader in-flight audit lifecycle: Adaptive assessment can be in flight
 * without implying that the Facilitator will respond.
 */
export function setVisibleResponsePending(store, auditRequestId, pending, flush) {
  if (!auditRequestId) return Promise.resolve(false);
  return enqueueLifecycleMutation(store, async () => {
    const { active, pruned } = activeInFlight(store);
    const entry = active[auditRequestId];
    if (!entry) {
      if (pruned) store.set(IN_FLIGHT_KEY, active);
      await flushLifecycleMutation(flush);
      return false;
    }
    store.set(IN_FLIGHT_KEY, {
      ...active,
      [auditRequestId]: { ...entry, visibleResponsePending: pending === true },
    });
    await flushLifecycleMutation(flush);
    return true;
  });
}

export function finalizeAuditLog(store, entry, flush) {
  const auditCompletedAt = Date.now();
  const humanMessageCountAtCompletion = store.get("humanMessageCount");
  const responseContextDriftMessages = Number.isFinite(entry?.humanMessageCount) && Number.isFinite(humanMessageCountAtCompletion)
    ? Math.max(0, humanMessageCountAtCompletion - entry.humanMessageCount)
    : null;
  const completed = {
    ...entry,
    auditCompletedAt,
    totalLatencyMs: Number.isFinite(entry?.timestamp) ? Math.max(0, auditCompletedAt - entry.timestamp) : null,
    humanMessageCountAtCompletion: Number.isFinite(humanMessageCountAtCompletion) ? humanMessageCountAtCompletion : null,
    responseContextDriftMessages,
  };

  return enqueueLifecycleMutation(store, async () => {
    // Write the immutable terminal record before projecting the active set.
    // activeInFlight then removes this request and any older resurrected
    // terminal entries in the same transaction.
    appendLog(store, completed);
    const canonical = terminalLog(store, entry?.auditRequestId) || completed;
    const { active } = activeInFlight(store);
    store.set(IN_FLIGHT_KEY, active);
    await flushLifecycleMutation(flush);
    return canonical;
  });
}

export function recoverInterruptedInFlight(store, currentServerInstanceId, now = Date.now(), flush) {
  return enqueueLifecycleMutation(store, async () => {
    const raw = store.get(IN_FLIGHT_KEY);
    const pending = raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {};
    const keep = {};
    const recovered = [];

    for (const [requestId, entry] of Object.entries(pending)) {
      const existingTerminal = terminalLog(store, requestId);
      if (existingTerminal) {
        // Repair a partially written index if needed, but never duplicate or
        // relabel an audit that already reached a terminal outcome.
        appendLog(store, existingTerminal);
        continue;
      }
      if (entry.serverInstanceId === currentServerInstanceId) {
        keep[requestId] = entry;
        continue;
      }
      const recoveredEntry = {
        ...entry,
        auditRequestId: requestId,
        outcome: "INTERRUPTED_CALLBACKS_RESTART",
        reason: "Callbacks process ended before this checkpoint wrote a terminal audit record",
        requestSuccess: false,
        messageAdded: false,
        recoveredAt: now,
        auditCompletedAt: now,
      };
      appendLog(store, recoveredEntry);
      recovered.push(recoveredEntry);
    }

    if (
      recovered.length > 0
      || Object.keys(keep).length !== Object.keys(pending).length
      || pending !== raw
    ) {
      store.set(IN_FLIGHT_KEY, keep);
    }
    await flushLifecycleMutation(flush);
    return recovered;
  });
}

/**
 * Idempotently initialise the llmLog index on a game. Called from
 * onGameStart so a fresh game starts on the bounded-storage path even
 * if no log entries are written immediately.
 */
export function ensureLlmLogIndex(store) {
  ensureAppendOnlyAttribute(store, LLM_LOG_NAMESPACE);
}
