import { AdminContext } from "@empirica/core/admin";
import {
  Classic,
  classicKinds,
  ClassicLoader,
  Lobby,
} from "@empirica/core/admin/classic";
import { info, setLogLevel } from "@empirica/core/console";
import fs from "node:fs";
import minimist from "minimist";
import process from "process";
import { Tajriba } from "@empirica/tajriba";
import { Empirica } from "./callbacks";
import { ExportService } from "./ExportService.mjs";
import { createExportServer } from "./ExportServer.mjs";
import { recordExportEvent } from "./ExportAudit.mjs";
import { runStartupSelfCheck } from "./prompts/promptLoader.js";

const argv = minimist(process.argv.slice(2), { string: ["token"] });

setLogLevel(argv["loglevel"] || "info");

// Phase 2.5: refuse to start the experiment if any required prompt/schema
// file is missing or contains unresolved placeholder markers. This must
// run before Empirica starts accepting game assignments -- a failure here
// means the live pipeline would otherwise SILENT every checkpoint.
try {
  runStartupSelfCheck({ throwOnFailure: true });
} catch (err) {
  // eslint-disable-next-line no-console
  console.error(err.message);
  process.exit(1);
}

// Phase 6 pilot-prep fail-fast: refuse to start if OPENAI_API_KEY is the
// .env.example placeholder string. The placeholder would otherwise be
// sent verbatim as `Authorization: Bearer your-key-here` to the LLM
// endpoint, which returns a 401 only at the FIRST real LLM call (silently
// after every checkpoint has been SILENTed). Crashing here means a
// misconfigured pilot setup is impossible to start, instead of producing
// 0 intervention data and looking like a research result.
import dotenv from "dotenv";
dotenv.config();
if (!process.env.OPENAI_API_KEY || process.env.OPENAI_API_KEY === "your-key-here") {
  console.error(
    "[index.js] FATAL: OPENAI_API_KEY is missing or still the .env.example placeholder.\n" +
    "Fix: open server/.env and replace the placeholder with the real key.\n" +
    "(.env is gitignored; .env.example is the public template only.)"
  );
  process.exit(1);
}

(async () => {
  const ctx = await AdminContext.init(
    argv["url"] || "http://localhost:3000/query",
    argv["sessionTokenPath"],
    "callbacks",
    argv["token"],
    {},
    classicKinds
  );

  ctx.register(ClassicLoader);
  ctx.register(Classic());
  ctx.register(Lobby());
  ctx.register(Empirica);
  ctx.register(function (_) {
    _.on("ready", function () {
      info("server: started");
    });
  });

  // D-014: start the research-data export server alongside Empirica.
  // The server is bundled into the same `callbacks/index.js` archive
  // (esbuild's --bundle pulls it in via the import at the top of this
  // file), so a single `empirica bundle` produces both the callbacks
  // process and the export surface. The export service binds to all
  // interfaces (0.0.0.0) so that docker port-mapping on port 3001
  // reaches the process; previously bound to 127.0.0.1 only, which
  // broke the 192.168.0.109:3001 -> 172.17.0.2:3001 DNAT path
  // (kernel sends RST because 172.17.0.2 != 127.0.0.1). The cloudflared
  // tunnel routes the public `exports.<domain>` host to this port.
  //
  // Disable with DELIBRA_DISABLE_EXPORT_SERVER=1 (e.g. during incident
  // response or if the audit file is on a read-only mount).
  if (process.env.DELIBRA_DISABLE_EXPORT_SERVER !== "1") {
    try {
      const exportPort = Number(process.env.EXPORT_PORT || 3001);
      const auditFile = process.env.EXPORT_AUDIT_FILE || "/data/export-audit.jsonl";
      const tajUrl = process.env.TAJRIBA_URL || "http://127.0.0.1:3000/query";
      const srtokenPath = process.env.TAJRIBA_CONFIG || "/run/secrets/empirica.toml";

      let srtoken = process.env.TAJRIBA_SRTOKEN;
      if (!srtoken) {
        const configText = fs.readFileSync(srtokenPath, "utf8");
        const m = configText.match(/^srtoken\s*=\s*"([^"]+)"$/m);
        if (!m) throw new Error(`srtoken field missing in ${srtokenPath}`);
        srtoken = m[1];
      }

      const taj = await Tajriba.createAndAwait(tajUrl);
      taj.useHTTP = true;
      const sessionToken = await taj.registerService("export-server", srtoken);
      const admin = await taj.sessionAdmin(sessionToken);
      const exportService = new ExportService({
        admin: {
          scopes: async (args) => admin.scopes(args),
          stop: () => taj.stop(),
        },
        auditFile,
      });
      const exportServer = createExportServer({ service: exportService, auditFile });
      await new Promise((resolve, reject) => {
        exportServer.once("error", reject);
        exportServer.listen(exportPort, "0.0.0.0", resolve);
      });
      info(`export-server: listening on http://127.0.0.1:${exportPort} (audit: ${auditFile})`);
    } catch (error) {
      // The export server is a research-data convenience; the callbacks
      // process must keep running even if it cannot start. Surface the
      // failure clearly in the Empirica log and let the operator
      // inspect via `docker logs`.
      // eslint-disable-next-line no-console
      console.error("[export-server] FATAL:", error?.message || error);
    }
  }
})();

process.on("unhandledRejection", function (reason, p) {
  process.exitCode = 1;
  console.error("Unhandled Promise Rejection. Reason: ", reason);
});
