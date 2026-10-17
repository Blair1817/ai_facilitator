import assert from "node:assert/strict";
import test from "node:test";
import {
  beginInFlight,
  finalizeAuditLog,
  recoverInterruptedInFlight,
  setVisibleResponsePending,
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

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

test("begin and finalize leave one terminal log and no pending marker", async () => {
  const s = store();
  const entry = { auditRequestId: "r1", serverInstanceId: "a", outcome: "PENDING" };
  await beginInFlight(s, entry);
  assert.equal(s.get("llmInFlight").r1.outcome, "PENDING");
  assert.equal(s.get("llmInFlight").r1.visibleResponsePending, false);
  assert.equal(await setVisibleResponsePending(s, "r1", true), true);
  assert.equal(s.get("llmInFlight").r1.visibleResponsePending, true);
  await finalizeAuditLog(s, { ...entry, outcome: "PUBLISHED" });
  assert.deepEqual(s.get("llmInFlight"), {});

  const log = getLlmLog(s);
  assert.equal(log.length, 1);
  assert.equal(log[0].id, "r1");
  assert.equal(log[0].auditRequestId, "r1");
  assert.equal(log[0].outcome, "PUBLISHED");
  assert.equal(log[0].responseContextDriftMessages, null);
  assert.equal(log[0].humanMessageCountAtCompletion, null);
  assert.ok(log[0].totalLatencyMs >= 0);
});

test("a delayed whole-map write from request B cannot resurrect terminal request A", async () => {
  const values = new Map([["llmInFlight", {}]]);
  let delayInFlightWrite = false;
  let delayedInFlightValue = null;
  const s = {
    get: (key) => values.get(key),
    set: (key, value) => {
      const snapshot = structuredClone(value);
      if (delayInFlightWrite && key === "llmInFlight") {
        delayedInFlightValue = snapshot;
        values.set(key, snapshot);
        return;
      }
      values.set(key, snapshot);
    },
  };
  const a = { auditRequestId: "A", serverInstanceId: "same-process", outcome: "PENDING" };
  const b = { auditRequestId: "B", serverInstanceId: "same-process", outcome: "PENDING" };

  await beginInFlight(s, a);
  await beginInFlight(s, b);

  // Model Empirica's optimistic local Attribute update followed by a delayed
  // Tajriba echo of B's stale full-map snapshot.
  delayInFlightWrite = true;
  await setVisibleResponsePending(s, "B", true);
  delayInFlightWrite = false;

  await finalizeAuditLog(s, { ...a, outcome: "PUBLISHED", messageAdded: true });
  values.set("llmInFlight", delayedInFlightValue);
  await finalizeAuditLog(s, { ...b, outcome: "PUBLISHED", messageAdded: true });

  assert.deepEqual(s.get("llmInFlight"), {});
  assert.deepEqual(s.get("llmLogIndex"), ["A", "B"]);
});

test("per-game lifecycle commits remain ordered while an earlier Empirica flush is pending", async () => {
  const s = { ...store(), id: "ordered-flush-game" };
  const a = { auditRequestId: "ordered-A", serverInstanceId: "same-process", outcome: "PENDING" };
  const b = { auditRequestId: "ordered-B", serverInstanceId: "same-process", outcome: "PENDING" };
  await Promise.all([beginInFlight(s, a), beginInFlight(s, b)]);

  const firstFlushEntered = deferred();
  const releaseFirstFlush = deferred();
  const visibilityUpdate = setVisibleResponsePending(s, b.auditRequestId, true, async () => {
    firstFlushEntered.resolve();
    await releaseFirstFlush.promise;
  });
  await firstFlushEntered.promise;

  let terminalFlushRan = false;
  const terminalUpdate = finalizeAuditLog(
    s,
    { ...a, outcome: "PUBLISHED", messageAdded: true },
    async () => { terminalFlushRan = true; },
  );
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(terminalFlushRan, false, "A finalization must wait for B's earlier state commit");
  assert.equal(s.get(`llmLog.${a.auditRequestId}`), undefined);

  releaseFirstFlush.resolve();
  await Promise.all([visibilityUpdate, terminalUpdate]);
  assert.deepEqual(Object.keys(s.get("llmInFlight")), [b.auditRequestId]);
  assert.equal(s.get("llmInFlight")[b.auditRequestId].visibleResponsePending, true);
  assert.equal(s.get(`llmLog.${a.auditRequestId}`).outcome, "PUBLISHED");
});

test("two overlapping requests remain independent through visibility and terminal updates", async () => {
  const s = { ...store(), id: "independent-overlap-game" };
  const a = { auditRequestId: "overlap-A", serverInstanceId: "same-process", outcome: "PENDING" };
  const b = { auditRequestId: "overlap-B", serverInstanceId: "same-process", outcome: "PENDING" };

  await Promise.all([beginInFlight(s, a), beginInFlight(s, b)]);
  await Promise.all([
    setVisibleResponsePending(s, a.auditRequestId, true),
    finalizeAuditLog(s, { ...b, outcome: "PUBLISHED", messageAdded: true }),
  ]);

  assert.deepEqual(Object.keys(s.get("llmInFlight")), [a.auditRequestId]);
  assert.equal(s.get("llmInFlight")[a.auditRequestId].visibleResponsePending, true);
  assert.equal(s.get(`llmLog.${b.auditRequestId}`).outcome, "PUBLISHED");

  await finalizeAuditLog(s, { ...a, outcome: "PUBLISHED", messageAdded: true });
  assert.deepEqual(s.get("llmInFlight"), {});
  assert.deepEqual(new Set(s.get(LLM_LOG_INDEX_KEY)), new Set([a.auditRequestId, b.auditRequestId]));
  assert.equal(s.get(LLM_LOG_INDEX_KEY).length, 2);
});

test("automatic coordination is exclusive while participant-requested lifecycles remain independent", async () => {
  const s = { ...store(), id: "automatic-coordination-game" };
  const first = { auditRequestId: "automatic-A", outcome: "PENDING" };
  const second = { auditRequestId: "automatic-B", outcome: "PENDING" };
  const requested = { auditRequestId: "requested-C", participantRequested: true, outcome: "PENDING" };

  assert.equal(await beginInFlight(s, first, undefined, { exclusiveGroup: "AUTOMATIC_INTERVENTION" }), true);
  assert.equal(await beginInFlight(s, second, undefined, { exclusiveGroup: "AUTOMATIC_INTERVENTION" }), false);
  assert.equal(await beginInFlight(s, requested), true);
  assert.deepEqual(new Set(Object.keys(s.get("llmInFlight"))), new Set(["automatic-A", "requested-C"]));

  await finalizeAuditLog(s, { ...first, outcome: "SILENT" });
  assert.equal(await beginInFlight(s, second, undefined, { exclusiveGroup: "AUTOMATIC_INTERVENTION" }), true);
});

test("same-process recovery prunes a terminal-backed stale marker without duplicating logs or chat", async () => {
  const s = { ...store(), id: "same-process-recovery-game" };
  const chat = [{ messageId: "facilitator-existing", speakerType: "facilitator" }];
  s.set("chat_round_0", structuredClone(chat));
  const terminal = { auditRequestId: "terminal-A", serverInstanceId: "same-process", outcome: "PENDING" };
  const live = { auditRequestId: "live-B", serverInstanceId: "same-process", outcome: "PENDING" };

  await beginInFlight(s, terminal);
  await finalizeAuditLog(s, { ...terminal, outcome: "PUBLISHED", messageAdded: true });
  await beginInFlight(s, live);
  s.set("llmInFlight", {
    [terminal.auditRequestId]: { ...terminal, visibleResponsePending: false },
    [live.auditRequestId]: s.get("llmInFlight")[live.auditRequestId],
  });

  const recovered = await recoverInterruptedInFlight(s, "same-process", 1_234);
  assert.deepEqual(recovered, []);
  assert.deepEqual(Object.keys(s.get("llmInFlight")), [live.auditRequestId]);
  assert.equal(getLlmLogCount(s), 1);
  assert.equal(getLatestLlmLogEntry(s).outcome, "PUBLISHED");
  assert.deepEqual(s.get("chat_round_0"), chat);
  assert.equal(await beginInFlight(s, terminal), false, "a terminal request ID is absorbing");
  assert.equal(await setVisibleResponsePending(s, terminal.auditRequestId, true), false);
  assert.deepEqual(Object.keys(s.get("llmInFlight")), [live.auditRequestId]);
});

test("restart recovery is idempotent under overlap and never republishes Facilitator messages", async () => {
  const s = { ...store(), id: "restart-recovery-game" };
  const chat = [{ messageId: "facilitator-before-restart", speakerType: "facilitator" }];
  s.set("chat_round_0", structuredClone(chat));
  const oldA = { auditRequestId: "restart-A", serverInstanceId: "old-process", outcome: "PENDING" };
  const oldB = { auditRequestId: "restart-B", serverInstanceId: "old-process", outcome: "PENDING" };
  await Promise.all([beginInFlight(s, oldA), beginInFlight(s, oldB)]);

  const [first, second] = await Promise.all([
    recoverInterruptedInFlight(s, "new-process", 2_000),
    recoverInterruptedInFlight(s, "new-process", 2_001),
  ]);
  assert.deepEqual([first.length, second.length], [2, 0]);
  assert.deepEqual(s.get("llmInFlight"), {});
  assert.equal(getLlmLogCount(s), 2);
  assert.equal(new Set(s.get(LLM_LOG_INDEX_KEY)).size, 2);
  for (const entry of getLlmLog(s)) {
    assert.equal(entry.outcome, "INTERRUPTED_CALLBACKS_RESTART");
    assert.equal(entry.messageAdded, false);
  }
  assert.deepEqual(s.get("chat_round_0"), chat);

  await finalizeAuditLog(s, { ...oldA, outcome: "PUBLISHED", messageAdded: true });
  assert.equal(getLlmLogCount(s), 2, "a terminal retry must not duplicate the audit index");
  assert.equal(s.get(`llmLog.${oldA.auditRequestId}`).outcome, "INTERRUPTED_CALLBACKS_RESTART");
  assert.deepEqual(s.get("chat_round_0"), chat);
});

test("an index-first partial terminal write is repaired without duplicating the audit", async () => {
  const s = { ...store(), id: "partial-terminal-game" };
  s.set(LLM_LOG_INDEX_KEY, ["partial-A"]);

  await finalizeAuditLog(s, {
    auditRequestId: "partial-A",
    serverInstanceId: "same-process",
    outcome: "PUBLISHED",
    messageAdded: true,
  });

  assert.deepEqual(s.get(LLM_LOG_INDEX_KEY), ["partial-A"]);
  assert.equal(getLlmLogCount(s), 1);
  assert.equal(getLlmLog(s)[0].outcome, "PUBLISHED");
});

test("a callback-shaped non-trigger audit finalizes with a stable id and retries idempotently", async () => {
  const s = store();
  const entry = {
    auditRequestId: "game-1:0:2:1700000000000",
    id: undefined,
    timestamp: 1_700_000_000_000,
    outcome: "SILENT",
    reason: "opportunity_gate",
  };

  // This exercises finalizeAuditLog -> appendLog -> appendToAttribute. Before
  // the producer/order fix, `id: undefined` overwrote the derived id and the
  // append threw the same runtime error seen in the local Empirica game.
  const firstTerminal = await finalizeAuditLog(s, entry);
  assert.equal(getLlmLogCount(s), 1);
  assert.equal(getLatestLlmLogEntry(s).id, entry.auditRequestId);
  assert.equal(getLatestLlmLogEntry(s).auditRequestId, entry.auditRequestId);

  // Retrying finalization of the same logical event keeps the first append
  // immutable and does not duplicate its index entry.
  const retryTerminal = await finalizeAuditLog(s, { ...entry, outcome: "PUBLISHED" });
  assert.equal(getLlmLogCount(s), 1);
  assert.equal(getLatestLlmLogEntry(s).outcome, "SILENT");
  assert.deepEqual(s.get(LLM_LOG_INDEX_KEY), [entry.auditRequestId]);
  assert.equal(retryTerminal.outcome, firstTerminal.outcome);
  assert.equal(retryTerminal.auditCompletedAt, firstTerminal.auditCompletedAt);
});

test("publication-only visible-response state is independent from audit in-flight state and can always be cleared", async () => {
  const s = store();
  await beginInFlight(s, { auditRequestId: "typing", serverInstanceId: "a", outcome: "PENDING" });

  assert.equal(s.get("llmInFlight").typing.visibleResponsePending, false, "assessment starts hidden");
  assert.equal(await setVisibleResponsePending(s, "typing", true), true);
  assert.equal(s.get("llmInFlight").typing.visibleResponsePending, true, "validated publication can be participant-visible");
  assert.equal(await setVisibleResponsePending(s, "typing", false), true);
  assert.equal(s.get("llmInFlight").typing.visibleResponsePending, false, "publication completion clears typing without losing the audit entry");
  assert.equal(await setVisibleResponsePending(s, "missing", true), false, "a stale/finalized request cannot be recreated");
});

test("finalize records total latency and human-message context drift", async () => {
  const s = store();
  s.set("humanMessageCount", 9);
  const entry = { auditRequestId: "latency", serverInstanceId: "a", outcome: "PUBLISHED", timestamp: 1_000, humanMessageCount: 6 };
  await beginInFlight(s, entry);
  await finalizeAuditLog(s, entry);
  const logged = getLatestLlmLogEntry(s);
  assert.ok(logged.totalLatencyMs >= 0);
  assert.equal(logged.humanMessageCountAtCompletion, 9);
  assert.equal(logged.responseContextDriftMessages, 3);
});

test("a new callbacks instance converts stale pending requests into explicit interrupted logs", async () => {
  const s = store();
  await beginInFlight(s, { auditRequestId: "old", serverInstanceId: "old-process", outcome: "PENDING" });
  await beginInFlight(s, { auditRequestId: "live", serverInstanceId: "new-process", outcome: "PENDING" });
  await setVisibleResponsePending(s, "old", true);
  const recovered = await recoverInterruptedInFlight(s, "new-process", 1234);
  assert.equal(recovered.length, 1);
  assert.equal(recovered[0].outcome, "INTERRUPTED_CALLBACKS_RESTART");
  assert.deepEqual(Object.keys(s.get("llmInFlight")), ["live"]);

  // The recovered entry must also be visible through the new read API.
  const log = getLlmLog(s);
  assert.equal(log.length, 1);
  assert.equal(log[0].auditRequestId, "old");
  assert.equal(log[0].outcome, "INTERRUPTED_CALLBACKS_RESTART");
});

test("llmLog is stored as per-entry Attributes plus a small index, not a growing array", async () => {
  const s = store();
  const bigPayload = "x".repeat(50_000);
  for (let i = 0; i < 25; i++) {
    const requestId = `r${i.toString().padStart(4, "0")}`;
    await beginInFlight(s, { auditRequestId: requestId, serverInstanceId: "a", outcome: "PENDING" });
    await finalizeAuditLog(s, {
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
