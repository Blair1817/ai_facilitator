import assert from "node:assert/strict";
import test from "node:test";
import {
  beginInFlight,
  compactAuditEntry,
  finalizeAuditLog,
  LLM_AUDIT_FIELD,
  recoverInterruptedInFlight,
} from "./InFlightAudit.mjs";

function store() {
  const values = new Map([["llmLog", [{ legacy: true }]], ["llmInFlight", {}]]);
  const writes = [];
  return {
    get: (key) => values.get(key),
    set: (key, value) => values.set(key, value),
    append: (key, value) => {
      writes.push({ key, value });
      values.set(key, [...(values.get(key) || []), value]);
    },
    writes,
  };
}

test("begin and finalize leave one terminal log and no pending marker", () => {
  const s = store();
  const entry = { auditRequestId: "r1", serverInstanceId: "a", outcome: "PENDING" };
  beginInFlight(s, entry);
  assert.equal(s.get("llmInFlight").r1.outcome, "PENDING");
  finalizeAuditLog(s, { ...entry, outcome: "PUBLISHED" });
  assert.deepEqual(s.get("llmInFlight"), {});
  assert.deepEqual(s.get("llmLog"), [{ legacy: true }]);
  assert.equal(s.get(LLM_AUDIT_FIELD).length, 1);
  assert.equal(s.get(LLM_AUDIT_FIELD)[0].outcome, "PUBLISHED");
  assert.equal(s.get(LLM_AUDIT_FIELD)[0].responseContextDriftMessages, null);
  assert.equal(s.get(LLM_AUDIT_FIELD)[0].humanMessageCountAtCompletion, null);
  assert.ok(s.get(LLM_AUDIT_FIELD)[0].totalLatencyMs >= 0);
  assert.equal(s.writes.length, 1);
  assert.equal(s.writes[0].key, LLM_AUDIT_FIELD);
  assert.equal(s.writes[0].value.auditRequestId, "r1");
});

test("finalize records total latency and human-message context drift", () => {
  const s = store();
  s.set("humanMessageCount", 9);
  const entry = { auditRequestId: "latency", serverInstanceId: "a", outcome: "PUBLISHED", timestamp: 1_000, humanMessageCount: 6 };
  beginInFlight(s, entry);
  finalizeAuditLog(s, entry);
  const logged = s.get(LLM_AUDIT_FIELD)[0];
  assert.ok(logged.totalLatencyMs >= 0);
  assert.equal(logged.humanMessageCountAtCompletion, 9);
  assert.equal(logged.responseContextDriftMessages, 3);
});

test("each terminal audit is appended as one independent Tajriba record", () => {
  const s = store();
  finalizeAuditLog(s, { auditRequestId: "r1", timestamp: 1, outcome: "SILENT" });
  finalizeAuditLog(s, { auditRequestId: "r2", timestamp: 2, outcome: "PUBLISHED" });
  assert.equal(s.writes.length, 2);
  assert.equal(s.writes[0].value.auditRequestId, "r1");
  assert.equal(s.writes[1].value.auditRequestId, "r2");
  assert.equal(s.get(LLM_AUDIT_FIELD).length, 2);
  assert.deepEqual(s.get("llmLog"), [{ legacy: true }]);
});

test("a new callbacks instance converts stale pending requests into explicit interrupted logs", () => {
  const s = store();
  beginInFlight(s, { auditRequestId: "old", serverInstanceId: "old-process", outcome: "PENDING" });
  beginInFlight(s, { auditRequestId: "live", serverInstanceId: "new-process", outcome: "PENDING" });
  const recovered = recoverInterruptedInFlight(s, "new-process", 1234);
  assert.equal(recovered.length, 1);
  assert.equal(recovered[0].outcome, "INTERRUPTED_CALLBACKS_RESTART");
  assert.deepEqual(Object.keys(s.get("llmInFlight")), ["live"]);
  assert.equal(s.get(LLM_AUDIT_FIELD)[0].outcome, "INTERRUPTED_CALLBACKS_RESTART");
});

test("audit append failure does not leave the request pending", () => {
  const s = store();
  beginInFlight(s, { auditRequestId: "r1", serverInstanceId: "a", outcome: "PENDING" });
  s.append = () => { throw new Error("simulated append failure"); };
  const completed = finalizeAuditLog(s, { auditRequestId: "r1", serverInstanceId: "a", outcome: "PUBLISHED" });
  assert.equal(completed.outcome, "PUBLISHED");
  assert.deepEqual(s.get("llmInFlight"), {});
  assert.deepEqual(s.get("llmLog"), [{ legacy: true }]);
});

test("audit entry construction failure falls back to a minimal terminal record", () => {
  const s = store();
  beginInFlight(s, { auditRequestId: "r1", serverInstanceId: "a", outcome: "PENDING" });
  const originalGet = s.get;
  let failHumanCountRead = true;
  s.get = (key) => {
    if (key === "humanMessageCount" && failHumanCountRead) {
      failHumanCountRead = false;
      throw new Error("simulated context read failure");
    }
    return originalGet(key);
  };

  const completed = finalizeAuditLog(s, {
    auditRequestId: "r1",
    serverInstanceId: "a",
    outcome: "PUBLISHED",
  });

  assert.equal(completed.outcome, "AUDIT_FINALIZATION_ERROR");
  assert.equal(s.get(LLM_AUDIT_FIELD)[0].outcome, "AUDIT_FINALIZATION_ERROR");
  assert.deepEqual(s.get("llmInFlight"), {});
});

test("restart-recovery append failure still clears only stale pending requests", () => {
  const s = store();
  beginInFlight(s, { auditRequestId: "old", serverInstanceId: "old-process", outcome: "PENDING" });
  beginInFlight(s, { auditRequestId: "live", serverInstanceId: "new-process", outcome: "PENDING" });
  s.append = () => { throw new Error("simulated recovery append failure"); };

  const recovered = recoverInterruptedInFlight(s, "new-process", 1234);

  assert.equal(recovered.length, 1);
  assert.equal(recovered[0].auditRequestId, "old");
  assert.deepEqual(Object.keys(s.get("llmInFlight")), ["live"]);
});

test("Tajriba in-flight and terminal records exclude bulky model state but retain operational summaries", () => {
  const s = store();
  const entry = {
    auditRequestId: "compact-1",
    serverInstanceId: "server-a",
    timestamp: 1_000,
    roundIndex: 1,
    facilitation: "adaptive",
    triggerType: "CHECKPOINT",
    gateDecision: "specialist",
    gateReason: "Evidence needs integration",
    eligibleRoles: ["Expander", "Synthesiser"],
    selectedRole: "Synthesiser",
    outcome: "PUBLISHED",
    requestMade: true,
    requestSuccess: true,
    messageAdded: true,
    publishedMessageId: "message-9",
    rawDetectorFactors: {
      low_integration: { status: "present", strength: 0.8, messageIds: ["m1", "m2"] },
    },
    checkedDetectorFactors: {
      low_integration: { status: "present", strength: 0.7, messageIds: ["m1"] },
      evidenceRelations: [{ messageId: "m1", integrated: false }],
    },
    validator: { passed: true, failedCriteria: [], explanation: "x".repeat(50_000) },
    messagesOAIFormat: [{ role: "user", content: "chat ".repeat(20_000) }],
    agentState: { cumulativeContext: "state ".repeat(20_000) },
    generatorRawResponses: [{ attempt: 1, rawText: "generator ".repeat(20_000) }],
    validatorRawResponses: [{ attempt: 1, rawText: "validator ".repeat(20_000) }],
  };

  beginInFlight(s, entry);
  const pending = s.get("llmInFlight")[entry.auditRequestId];
  assert.equal(pending.selectedRole, "Synthesiser");
  assert.equal(pending.semanticAssessorSummary.low_integration.status, "present");
  assert.equal(pending.evidenceCheckerSummary.evidenceRelationCount, 1);
  for (const excluded of ["messagesOAIFormat", "agentState", "generatorRawResponses", "validatorRawResponses"]) {
    assert.equal(Object.hasOwn(pending, excluded), false);
  }

  const completed = finalizeAuditLog(s, entry);
  const logged = s.get(LLM_AUDIT_FIELD)[0];
  assert.equal(logged.outcome, "PUBLISHED");
  assert.equal(logged.validator.passed, true);
  assert.equal(logged.publishedMessageId, "message-9");
  assert.equal(Object.hasOwn(logged, "agentState"), false);
  assert.equal(Object.hasOwn(logged, "messagesOAIFormat"), false);

  // finalizeAuditLog returns the unabridged object for the asynchronous
  // Supabase mirror even though the value persisted in Tajriba is compact.
  assert.deepEqual(completed.agentState, entry.agentState);
  assert.deepEqual(completed.messagesOAIFormat, entry.messagesOAIFormat);
  assert.deepEqual(completed.generatorRawResponses, entry.generatorRawResponses);
  assert.deepEqual(completed.validatorRawResponses, entry.validatorRawResponses);
});

test("compact Tajriba audit records stay bounded even when full prompts and responses are very large", () => {
  const huge = "x".repeat(250_000);
  const compact = compactAuditEntry({
    auditRequestId: "bounded",
    reason: huge,
    messagesOAIFormat: [{ content: huge }],
    agentState: { cumulativeContext: huge },
    generatorRawResponses: [{ rawText: huge }],
    validatorRawResponses: [{ rawText: huge }],
    rawDetectorFactors: { factor: { status: huge, messageIds: Array(100).fill(huge) } },
  });
  assert.ok(JSON.stringify(compact).length < 15_000);
  assert.match(compact.reason, /\[truncated\]$/);
  assert.equal(Object.hasOwn(compact, "messagesOAIFormat"), false);
});
