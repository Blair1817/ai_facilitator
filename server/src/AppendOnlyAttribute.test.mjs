import assert from "node:assert/strict";
import test from "node:test";
import {
  appendToAttribute,
  readAppendOnlyAttribute,
  ensureAppendOnlyAttribute,
  _internal,
} from "./AppendOnlyAttribute.mjs";

function makeStore() {
  const values = new Map();
  return {
    get: (k) => values.get(k),
    set: (k, v) => values.set(k, v),
    _values: values,
  };
}

test("appendToAttribute stores a per-entry attribute and a small index", () => {
  const s = makeStore();
  appendToAttribute(s, "llmLog", { id: "r1", outcome: "PUBLISHED" });

  assert.equal(s._values.size, 2, "one per-entry attr + one index");
  assert.deepEqual(s.get("llmLog.r1"), { id: "r1", outcome: "PUBLISHED" });
  assert.deepEqual(s.get("llmLogIndex"), ["r1"]);
});

test("readAppendOnlyAttribute returns entries in append order", () => {
  const s = makeStore();
  appendToAttribute(s, "llmLog", { id: "r1", outcome: "PUBLISHED" });
  appendToAttribute(s, "llmLog", { id: "r2", outcome: "SILENT" });
  appendToAttribute(s, "llmLog", { id: "r3", outcome: "INTERRUPTED" });

  const got = readAppendOnlyAttribute(s, "llmLog");
  assert.equal(got.length, 3);
  assert.deepEqual(got.map((e) => e.id), ["r1", "r2", "r3"]);
  assert.deepEqual(got.map((e) => e.outcome), ["PUBLISHED", "SILENT", "INTERRUPTED"]);
});

test("readAppendOnlyAttribute tolerates an empty / missing index", () => {
  const s = makeStore();
  assert.deepEqual(readAppendOnlyAttribute(s, "llmLog"), []);
  s.set("llmLogIndex", "not-an-array");
  assert.deepEqual(readAppendOnlyAttribute(s, "llmLog"), []);
  s.set("llmLogIndex", null);
  assert.deepEqual(readAppendOnlyAttribute(s, "llmLog"), []);
});

test("readAppendOnlyAttribute skips index entries whose payload is missing", () => {
  const s = makeStore();
  s.set("llmLogIndex", ["r1", "r2-missing", "r3"]);
  s.set("llmLog.r1", { id: "r1", outcome: "PUBLISHED" });
  s.set("llmLog.r3", { id: "r3", outcome: "SILENT" });

  const got = readAppendOnlyAttribute(s, "llmLog");
  assert.equal(got.length, 2);
  assert.deepEqual(got.map((e) => e.id), ["r1", "r3"]);
});

test("appendToAttribute rejects entries without an id", () => {
  const s = makeStore();
  assert.throws(() => appendToAttribute(s, "llmLog", { outcome: "PUBLISHED" }), /id/);
  assert.throws(() => appendToAttribute(s, "llmLog", null), /object/);
});

test("ensureAppendOnlyAttribute is idempotent and preserves existing data", () => {
  const s = makeStore();
  ensureAppendOnlyAttribute(s, "llmLog");
  ensureAppendOnlyAttribute(s, "llmLog");
  assert.deepEqual(s.get("llmLogIndex"), []);

  appendToAttribute(s, "llmLog", { id: "r1", outcome: "PUBLISHED" });
  ensureAppendOnlyAttribute(s, "llmLog");
  assert.deepEqual(s.get("llmLogIndex"), ["r1"], "must not reset existing index");
});

test("regression: 5000 large entries keep each Attribute line bounded", () => {
  // Simulate the worst case: a single entry carrying a 200 KB agentState
  // payload (the largest real entry shape we see in the audit pipeline).
  // Before the fix, appending these to a single `llmLog` array would
  // produce one Attribute line of size O(N^2) and overflow the scanner
  // well before N=5000. After the fix, each line must stay bounded by
  // the size of one entry plus a small per-entry id.
  const s = makeStore();
  const bigText = "x".repeat(200_000); // 200 KB
  const N = 5_000;

  let maxEntryLine = 0;
  let maxIndexLine = 0;

  for (let i = 0; i < N; i++) {
    const id = `r${i.toString(36).padStart(6, "0")}`;
    const entry = { id, outcome: "PUBLISHED", payload: bigText };
    appendToAttribute(s, "llmLog", entry);

    // Approximate the on-disk JSONL line size for the entry Attribute.
    // Empirica writes the value as JSON; the line also includes a small
    // envelope. We measure the JSON of the value plus a generous overhead.
    const entryLineApprox = JSON.stringify(entry).length + 200;
    if (entryLineApprox > maxEntryLine) maxEntryLine = entryLineApprox;
  }
  // The index contains one id per entry, so its JSON length is O(N * idLen).
  const indexApprox = JSON.stringify(s.get("llmLogIndex")).length + 200;
  maxIndexLine = indexApprox;

  // Hard ceiling: each line must stay well under the ~1 MB limit that
  // Tajriba's Go bufio.Scanner accepts by default. We require < 1.5 MB
  // on the entry line and < 1.5 MB on the index even at N=5000.
  assert.ok(
    maxEntryLine < 1_500_000,
    `entry line too large: ${maxEntryLine} bytes (would break bufio.Scanner)`,
  );
  // The index at 5000 ids stays under ~250 KB, well within the budget.
  assert.ok(
    maxIndexLine < 1_500_000,
    `index line too large: ${maxIndexLine} bytes after ${N} appends`,
  );

  // And the read API still works.
  const all = readAppendOnlyAttribute(s, "llmLog");
  assert.equal(all.length, N);
  assert.equal(all[0].id, "r000000");
  assert.equal(all[N - 1].id, `r${(N - 1).toString(36).padStart(6, "0")}`);
});

test("internal key naming is stable and namespaced", () => {
  // If these change, on-disk Tajriba data from previous pilots will not
  // round-trip through the new reader. Lock the contract.
  assert.equal(_internal.indexKey("llmLog"), "llmLogIndex");
  assert.equal(_internal.entryKey("llmLog", "r1"), "llmLog.r1");
  assert.equal(_internal.indexKey("operationalEvents"), "operationalEventsIndex");
  assert.equal(_internal.entryKey("operationalEvents", "t-1"), "operationalEvents.t-1");
});
