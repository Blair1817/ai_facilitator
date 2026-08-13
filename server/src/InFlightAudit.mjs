export const IN_FLIGHT_KEY = "llmInFlight";

function appendLog(store, entry) {
  store.set("llmLog", [...(store.get("llmLog") || []), entry]);
}

export function beginInFlight(store, entry) {
  if (!entry?.auditRequestId) throw new Error("An in-flight audit entry requires auditRequestId");
  const pending = store.get(IN_FLIGHT_KEY) || {};
  store.set(IN_FLIGHT_KEY, { ...pending, [entry.auditRequestId]: { ...entry } });
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
