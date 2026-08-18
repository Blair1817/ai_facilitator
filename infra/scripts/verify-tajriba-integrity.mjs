#!/usr/bin/env node

import fs from "node:fs";
import { pathToFileURL } from "node:url";

const ULID_LIKE = /^01[A-Z0-9]+$/;
const REFERENCE_FIELDS = new Set([
  "actorID",
  "createdByID",
  "nodeID",
  "nodeAID",
  "nodeBID",
  "participantID",
]);

function referencedAttributeValue(value) {
  if (typeof value !== "string") {
    return undefined;
  }

  let candidate = value;
  try {
    const decoded = JSON.parse(value);
    if (typeof decoded === "string") {
      candidate = decoded;
    }
  } catch {
    // Tajriba attributes may also contain an unquoted scalar string.
  }

  return ULID_LIKE.test(candidate) ? candidate : undefined;
}

export function verifyTajribaText(text) {
  const events = [];
  const parseErrors = [];

  text.split(/\r?\n/).forEach((line, index) => {
    if (!line.trim()) {
      return;
    }
    try {
      const parsed = JSON.parse(line);
      if (parsed && typeof parsed === "object" && parsed.kind && parsed.obj) {
        events.push({ ...parsed, lineNumber: index + 1 });
      }
    } catch {
      parseErrors.push(index + 1);
    }
  });

  const knownIds = new Set();
  for (const event of events) {
    const id = event.obj?.id;
    if (typeof id === "string") {
      knownIds.add(id);
    }
  }

  const references = [];
  for (const event of events) {
    for (const [field, value] of Object.entries(event.obj ?? {})) {
      if (REFERENCE_FIELDS.has(field) && typeof value === "string" && ULID_LIKE.test(value)) {
        references.push({ value, kind: event.kind, field, lineNumber: event.lineNumber });
      }
    }

    if (event.kind === "Attribute") {
      const value = referencedAttributeValue(event.obj?.val);
      if (value) {
        references.push({
          value,
          kind: event.kind,
          field: "val",
          lineNumber: event.lineNumber,
        });
      }
    }
  }

  const dangling = references.filter(({ value }) => !knownIds.has(value));
  return {
    eventCount: events.length,
    knownIdCount: knownIds.size,
    referenceCount: references.length,
    parseErrors,
    dangling,
  };
}

export function verifyTajribaFile(filePath) {
  return verifyTajribaText(fs.readFileSync(filePath, "utf8"));
}

function main() {
  const filePath = process.argv[2];
  if (!filePath) {
    console.error("FATAL: usage: verify-tajriba-integrity.mjs <tajriba.json>");
    process.exitCode = 2;
    return;
  }

  let result;
  try {
    result = verifyTajribaFile(filePath);
  } catch (error) {
    console.error(`FATAL: unable to read Tajriba store: ${error.code ?? "read error"}`);
    process.exitCode = 2;
    return;
  }

  console.log(
    `[tajriba-integrity] events=${result.eventCount} ids=${result.knownIdCount} ` +
      `references=${result.referenceCount} parseErrors=${result.parseErrors.length} ` +
      `dangling=${result.dangling.length}`,
  );

  if (result.parseErrors.length > 0) {
    console.error(
      `[tajriba-integrity] FATAL: invalid JSONL at line(s) ${result.parseErrors.join(", ")}`,
    );
    process.exitCode = 1;
    return;
  }

  if (result.dangling.length > 0) {
    // Report structural locations only. Do not print participant or entity IDs.
    const locations = result.dangling
      .slice(0, 10)
      .map(({ kind, field, lineNumber }) => `${kind}.${field}@${lineNumber}`)
      .join(", ");
    console.error(
      `[tajriba-integrity] FATAL: dangling references detected (${locations}). ` +
        "Refusing to start Empirica; restore or repair the store from a verified backup.",
    );
    process.exitCode = 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
