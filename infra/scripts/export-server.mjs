/**
 * infra/scripts/export-server.mjs
 *
 * D-014: production entrypoint for the research-data export server.
 * Reads the same Tajriba runtime config the Empirica callbacks process
 * uses (so the export server authenticates with the same admin token)
 * and binds a tiny HTTP server on the loopback interface only. The
 * Cloudflare Tunnel forwards the public `exports.*` route to it.
 *
 * The real implementation lives in server/src/ExportServer.mjs and is
 * bundled into the Empirica archive by `infra/scripts/build-nas-bundle.sh`.
 * This wrapper is the script the Dockerfile copies into the runtime
 * image; it reads the bundled module out of the live archive.
 */

import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

const RUNTIME_CONFIG = process.env.TAJRIBA_CONFIG || "/run/secrets/empirica.toml";
const PORT = Number(process.env.EXPORT_PORT || 3001);
const HOST = process.env.EXPORT_HOST || "127.0.0.1";
const AUDIT_FILE = process.env.EXPORT_AUDIT_FILE || "/data/export-audit.jsonl";
const TAJRIBA_URL = process.env.TAJRIBA_URL || "http://127.0.0.1:3000/query";

// The export server module ships inside the Empirica bundle at
// `<bundle>/callbacks/export-server.mjs` (the same archive the
// Empirica callbacks process runs from). The empirica-entrypoint.sh
// unzipped that bundle into /tmp/delibra-runtime.* earlier in the
// container boot, so we look for it there.
function findBundledModule() {
  const candidates = [
    "/tmp/delibra-runtime/callbacks/export-server.mjs",
    "/opt/delibra/callbacks/export-server.mjs",
  ];
  for (const c of candidates) {
    if (fs.existsSync(c)) return c;
  }
  return null;
}

function readSrtoken() {
  if (!fs.existsSync(RUNTIME_CONFIG)) {
    throw new Error(`FATAL: Tajriba runtime config not found at ${RUNTIME_CONFIG}`);
  }
  const text = fs.readFileSync(RUNTIME_CONFIG, "utf8");
  const m = text.match(/^srtoken\s*=\s*"([^"]+)"$/m);
  if (!m) throw new Error("FATAL: srtoken field missing from runtime config");
  return m[1];
}

async function main() {
  const srtoken = readSrtoken();
  const modPath = findBundledModule();
  if (!modPath) {
    throw new Error("FATAL: export-server module not found in bundle");
  }
  const { createDefaultExportServer } = await import(pathToFileURL(path.resolve(modPath)).href);
  const server = await createDefaultExportServer({
    url: TAJRIBA_URL,
    srtoken,
    auditFile: AUDIT_FILE,
    clientName: "export-server",
  });
  await new Promise((resolve) => server.listen(PORT, HOST, resolve));
  // eslint-disable-next-line no-console
  console.log(`[export-server] listening on http://${HOST}:${PORT} (audit: ${AUDIT_FILE})`);
}

main().catch((error) => {
  // eslint-disable-next-line no-console
  console.error("[export-server] FATAL:", error?.stack || error);
  process.exit(1);
});
