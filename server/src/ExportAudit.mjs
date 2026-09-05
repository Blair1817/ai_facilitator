/**
 * ExportAudit.mjs
 *
 * Append-only JSONL audit log for every research-data download served
 * by the export pipeline. One line per request, written via `O_APPEND`
 * so concurrent writers cannot interleave on the same line. The file is
 * intentionally outside the Tajriba JSONL so a Tajriba cleanup script
 * that walks the Empirica event log (D-011) cannot touch it. Backup
 * `scripts/backup-tajriba.sh` is extended to also copy this file.
 *
 * Each record captures:
 *   - timestamp (ISO 8601, server clock, UTC offset included)
 *   - requester (the authenticated Export Basic Auth username)
 *   - sourceIp (best-effort; "unknown" if the proxy did not pass it)
 *   - userAgent (best-effort)
 *   - endpoint ("list-batches" | "list-games" | "questionnaire.csv" |
 *              "transcript.md" | "bundle.zip" | ...)
 *   - filter (JSON of the query-string filter; null for unfiltered)
 *   - gameId (for per-game endpoints; null for list endpoints)
 *   - batchId (for list-games; null otherwise)
 *   - format ("csv" | "markdown" | "zip" | "json" | "html")
 *   - redact (boolean: was the redactPII pipeline applied?)
 *   - sizeBytes (response size; null for HTML pages where the size is
 *                not known at request time)
 *   - sha256 (hex digest of the response body; null for HTML pages)
 *
 * The audit file is readable, append-only, and intentionally small. The
 * only side effect of recording a request is one `fs.write` syscall.
 * No external services are called.
 */

import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

/**
 * Append a single audit record to `auditFile`. The record is JSON-encoded
 * with a trailing newline; the open uses `O_APPEND | O_CREAT | O_WRONLY`
 * so concurrent writers do not clobber each other.
 *
 * @param {Object} args
 * @param {string} args.auditFile     absolute path of the JSONL file
 * @param {Object} args.record        fields described in the file header
 * @returns {Promise<{line: string, sha256: string}>} the persisted line
 *                                          and its content hash (audit
 *                                          chain anchor for the entry)
 */
export async function recordExportEvent({ auditFile, record }) {
  if (!auditFile) {
    throw new Error("recordExportEvent: auditFile is required");
  }
  const normalised = normaliseRecord(record);
  const line = JSON.stringify(normalised) + "\n";

  await fs.promises.mkdir(path.dirname(auditFile), { recursive: true });
  await fs.promises.appendFile(auditFile, line, { flag: "a" });

  return { line, sha256: createHash("sha256").update(line).digest("hex") };
}

function normaliseRecord(record) {
  if (!record || typeof record !== "object") {
    throw new Error("recordExportEvent: record must be an object");
  }
  const ts = record.timestamp ?? new Date().toISOString();
  if (typeof ts !== "string" || Number.isNaN(Date.parse(ts))) {
    throw new Error("recordExportEvent: timestamp must be a valid ISO 8601 string");
  }
  return {
    schema: 1,
    timestamp: ts,
    requester: sanitiseString(record.requester, 256, "unknown"),
    sourceIp: sanitiseString(record.sourceIp, 64, "unknown"),
    userAgent: sanitiseString(record.userAgent, 1024, "unknown"),
    endpoint: sanitiseString(record.endpoint, 128, "unknown"),
    filter: record.filter == null ? null : truncateForLog(record.filter),
    gameId: record.gameId == null ? null : sanitiseString(record.gameId, 64, null),
    batchId: record.batchId == null ? null : sanitiseString(record.batchId, 64, null),
    format: sanitiseString(record.format, 32, "unknown"),
    redact: Boolean(record.redact),
    sizeBytes: numberOrNull(record.sizeBytes),
    sha256: record.sha256 == null ? null : sanitiseString(record.sha256, 64, null),
  };
}

function sanitiseString(value, max, fallback) {
  if (value == null) return fallback;
  if (typeof value !== "string") return fallback;
  const trimmed = value.replace(/[\r\n\t]+/g, " ").trim();
  if (trimmed.length === 0) return fallback;
  return trimmed.length > max ? trimmed.slice(0, max) : trimmed;
}

function truncateForLog(value) {
  // The filter object is rendered in the audit log so a researcher can
  // see which filter produced a given download. Cap the rendered JSON
  // at a safe size; deep objects are stringified and sliced.
  try {
    const rendered = JSON.stringify(value);
    if (rendered.length <= 1024) return JSON.parse(rendered);
    return { _truncated: rendered.slice(0, 1024) + "…" };
  } catch {
    return { _unserialisable: true };
  }
}

function numberOrNull(value) {
  if (value == null) return null;
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 ? Math.trunc(n) : null;
}

/**
 * Read the audit file and return one parsed object per line. Empty or
 * malformed lines are skipped (with a `warnings` count returned alongside
 * the records so the caller can surface the issue without losing data).
 *
 * @param {string} auditFile
 * @returns {Promise<{records: Array<Object>, warnings: number}>}
 */
export async function readExportAudit(auditFile) {
  if (!auditFile) {
    throw new Error("readExportAudit: auditFile is required");
  }
  let raw;
  try {
    raw = await fs.promises.readFile(auditFile, "utf8");
  } catch (error) {
    if (error.code === "ENOENT") return { records: [], warnings: 0 };
    throw error;
  }
  const records = [];
  let warnings = 0;
  for (const line of raw.split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      records.push(JSON.parse(line));
    } catch {
      warnings += 1;
    }
  }
  return { records, warnings };
}
