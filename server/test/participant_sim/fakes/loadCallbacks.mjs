// Bundles the REAL server/src/callbacks.js with esbuild (already an
// installed devDependency) so it can be imported under plain Node ESM.
//
// Why bundling is needed at all: callbacks.js does
// `import taskConfig from "./HPTConfig.json"` with no import attribute,
// which Node 22's strict ESM loader rejects outright (verified this
// session: `node -e "import('./src/callbacks.js')"` throws
// `needs an import attribute of "type: json"`). esbuild resolves JSON
// imports at bundle time (turning them into object literals), which is
// exactly what the project's own `npm run build` already relies on
// (server/package.json's `build` script bundles src/index.js with esbuild
// for the same reason) -- this harness does the same thing to the same
// file, it does not reimplement or fork callbacks.js's logic.
//
// The only other obstacle is that callbacks.js's single Empirica import,
// `import { ClassicListenersCollector } from "@empirica/core/admin/classic"`,
// transitively pulls in @empirica/tajriba -> cross-fetch, and cross-fetch's
// package resolves to a bare directory import that Node 22's strict ESM
// resolver also rejects (unrelated to anything in this repo's own code).
// We never need a live Tajriba connection for pipeline-logic testing, so
// we alias that one import to fakes/fakeEmpiricaCore.mjs -- a drop-in
// reimplementation of ClassicListenersCollector's public surface (on/
// before/after/flush/onGameStart/...), copied from and verified against
// node_modules/@empirica/core/dist/chunk-ATDZK33U.js +
// -chunk-CA6WWEPS.js in this repo. This changes NOTHING about
// callbacks.js's own control flow: `Empirica.on("game", "chat_round_0",
// handleChat)` still registers the exact same real `handleChat` function
// reference; we just read it back out of `Empirica.attributeListeners`
// afterwards instead of Tajriba invoking it over a live subscription.
//
// No file under server/src is modified by any of this.
import * as esbuild from "esbuild";
import path from "node:path";
import fs from "node:fs";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SERVER_ROOT = path.resolve(__dirname, "../../.."); // server/
const ENTRY = path.join(SERVER_ROOT, "src", "callbacks.js");
const FAKE_CORE = path.join(__dirname, "fakeEmpiricaCore.mjs");
const CACHE_DIR = path.join(__dirname, "..", ".cache");
fs.mkdirSync(CACHE_DIR, { recursive: true });

async function buildAndImport(variantName) {
  const outfile = path.join(CACHE_DIR, `callbacks.${variantName}.mjs`);
  await esbuild.build({
    entryPoints: [ENTRY],
    bundle: true,
    format: "esm",
    platform: "node",
    packages: "external",
    alias: { "@empirica/core/admin/classic": FAKE_CORE },
    outfile,
    logLevel: "warning",
  });
  // Cache-bust: each variant gets its own file path already, but re-running
  // within the same process for the same variant should re-read the fresh
  // build, so append a query string tied to mtime.
  const bust = fs.statSync(outfile).mtimeMs;
  const mod = await import(`${new URL(`file://${outfile}`).href}?v=${bust}`);
  return mod;
}

function findAttributeListener(Empirica, kind, key) {
  const hit = Empirica.attributeListeners.find((l) => l.kind === kind && l.key === key);
  if (!hit) throw new Error(`loadCallbacks.mjs: no registered listener for kind="${kind}" key="${key}"`);
  return hit.callback;
}

let offlinePromise = null;
let livePromise = null;

/**
 * "Offline" variant: LLM_API_ENDPOINT is pointed at an address that refuses
 * the connection immediately (no DNS lookup, no timeout wait), so any
 * checkpoint that DOES pass the trigger gate and reaches the Generator still
 * completes in well under a second -- it just always resolves to a SILENT
 * outcome (API error) rather than a real generation. This is used for every
 * Tier-1 scenario that needs to drive the real handleChat() (attempt cap,
 * cooldown, dedup, rapid burst, empty-message filtering, mention bypass)
 * WITHOUT spending any real API budget or wall-clock latency, since those
 * scenarios only assert on gating/bookkeeping (did a checkpoint fire? was
 * humanMessageCount incremented? was the opportunity gate reset?), never on
 * generated text.
 */
export async function getOfflineHandleChat() {
  if (!offlinePromise) {
    offlinePromise = (async () => {
      process.env.LLM_API_ENDPOINT = "http://127.0.0.1:65535"; // unbound high port: instant ECONNREFUSED, not in undici's blocked-port list
      process.env.OPENAI_API_KEY = process.env.OPENAI_API_KEY || "offline-test-key-unused";
      process.env.OPENAI_MODEL = process.env.OPENAI_MODEL || "offline-test-model";
      const mod = await buildAndImport("offline");
      return findAttributeListener(mod.Empirica, "game", "chat_round_0");
    })();
  }
  return offlinePromise;
}

/**
 * "Live" variant: uses whatever LLM_API_ENDPOINT / OPENAI_API_KEY /
 * OPENAI_MODEL are already configured in server/.env (loaded by
 * callbacks.js's own `dotenv.config()` call at module top, unmodified).
 * Used only by Tier-2 scenarios, which need real Assessor/Generator/
 * Validator output.
 */
export async function getLiveHandleChat() {
  if (!livePromise) {
    livePromise = (async () => {
      // Force-clear any offline overrides from a prior getOfflineHandleChat()
      // call in the SAME process so dotenv.config() (invoked when the "live"
      // bundle module is evaluated) reads server/.env's real values instead
      // of leaving the offline placeholders in place.
      delete process.env.LLM_API_ENDPOINT;
      delete process.env.OPENAI_API_KEY;
      delete process.env.OPENAI_MODEL;
      const mod = await buildAndImport("live");
      return findAttributeListener(mod.Empirica, "game", "chat_round_0");
    })();
  }
  return livePromise;
}
