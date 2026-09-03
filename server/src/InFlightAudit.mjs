import {
  appendToAttribute,
  readAppendOnlyAttribute,
  ensureAppendOnlyAttribute,
} from "./AppendOnlyAttribute.mjs";

export const IN_FLIGHT_KEY = "llmInFlight";
export const LLM_LOG_INDEX_KEY = "llmLogIndex";
export const LLM_LOG_NAMESPACE = "llmLog";

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
  const index = store.get(LLM_LOG_INDEX_KEY);
  if (
    typeof id === "string"
    && id.length > 0
    && Array.isArray(index)
    && index.includes(id)
    && store.get(`${LLM_LOG_NAMESPACE}.${id}`)
  ) {
    return id;
  }
  // Write the canonical lifecycle id last so an incidental `id: undefined`
  // field on a producer payload cannot overwrite it during object spread.
  return appendToAttribute(store, LLM_LOG_NAMESPACE, { ...entry, id });
}

export function beginInFlight(store, entry) {
  if (!entry?.auditRequestId) throw new Error("An in-flight audit entry requires auditRequestId");
  const pending = store.get(IN_FLIGHT_KEY) || {};
  store.set(IN_FLIGHT_KEY, {
    ...pending,
    [entry.auditRequestId]: { ...entry, visibleResponsePending: false },
  });
}

/**
 * Mark whether an audited checkpoint is actively preparing a participant-
 * visible Facilitator response. This is intentionally separate from the
 * broader in-flight audit lifecycle: Adaptive assessment can be in flight
 * without implying that the Facilitator will respond.
 */
export function setVisibleResponsePending(store, auditRequestId, pending) {
  if (!auditRequestId) return false;
  const inFlight = store.get(IN_FLIGHT_KEY) || {};
  const entry = inFlight[auditRequestId];
  if (!entry) return false;
  store.set(IN_FLIGHT_KEY, {
    ...inFlight,
    [auditRequestId]: { ...entry, visibleResponsePending: pending === true },
  });
  return true;
}

export function finalizeAuditLog(store, entry) {
  const requestId = entry?.auditRequestId;
  if (requestId) {
    const pending = { ...(store.get(IN_FLIGHT_KEY) || {}) };
    delete pending[requestId];
    store.set(IN_FLIGHT_KEY, pending);
  }
  const auditCompletedAt = Date.now();
  const humanMessageCountAtCompletion = store.get("humanMessageCount");
  const responseContextDriftMessages = Number.isFinite(entry?.humanMessageCount) && Number.isFinite(humanMessageCountAtCompletion)
    ? Math.max(0, humanMessageCountAtCompletion - entry.humanMessageCount)
    : null;
  appendLog(store, {
    ...entry,
    auditCompletedAt,
    totalLatencyMs: Number.isFinite(entry?.timestamp) ? Math.max(0, auditCompletedAt - entry.timestamp) : null,
    humanMessageCountAtCompletion: Number.isFinite(humanMessageCountAtCompletion) ? humanMessageCountAtCompletion : null,
    responseContextDriftMessages,
  });
}

export function recoverInterruptedInFlight(store, currentServerInstanceId, now = Date.now()) {
  const pending = store.get(IN_FLIGHT_KEY) || {};
  const keep = {};
  const recovered = [];

  for (const [requestId, entry] of Object.entries(pending)) {
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

  if (recovered.length > 0 || Object.keys(keep).length !== Object.keys(pending).length) {
    store.set(IN_FLIGHT_KEY, keep);
  }
  return recovered;
}

/**
 * Idempotently initialise the llmLog index on a game. Called from
 * onGameStart so a fresh game starts on the bounded-storage path even
 * if no log entries are written immediately.
 */
export function ensureLlmLogIndex(store) {
  ensureAppendOnlyAttribute(store, LLM_LOG_NAMESPACE);
}
