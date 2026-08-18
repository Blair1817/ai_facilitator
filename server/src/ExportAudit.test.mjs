import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { recordExportEvent, readExportAudit } from "./ExportAudit.mjs";

function tmpFile() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "export-audit-"));
  return path.join(dir, "audit.jsonl");
}

test("recordExportEvent appends one JSON line and returns the sha256 of that line", async () => {
  const file = tmpFile();
  const record = {
    timestamp: "2026-08-18T15:00:00+08:00",
    requester: "researcher@example.com",
    sourceIp: "203.0.113.5",
    userAgent: "curl/8.0",
    endpoint: "questionnaire.csv",
    gameId: "01HXYAAAA",
    format: "csv",
    redact: true,
    sizeBytes: 12345,
    sha256: "deadbeef",
  };
  const { line, sha256 } = await recordExportEvent({ auditFile: file, record });
  assert.match(line, /^\{.*\}\n$/, "must be a single JSON line with trailing newline");
  assert.equal(sha256.length, 64, "sha256 hex digest is 64 chars");
  const onDisk = fs.readFileSync(file, "utf8");
  assert.equal(onDisk, line);
});

test("recordExportEvent appends across multiple calls (line per request)", async () => {
  const file = tmpFile();
  await recordExportEvent({
    auditFile: file,
    record: { endpoint: "list-batches", format: "json", redact: false },
  });
  await recordExportEvent({
    auditFile: file,
    record: { endpoint: "bundle.zip", gameId: "01HXY", format: "zip", redact: true, sizeBytes: 5000, sha256: "ab" },
  });
  const lines = fs.readFileSync(file, "utf8").split("\n").filter(Boolean);
  assert.equal(lines.length, 2);
  assert.match(lines[0], /"endpoint":"list-batches"/);
  assert.match(lines[1], /"endpoint":"bundle\.zip"/);
});

test("recordExportEvent coerces missing fields and bounds string lengths", async () => {
  const file = tmpFile();
  await recordExportEvent({
    auditFile: file,
    record: {
      endpoint: "transcript.md",
      format: "markdown",
      // requester omitted; should fall back to "unknown"
      // userAgent long; should be truncated
      userAgent: "x".repeat(2000),
      // gameId non-string; should fall back to null
      gameId: 42,
    },
  });
  const onDisk = JSON.parse(fs.readFileSync(file, "utf8"));
  assert.equal(onDisk.requester, "unknown");
  assert.ok(onDisk.userAgent.length <= 1024, "userAgent must be bounded");
  assert.equal(onDisk.gameId, null, "non-string gameId must be coerced to null");
  assert.equal(onDisk.redact, false, "redact defaults to false when missing");
  assert.equal(onDisk.sizeBytes, null, "sizeBytes defaults to null when missing");
});

test("recordExportEvent strips newlines from free-form strings (audit-log safety)", async () => {
  const file = tmpFile();
  await recordExportEvent({
    auditFile: file,
    record: {
      endpoint: "list-batches",
      requester: "evil\ninjection",
      userAgent: "ua\r\nfake",
      format: "json",
    },
  });
  const onDisk = fs.readFileSync(file, "utf8");
  assert.equal(onDisk.split("\n").filter(Boolean).length, 1, "no extra line breaks introduced");
  assert.ok(!onDisk.includes("injection\n"), "newline removed from requester");
});

test("recordExportEvent rejects an invalid timestamp", async () => {
  const file = tmpFile();
  await assert.rejects(
    () => recordExportEvent({ auditFile: file, record: { timestamp: "not-a-date", endpoint: "x", format: "json" } }),
    /timestamp/,
  );
});

test("readExportAudit parses all valid lines and counts malformed ones", async () => {
  const file = tmpFile();
  fs.writeFileSync(
    file,
    [
      JSON.stringify({ schema: 1, timestamp: "2026-08-18T15:00:00+08:00", endpoint: "list-batches", format: "json" }),
      "not-a-json-line",
      JSON.stringify({ schema: 1, timestamp: "2026-08-18T15:01:00+08:00", endpoint: "bundle.zip", format: "zip" }),
      "",
    ].join("\n"),
  );
  const { records, warnings } = await readExportAudit(file);
  assert.equal(records.length, 2);
  assert.equal(warnings, 1);
});

test("readExportAudit returns empty for a missing file (treat as fresh state, not an error)", async () => {
  const file = path.join(os.tmpdir(), `export-audit-missing-${Date.now()}.jsonl`);
  const { records, warnings } = await readExportAudit(file);
  assert.deepEqual(records, []);
  assert.equal(warnings, 0);
});
