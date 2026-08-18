#!/usr/bin/env node
/**
 * server/src/cli/export.mjs
 *
 * Command-line driver for the ExportService. Three use cases:
 *
 *   1. Automation / cron / scripts that need a known file path
 *      (`node server/src/cli/export.mjs export <gameId> csv <out>`).
 *   2. SSH-into-NAS triage: "what batches ran last week?"
 *      (`node server/src/cli/export.mjs list-batches --from=...`).
 *   3. Backups: `node server/src/cli/export.mjs export-batch <batchId> <dir>`
 *      writes one bundle per game in the batch.
 *
 * The CLI reuses `ExportService` for the actual data access so there
 * is exactly one implementation of "what does the questionnaire CSV
 * look like" in the repo. The HTTP server (ExportServer.mjs) and the
 * CLI call the same `ExportService` methods.
 *
 * Auth: the Tajriba admin session token (srtoken) is read from
 *   1. the `--srtoken` flag, or
 *   2. the `TAJRIBA_SRTOKEN` environment variable, or
 *   3. the `srtoken` field of the operator config file
 *      (path: `--config <file>` or `$TAJRIBA_CONFIG`).
 *
 * The endpoint defaults to `http://127.0.0.1:3000/query`, which is
 * what `empirica serve` listens on inside the container. Override
 * with `--url` or `TAJRIBA_URL`.
 *
 * Redaction is on by default; pass `--raw` to skip it. The choice is
 * echoed in the audit record (also written by this CLI, mirroring
 * the HTTP server's behaviour).
 */

import fs from "node:fs";
import path from "node:path";

import { ExportService, ExportNotFoundError } from "../ExportService.mjs";
import { recordExportEvent } from "../ExportAudit.mjs";

const USAGE = `Usage:
  node server/src/cli/export.mjs list-batches [--from=ISO] [--to=ISO] [--status=created|running|ended] [--raw]
  node server/src/cli/export.mjs list-games <batchId> [--from=ISO] [--to=ISO] [--treatment=...] [--sequence=...] [--status=...] [--limit=N] [--offset=N] [--raw]
  node server/src/cli/export.mjs export <gameId> csv|markdown|zip <outPath> [--raw]
  node server/src/cli/export.mjs export-batch <batchId> <outDir> [--raw]
`;

function parseArgs(argv) {
  const out = { positional: [], flags: {} };
  for (const arg of argv) {
    if (arg.startsWith("--")) {
      const eq = arg.indexOf("=");
      if (eq === -1) out.flags[arg.slice(2)] = true;
      else out.flags[arg.slice(2, eq)] = arg.slice(eq + 1);
    } else {
      out.positional.push(arg);
    }
  }
  return out;
}

function readSrtoken({ flags }) {
  if (typeof flags.srtoken === "string" && flags.srtoken.length > 0) return flags.srtoken;
  if (process.env.TAJRIBA_SRTOKEN) return process.env.TAJRIBA_SRTOKEN;
  const configPath = flags.config || process.env.TAJRIBA_CONFIG;
  if (configPath && fs.existsSync(configPath)) {
    const text = fs.readFileSync(configPath, "utf8");
    const m = text.match(/^srtoken\s*=\s*"([^"]+)"$/m);
    if (m) return m[1];
  }
  return null;
}

function endpoint({ flags }) {
  return flags.url || process.env.TAJRIBA_URL || "http://127.0.0.1:3000/query";
}

function auditFileFromFlags() {
  return process.env.EXPORT_AUDIT_FILE || "/data/export-audit.jsonl";
}

async function connectAdmin(url, srtoken) {
  // Use @empirica/tajriba directly so the CLI and the HTTP server share
  // the same wire protocol. The lib exports a `Tajriba` class with
  // `registerService` and `sessionAdmin`; `scopes(...)` matches what
  // ExportService expects on its admin connection.
  const { Tajriba } = await import("@empirica/tajriba");
  const taj = await Tajriba.createAndAwait(url);
  taj.useHTTP = true;
  const sessionToken = await taj.registerService("export-cli", srtoken);
  const admin = await taj.sessionAdmin(sessionToken);
  return {
    scopes: async (args) => admin.scopes(args),
    stop: () => taj.stop(),
  };
}

function redactFromFlags(flags) {
  return flags.raw !== true;
}

async function main() {
  const argv = process.argv.slice(2);
  if (argv.length === 0 || argv[0] === "--help" || argv[0] === "-h") {
    process.stdout.write(USAGE);
    return 0;
  }
  const cmd = argv[0];
  const parsed = parseArgs(argv.slice(1));
  const srtoken = readSrtoken(parsed);
  if (!srtoken) {
    process.stderr.write("FATAL: Tajriba srtoken not provided (use --srtoken, TAJRIBA_SRTOKEN, or --config)\n");
    return 2;
  }
  const url = endpoint(parsed);
  const admin = await connectAdmin(url, srtoken);
  const auditFile = auditFileFromFlags();
  const svc = new ExportService({ admin, auditFile, defaultRedact: !redactFromFlags(parsed.flags) });

  try {
    switch (cmd) {
      case "list-batches":
        return await cmdListBatches(svc, parsed.flags, auditFile);
      case "list-games":
        return await cmdListGames(svc, parsed.positional[0], parsed.flags, auditFile);
      case "export":
        return await cmdExport(svc, parsed.positional, parsed.flags, auditFile);
      case "export-batch":
        return await cmdExportBatch(svc, parsed.positional, parsed.flags, auditFile);
      default:
        process.stderr.write(`Unknown command: ${cmd}\n${USAGE}`);
        return 2;
    }
  } finally {
    if (typeof admin.stop === "function") admin.stop();
  }
}

async function cmdListBatches(svc, flags, auditFile) {
  const filter = {
    fromISO: typeof flags.from === "string" ? flags.from : undefined,
    toISO: typeof flags.to === "string" ? flags.to : undefined,
    status: typeof flags.status === "string" ? flags.status : undefined,
  };
  const items = await svc.listBatches(filter);
  process.stdout.write(JSON.stringify(items, null, 2) + "\n");
  await recordExportEvent({
    auditFile,
    record: {
      endpoint: "cli.list-batches",
      format: "json",
      redact: !flags.raw,
      filter,
    },
  });
  return 0;
}

async function cmdListGames(svc, batchId, flags, auditFile) {
  if (!batchId) {
    process.stderr.write("FATAL: list-games requires <batchId>\n");
    return 2;
  }
  const filter = {
    fromISO: typeof flags.from === "string" ? flags.from : undefined,
    toISO: typeof flags.to === "string" ? flags.to : undefined,
    treatment: typeof flags.treatment === "string" ? flags.treatment : undefined,
    sequenceId: typeof flags.sequence === "string" ? flags.sequence : undefined,
    status: typeof flags.status === "string" ? flags.status : undefined,
    limit: numberOrDefault(flags.limit, 100),
    offset: numberOrDefault(flags.offset, 0),
  };
  const result = await svc.listGames(batchId, filter);
  process.stdout.write(JSON.stringify(result, null, 2) + "\n");
  await recordExportEvent({
    auditFile,
    record: {
      endpoint: "cli.list-games",
      batchId,
      format: "json",
      redact: !flags.raw,
      filter,
    },
  });
  return 0;
}

async function cmdExport(svc, positional, flags, auditFile) {
  const [gameId, formatRaw, outPath] = positional;
  if (!gameId || !formatRaw || !outPath) {
    process.stderr.write("FATAL: export requires <gameId> <csv|markdown|zip> <outPath>\n");
    return 2;
  }
  const format = formatRaw.toLowerCase();
  const redact = !flags.raw;
  const fs = await import("node:fs");
  const { createHash } = await import("node:crypto");

  if (format === "csv") {
    const { csv } = await svc.renderQuestionnaireCsv(gameId, { redact });
    fs.writeFileSync(outPath, csv, "utf8");
    const sha = createHash("sha256").update(csv).digest("hex");
    const size = Buffer.byteLength(csv, "utf8");
    process.stdout.write(`Wrote ${size} bytes (sha256=${sha}) to ${outPath}\n`);
    await recordExportEvent({
      auditFile,
      record: { endpoint: "cli.export.csv", gameId, format: "csv", redact, sizeBytes: size, sha256: sha },
    });
    return 0;
  }
  if (format === "markdown") {
    const { markdown } = await svc.renderTranscriptMd(gameId, { redact });
    fs.writeFileSync(outPath, markdown, "utf8");
    const sha = createHash("sha256").update(markdown).digest("hex");
    const size = Buffer.byteLength(markdown, "utf8");
    process.stdout.write(`Wrote ${size} bytes (sha256=${sha}) to ${outPath}\n`);
    await recordExportEvent({
      auditFile,
      record: { endpoint: "cli.export.markdown", gameId, format: "markdown", redact, sizeBytes: size, sha256: sha },
    });
    return 0;
  }
  if (format === "zip") {
    fs.mkdirSync(path.dirname(outPath), { recursive: true });
    const output = fs.createWriteStream(outPath);
    const { bytes, sha256, files } = await svc.writeGameBundle(gameId, { redact, output });
    await new Promise((resolve) => output.on("close", resolve));
    process.stdout.write(`Wrote ${bytes} bytes (sha256=${sha256}) to ${outPath} (${files.join(", ")})\n`);
    await recordExportEvent({
      auditFile,
      record: { endpoint: "cli.export.zip", gameId, format: "zip", redact, sizeBytes: bytes, sha256: sha256 },
    });
    return 0;
  }
  process.stderr.write(`FATAL: unknown format '${formatRaw}' (expected csv, markdown, zip)\n`);
  return 2;
}

async function cmdExportBatch(svc, positional, flags, auditFile) {
  const [batchId, outDir] = positional;
  if (!batchId || !outDir) {
    process.stderr.write("FATAL: export-batch requires <batchId> <outDir>\n");
    return 2;
  }
  const redact = !flags.raw;
  const fs = await import("node:fs");
  const { createHash } = await import("node:crypto");
  fs.mkdirSync(outDir, { recursive: true });
  const { items } = await svc.listGames(batchId, { limit: 1000 });
  const manifest = { batchId, redact, generatedAt: new Date().toISOString(), files: [] };
  for (const game of items) {
    const outPath = path.join(outDir, `${game.id}.zip`);
    const output = fs.createWriteStream(outPath);
    const { bytes, sha256 } = await svc.writeGameBundle(game.id, { redact, output });
    await new Promise((resolve) => output.on("close", resolve));
    manifest.files.push({ gameId: game.id, path: outPath, bytes, sha256 });
    await recordExportEvent({
      auditFile,
      record: { endpoint: "cli.export-batch", batchId, gameId: game.id, format: "zip", redact, sizeBytes: bytes, sha256 },
    });
  }
  const manifestPath = path.join(outDir, "manifest.json");
  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2), "utf8");
  process.stdout.write(`Exported ${items.length} game(s) to ${outDir}; manifest at ${manifestPath}\n`);
  return 0;
}

function numberOrDefault(value, fallback) {
  if (value === undefined || value === null) return fallback;
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

main().then(
  (code) => process.exit(typeof code === "number" ? code : 0),
  (err) => {
    if (err instanceof ExportNotFoundError) {
      process.stderr.write(`FATAL: ${err.message}\n`);
      process.exit(4);
    }
    process.stderr.write(`FATAL: ${err?.stack || err}\n`);
    process.exit(1);
  },
);
