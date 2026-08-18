import assert from "node:assert/strict";
import test from "node:test";
import {
  beginInFlight,
  finalizeAuditLog,
  recoverInterruptedInFlight,
  getLlmLog,
  getLlmLogCount,
  getLatestLlmLogEntry,
  LLM_LOG_INDEX_KEY,
} from "./InFlightAudit.mjs";

function store() {
  // No pre-seeded `llmLog` array attribute. The new pattern keeps the
  // audit log in per-entry Attributes plus an `llmLogIndex` list, both
  // initialised lazily on first append.
  const values = new Map([["llmInFlight", {}]]);
  return { get: (key) => values.get(key), set: (key, value) => values.set(key, value) };
}

test("begin and finalize leave one terminal log and no pending marker", () => {
  const s = store();
  const entry = { auditRequestId: "r1", serverInstanceId: "a", outcome: "PENDING" };
  beginInFlight(s, entry);
  assert.equal(s.get("llmInFlight").r1.outcome, "PENDING");
  finalizeAuditLog(s, { ...entry, outcome: "PUBLISHED" });
  assert.deepEqual(s.get("llmInFlight"), {});

  const log = getLlmLog(s);
  assert.equal(log.length, 1);
  assert.equal(log[0].outcome, "PUBLISHED");
  assert.equal(log[0].responseContextDriftMessages, null);
  assert.equal(log[0].humanMessageCountAtCompletion, null);
  assert.ok(log[0].totalLatencyMs >= 0);
});

test("finalize records total latency and human-message context drift", () => {
  const s = store();
  s.set("humanMessageCount", 9);
  const entry = { auditRequestId: "latency", serverInstanceId: "a", outcome: "PUBLISHED", timestamp: 1_000, humanMessageCount: 6 };
  beginInFlight(s, entry);
  finalizeAuditLog(s, entry);
  const logged = getLatestLlmLogEntry(s);
  assert.ok(logged.totalLatencyMs >= 0);
  assert.equal(logged.humanMessageCountAtCompletion, 9);
  assert.equal(logged.responseContextDriftMessages, 3);
});

test("a new callbacks instance converts stale pending requests into explicit interrupted logs", () => {
  const s = store();
  beginInFlight(s, { auditRequestId: "old", serverInstanceId: "old-process", outcome: "PENDING" });
  beginInFlight(s, { auditRequestId: "live", serverInstanceId: "new-process", outcome: "PENDING" });
  const recovered = recoverInterruptedInFlight(s, "new-process", 1234);
  assert.equal(recovered.length, 1);
  assert.equal(recovered[0].outcome, "INTERRUPTED_CALLBACKS_RESTART");
  assert.deepEqual(Object.keys(s.get("llmInFlight")), ["live"]);

  // The recovered entry must also be visible through the new read API.
  const log = getLlmLog(s);
  assert.equal(log.length, 1);
  assert.equal(log[0].auditRequestId, "old");
  assert.equal(log[0].outcome, "INTERRUPTED_CALLBACKS_RESTART");
});

test("llmLog is stored as per-entry Attributes plus a small index, not a growing array", () => {
  const s = store();
  const bigPayload = "x".repeat(50_000);
  for (let i = 0; i < 25; i++) {
    const requestId = `r${i.toString().padStart(4, "0")}`;
    beginInFlight(s, { auditRequestId: requestId, serverInstanceId: "a", outcome: "PENDING" });
    finalizeAuditLog(s, {
      auditRequestId: requestId,
      serverInstanceId: "a",
      outcome: "PUBLISHED",
      agentState: { big: bigPayload },
    });
  }

  // The `llmLog` Attribute from the old design is intentionally absent.
  assert.equal(s.get("llmLog"), undefined, "old monolithic llmLog attribute must not be written");

  // The new design has an index plus one per-entry Attribute per call.
  const index = s.get(LLM_LOG_INDEX_KEY);
  assert.ok(Array.isArray(index));
  assert.equal(index.length, 25);
  assert.equal(getLlmLogCount(s), 25);
  for (let i = 0; i < 25; i++) {
    const requestId = `r${i.toString().padStart(4, "0")}`;
    const entry = s.get(`llmLog.${requestId}`);
    assert.ok(entry && entry.outcome === "PUBLISHED", `per-entry attr missing for ${requestId}`);
  }
});
