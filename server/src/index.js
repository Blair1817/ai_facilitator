import { AdminContext } from "@empirica/core/admin";
import {
  Classic,
  classicKinds,
  ClassicLoader,
  Lobby,
} from "@empirica/core/admin/classic";
import { info, setLogLevel } from "@empirica/core/console";
import minimist from "minimist";
import process from "process";
import { Empirica } from "./callbacks";
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
})();

process.on("unhandledRejection", function (reason, p) {
  process.exitCode = 1;
  console.error("Unhandled Promise Rejection. Reason: ", reason);
});
