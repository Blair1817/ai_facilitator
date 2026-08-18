export const IN_FLIGHT_KEY = "llmInFlight";
export const LLM_AUDIT_FIELD = "llmAuditEvents";

const MAX_AUDIT_TEXT_LENGTH = 1_000;
const MAX_AUDIT_LIST_LENGTH = 24;

const SCALAR_AUDIT_FIELDS = Object.freeze([
  "auditRequestId",
  "serverInstanceId",
  "timestamp",
  "auditCompletedAt",
  "recoveredAt",
  "totalLatencyMs",
  "roundIndex",
  "facilitation",
  "originatingRoundId",
  "originatingStageId",
  "humanMessageCount",
  "humanMessageCountAtCompletion",
  "responseContextDriftMessages",
  "messagesSinceLastPublish",
  "messagesSinceLastIntervention",
  "remainingTime",
  "timeElapsed",
  "triggerType",
  "mentionDetected",
  "participantRequested",
  "countsAsIntervention",
  "routingDecision",
  "gateDecision",
  "selectedRole",
  "controllerSelectedRole",
  "forced",
  "fallbackKind",
  "fallbackUsed",
  "fallbackRoute",
  "fallbackPublished",
  "requestMade",
  "requestSuccess",
  "messageAdded",
  "outcome",
  "reason",
  "reasoning",
  "gateReason",
  "publishedMessageId",
  "attempts",
  "totalGeneratorAttempts",
  "detectorLatency",
  "detectorError",
  "model",
]);

function compactText(value, limit = MAX_AUDIT_TEXT_LENGTH) {
  if (typeof value !== "string") return value;
  return value.length <= limit ? value : `${value.slice(0, limit)}...[truncated]`;
}

function compactList(value, limit = MAX_AUDIT_LIST_LENGTH) {
  if (!Array.isArray(value)) return undefined;
  return value.slice(0, limit).map((item) => (
    typeof item === "string" ? compactText(item, 200) : item
  ));
}

function compactNumericMap(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  return Object.fromEntries(Object.entries(value).flatMap(([key, item]) => (
    Number.isFinite(item) || typeof item === "boolean" || typeof item === "string"
      ? [[key, typeof item === "string" ? compactText(item, 200) : item]]
      : []
  )));
}

function summarizeValidator(value) {
  if (!value || typeof value !== "object") return undefined;
  return {
    passed: value.passed === true ? true : value.passed === false ? false : null,
    failedCriteria: compactList(value.failedCriteria),
  };
}

function summarizeFactors(value) {
  if (!value || typeof value !== "object") return undefined;
  const summary = {};
  for (const [factor, result] of Object.entries(value)) {
    if (factor === "evidenceRelations") {
      summary.evidenceRelationCount = Array.isArray(result) ? result.length : 0;
      continue;
    }
    if (!result || typeof result !== "object") continue;
    summary[factor] = {
      status: compactText(result.status ?? result.decision ?? null, 200),
      strength: Number.isFinite(result.strength) ? result.strength : null,
      messageIds: compactList(result.messageIds ?? result.message_ids),
    };
  }
  return Object.keys(summary).length > 0 ? summary : undefined;
}

function summarizePromptMetadata(value) {
  if (!value || typeof value !== "object") return undefined;
  const allowed = [
    "model",
    "generationRole",
    "promptVersion",
    "policyVersion",
    "controllerVersion",
    "validatorVersion",
    "schemaVersion",
  ];
  const summary = Object.fromEntries(allowed.flatMap((key) => (
    value[key] === undefined ? [] : [[key, compactText(value[key], 200)]]
  )));
  return Object.keys(summary).length > 0 ? summary : undefined;
}

/**
 * Build the bounded operational audit record stored in Tajriba.
 *
 * The full entry remains in memory and is returned by finalizeAuditLog() for
 * the detailed Supabase research mirror. Tajriba intentionally receives only
 * identifiers, timing, routing/validation summaries and the terminal outcome;
 * full prompts, transcripts, agent state and raw model responses are excluded.
 */
export function compactAuditEntry(entry = {}) {
  const compact = {};
  for (const key of SCALAR_AUDIT_FIELDS) {
    const value = entry[key];
    if (value === undefined) continue;
    if (typeof value === "string") compact[key] = compactText(value);
    else if (value === null || ["number", "boolean"].includes(typeof value)) compact[key] = value;
  }

  for (const key of ["eligibleRoles", "generatorLatenciesMs", "validatorLatenciesMs"]) {
    const value = compactList(entry[key]);
    if (value !== undefined) compact[key] = value;
  }

  const stateScores = compactNumericMap(entry.stateScores);
  if (stateScores) compact.stateScores = stateScores;
  const assessorSummary = summarizeFactors(entry.rawDetectorFactors);
  if (assessorSummary) compact.semanticAssessorSummary = assessorSummary;
  const evidenceCheckerSummary = summarizeFactors(entry.checkedDetectorFactors);
  if (evidenceCheckerSummary) compact.evidenceCheckerSummary = evidenceCheckerSummary;
  const validator = summarizeValidator(entry.validator);
  if (validator) compact.validator = validator;
  const validatorRepair = summarizeValidator(entry.validatorRepair);
  if (validatorRepair) compact.validatorRepair = validatorRepair;
  const promptMetadata = summarizePromptMetadata(entry.promptMetadata);
  if (promptMetadata) compact.promptMetadata = promptMetadata;

  if (entry.specialistFailure && typeof entry.specialistFailure === "object") {
    compact.specialistFailure = {
      reason: compactText(entry.specialistFailure.reason ?? null),
      outcome: compactText(entry.specialistFailure.outcome ?? null, 200),
      attempts: Number.isFinite(entry.specialistFailure.attempts) ? entry.specialistFailure.attempts : null,
      validator: summarizeValidator(entry.specialistFailure.validator),
      validatorRepair: summarizeValidator(entry.specialistFailure.validatorRepair),
    };
  }

  return compact;
}

function safeAuditWarning(code) {
  console.warn("[facilitator audit] Tajriba audit operation failed", { code });
}

function appendLog(store, entry) {
  // Tajriba's file store is append-only. Re-setting an ever-growing array
  // writes the complete audit history into a single JSONL record every time,
  // eventually exceeding the reader's per-line Scanner limit. Store one
  // immutable audit event per Attribute record instead. Empirica still
  // exposes appended values through store.get(LLM_AUDIT_FIELD) as an array.
  // This field must never be initialized with set(): its first write is append.
  store.append(LLM_AUDIT_FIELD, compactAuditEntry(entry));
}

export function beginInFlight(store, entry) {
  if (!entry?.auditRequestId) throw new Error("An in-flight audit entry requires auditRequestId");
  const pending = store.get(IN_FLIGHT_KEY) || {};
  store.set(IN_FLIGHT_KEY, { ...pending, [entry.auditRequestId]: compactAuditEntry(entry) });
}

export function finalizeAuditLog(store, entry) {
  const requestId = entry?.auditRequestId;
  let completedEntry;

  try {
    const auditCompletedAt = Date.now();
    const humanMessageCountAtCompletion = store.get("humanMessageCount");
    const responseContextDriftMessages = Number.isFinite(entry?.humanMessageCount) && Number.isFinite(humanMessageCountAtCompletion)
      ? Math.max(0, humanMessageCountAtCompletion - entry.humanMessageCount)
      : null;
    completedEntry = {
      ...entry,
      auditCompletedAt,
      totalLatencyMs: Number.isFinite(entry?.timestamp) ? Math.max(0, auditCompletedAt - entry.timestamp) : null,
      humanMessageCountAtCompletion: Number.isFinite(humanMessageCountAtCompletion) ? humanMessageCountAtCompletion : null,
      responseContextDriftMessages,
    };
  } catch {
    completedEntry = {
      auditRequestId: requestId ?? null,
      serverInstanceId: entry?.serverInstanceId ?? null,
      roundIndex: entry?.roundIndex ?? null,
      facilitation: entry?.facilitation ?? null,
      outcome: "AUDIT_FINALIZATION_ERROR",
      requestSuccess: false,
      messageAdded: Boolean(entry?.messageAdded),
      publishedMessageId: entry?.publishedMessageId ?? null,
      auditCompletedAt: Date.now(),
    };
  }

  try {
    appendLog(store, completedEntry);
  } catch {
    safeAuditWarning("TAJRIBA_AUDIT_APPEND_FAILED");
  } finally {
    if (requestId) {
      try {
        const pending = { ...(store.get(IN_FLIGHT_KEY) || {}) };
        delete pending[requestId];
        store.set(IN_FLIGHT_KEY, pending);
      } catch {
        safeAuditWarning("IN_FLIGHT_CLEAR_FAILED");
      }
    }
  }

  return completedEntry;
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
    try {
      appendLog(store, recoveredEntry);
    } catch {
      safeAuditWarning("RESTART_AUDIT_APPEND_FAILED");
    }
    recovered.push(recoveredEntry);
  }

  if (recovered.length > 0 || Object.keys(keep).length !== Object.keys(pending).length) {
    try {
      store.set(IN_FLIGHT_KEY, keep);
    } catch {
      safeAuditWarning("RESTART_IN_FLIGHT_CLEAR_FAILED");
    }
  }
  return recovered;
}
