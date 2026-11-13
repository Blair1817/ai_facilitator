import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { ExportMetadataIndex, ExportMetadataUnavailable } from "./ExportMetadataIndex.mjs";

const headers = [{ version: "v1.12.0" }, { version: 0, format: "JSON", compression: "NoCompression" }];
const scope = (id, kind) => ({ kind: "Scope", obj: { id, kind, createdAt: "2026-11-12T10:00:00Z" } });
const attr = (nodeID, key, value, extra = {}) => ({ kind: "Attribute", obj: {
  id: `${nodeID}-${key}`, nodeID, key, val: JSON.stringify(value), ...extra,
} });
const encode = events => events.map(event => JSON.stringify(event)).join("\n") + "\n";

function fixture(t, events = []) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "export-metadata-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, "tajriba.json");
  fs.writeFileSync(file, encode([...headers, scope("B1", "batch"), scope("G1", "game"),
    scope("P1", "player"), attr("B1", "status", "running"), attr("G1", "batchID", "B1"),
    attr("P1", "gameID", "G1"), ...events]));
  return { file, index: new ExportMetadataIndex({ file }) };
}

function values(snapshot, id) {
  return Object.fromEntries(snapshot.scopes.find(s => s.id === id).attributes.map(a => [a.key, JSON.parse(a.val)]));
}

test("index retains only listing metadata, replays latest scalars, and never writes the source", async t => {
  const { file, index } = fixture(t, [
    attr("G1", "status", "running"), attr("G1", "status", "ended"),
    attr("G1", "sequenceId", "S1"), attr("G1", "sequenceId", null, { deletedAt: "2026-11-12T11:00:00Z" }),
    attr("G1", "treatment", { name: "main" }),
    attr("G1", "chat_round_0", { text: "CHAT SECRET" }, { index: 0, vector: true }),
    attr("G1", "llmLog.audit", { response: "LLM SECRET" }),
    attr("P1", "name", "NAME SECRET"), attr("P1", "finalQuestions", { text: "FORM SECRET" }),
    scope("R1", "round"), attr("R1", "status", "ROUND SECRET"),
  ]);
  const digest = () => createHash("sha256").update(fs.readFileSync(file)).digest("hex");
  const before = digest();
  const snapshot = await index.read();
  assert.equal(digest(), before);
  assert.deepEqual(values(snapshot, "G1"), { batchID: "B1", status: "ended", treatment: { name: "main" } });
  assert.deepEqual(values(snapshot, "P1"), { gameID: "G1" });
  assert.equal(snapshot.scopes.length, 3);
  assert.doesNotMatch(JSON.stringify(snapshot), /CHAT SECRET|LLM SECRET|NAME SECRET|FORM SECRET|ROUND SECRET/);
  assert.equal(snapshot.metadata.source, "read-only-store-index");
  assert.equal(snapshot.metadata.pendingTail, false);
});

test("refresh reads only appended bytes and returns new games and updated metadata", async t => {
  const { file, index } = fixture(t);
  const first = await index.read();
  const nextEvents = encode([scope("G2", "game"), attr("G2", "batchID", "B1"), attr("G1", "status", "ended")]);
  fs.appendFileSync(file, nextEvents);
  const second = await index.read();
  assert.equal(second.metadata.bytesRead, Buffer.byteLength(nextEvents));
  assert.equal(second.scopes.filter(s => s.kind === "game").length, 2);
  assert.equal(values(second, "G1").status, "ended");
  assert.equal(values(first, "G1").status, undefined, "previous snapshots are immutable views");
  assert.equal((await index.read()).metadata.bytesRead, 0);
});

test("partial live JSONL tail is not applied until its newline arrives, including split UTF-8", async t => {
  const { file, index } = fixture(t);
  await index.read();
  const line = Buffer.from(encode([attr("G1", "treatmentName", "正式测试")]));
  const split = line.indexOf(Buffer.from("正式")) + 1;
  fs.appendFileSync(file, line.subarray(0, split));
  const partial = await index.read();
  assert.equal(partial.metadata.pendingTail, true);
  assert.equal(values(partial, "G1").treatmentName, undefined);
  fs.appendFileSync(file, line.subarray(split));
  const complete = await index.read();
  assert.equal(complete.metadata.pendingTail, false);
  assert.equal(values(complete, "G1").treatmentName, "正式测试");
});

test("rotation, truncation and same-size rewrites rebuild instead of mixing stores", async t => {
  const { file, index } = fixture(t);
  await index.read();
  const replacement = encode([...headers, scope("B2", "batch"), attr("B2", "status", "created")]);
  const renamed = `${file}.new`;
  fs.writeFileSync(renamed, replacement);
  fs.renameSync(renamed, file);
  assert.deepEqual((await index.read()).scopes.map(s => s.id), ["B2"]);
  fs.writeFileSync(file, replacement.replaceAll("B2", "B3"));
  assert.deepEqual((await index.read()).scopes.map(s => s.id), ["B3"]);
  fs.writeFileSync(file, encode([...headers, scope("B4", "batch")]));
  assert.deepEqual((await index.read()).scopes.map(s => s.id), ["B4"]);
});

test("malformed or unsupported data fails closed without exposing values or a partial index", async t => {
  const { file, index } = fixture(t);
  await index.read();
  fs.appendFileSync(file, encode([scope("G2", "game")]) + "{SECRET MALFORMED\n");
  await assert.rejects(index.read(), error => error instanceof ExportMetadataUnavailable && !/SECRET/.test(error.message));
  fs.writeFileSync(file, encode([{ version: "future" }, { version: 1, format: "JSON", compression: "NoCompression" }]));
  await assert.rejects(index.read(), ExportMetadataUnavailable);
  fs.unlinkSync(file);
  await assert.rejects(index.read(), error => error instanceof ExportMetadataUnavailable && !error.message.includes(file));
});

test("bounded record reads handle large audit values and more than 2000 unrelated attributes", async t => {
  const events = Array.from({ length: 2100 }, (_, i) => attr("G1", `llmLog.${i}`, { text: "PRIVATE" }));
  events.push(attr("G1", "chat_round_0", "x".repeat(256 * 1024), { index: 0 }), attr("G1", "status", "ended"));
  const { file, index } = fixture(t, events);
  const snapshot = await index.read();
  assert.equal(values(snapshot, "G1").status, "ended");
  assert.ok(JSON.stringify(snapshot).length < 5000);
  assert.equal(snapshot.metadata.bytesRead, fs.statSync(file).size);
});

test("aborted reads do not poison later requests or return a partial listing", async t => {
  const { index } = fixture(t);
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(index.read({ signal: controller.signal }), { name: "AbortError" });
  const snapshots = await Promise.all([index.read(), index.read()]);
  assert.equal(snapshots[0].scopes.length, 3);
  assert.equal(snapshots[1].metadata.bytesRead, 0);
});

test("a large journal builds and refreshes under a 64 MiB V8 heap limit", async t => {
  const { file } = fixture(t);
  const fd = fs.openSync(file, "a");
  try {
    for (let i = 0; i < 96; i++) {
      fs.writeSync(fd, encode([attr("G1", `llmLog.${i}`, { text: "x".repeat(768 * 1024) })]));
    }
  } finally { fs.closeSync(fd); }
  const script = `
    const { ExportMetadataIndex } = await import(process.argv[2]);
    const index = new ExportMetadataIndex({ file: process.argv[1] });
    const first = await index.read();
    const next = await index.read();
    console.log(JSON.stringify({ scopes: first.scopes.length, bytesRead: first.metadata.bytesRead,
      nextBytesRead: next.metadata.bytesRead, retainedBytes: JSON.stringify(next).length }));
  `;
  const result = JSON.parse(execFileSync(process.execPath,
    ["--max-old-space-size=64", "--input-type=module", "-e", script, file, new URL("./ExportMetadataIndex.mjs", import.meta.url).href],
    { encoding: "utf8", timeout: 30_000 }));
  assert.ok(result.bytesRead > 72 * 1024 * 1024);
  assert.equal(result.scopes, 3);
  assert.equal(result.nextBytesRead, 0);
  assert.ok(result.retainedBytes < 5000);
});

test("oversized metadata or records fail safely rather than silently losing fields", async t => {
  const { file, index } = fixture(t, [attr("G1", "treatment", "x".repeat(65 * 1024))]);
  await assert.rejects(index.read(), ExportMetadataUnavailable);
  fs.writeFileSync(file, encode([...headers, scope("G1", "game"), attr("G1", "llmLog.big", "x".repeat(10 * 1024 * 1024))]));
  await assert.rejects(index.read(), ExportMetadataUnavailable);
});

test("the checked-in Tajriba format-0 example can be indexed without altering it", async () => {
  const file = new URL("../../utils/example_grail_data/tajriba.json", import.meta.url);
  const before = createHash("sha256").update(fs.readFileSync(file)).digest("hex");
  const snapshot = await new ExportMetadataIndex({ file: fileURLToPath(file) }).read();
  assert.ok(snapshot.scopes.some(s => s.kind === "batch"));
  assert.ok(snapshot.scopes.some(s => s.kind === "game"));
  assert.ok(snapshot.scopes.some(s => s.kind === "player"));
  assert.equal(createHash("sha256").update(fs.readFileSync(file)).digest("hex"), before);
});
