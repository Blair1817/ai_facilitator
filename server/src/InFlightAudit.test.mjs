import assert from "node:assert/strict";
import test from "node:test";
import { beginInFlight, finalizeAuditLog, recoverInterruptedInFlight } from "./InFlightAudit.mjs";

function store() {
  const values = new Map([["llmLog", []], ["llmInFlight", {}]]);
  return { get: (key) => values.get(key), set: (key, value) => values.set(key, value) };
}

test("begin and finalize leave one terminal log and no pending marker", () => {
  const s = store();
  const entry = { auditRequestId: "r1", serverInstanceId: "a", outcome: "PENDING" };
  beginInFlight(s, entry);
  assert.equal(s.get("llmInFlight").r1.outcome, "PENDING");
  finalizeAuditLog(s, { ...entry, outcome: "PUBLISHED" });
  assert.deepEqual(s.get("llmInFlight"), {});
  assert.equal(s.get("llmLog").length, 1);
  assert.equal(s.get("llmLog")[0].outcome, "PUBLISHED");
  assert.equal(s.get("llmLog")[0].responseContextDriftMessages, null);
  assert.equal(s.get("llmLog")[0].humanMessageCountAtCompletion, null);
  assert.ok(s.get("llmLog")[0].totalLatencyMs >= 0);
});

test("finalize records total latency and human-message context drift", () => {
  const s = store();
  s.set("humanMessageCount", 9);
  const entry = { auditRequestId: "latency", serverInstanceId: "a", outcome: "PUBLISHED", timestamp: 1_000, humanMessageCount: 6 };
  beginInFlight(s, entry);
  finalizeAuditLog(s, entry);
  const logged = s.get("llmLog")[0];
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
});
