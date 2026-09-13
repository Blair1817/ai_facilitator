// Runs every Tier 1 (deterministic, zero-LLM) scenario and writes
// results/tier1_results.json. Console noise from the intentionally-
// unreachable offline LLM endpoint and the (expected) Supabase-not-
// configured warnings is suppressed here (it is real, already-understood
// harness plumbing noise, not scenario output) -- silence only
// console.error/console.warn, never console.log, so PASS/FAIL lines still
// print live.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { makeRecorder } from "./fakes/recorder.mjs";
import { runTier1Pure } from "./tier1_pure.mjs";
import { runTier1HandleChat } from "./tier1_handlechat.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const RESULTS_DIR = path.join(__dirname, "results");
fs.mkdirSync(RESULTS_DIR, { recursive: true });

const realError = console.error;
const realWarn = console.warn;
console.error = () => {};
console.warn = () => {};

const rec = makeRecorder();
await runTier1Pure(rec);
await runTier1HandleChat(rec);

console.error = realError;
console.warn = realWarn;

const results = rec.all();
fs.writeFileSync(path.join(RESULTS_DIR, "tier1_results.json"), JSON.stringify(results, null, 2));

const pass = results.filter((r) => r.status === "PASS").length;
const fail = results.filter((r) => r.status === "FAIL").length;
const obs = results.filter((r) => r.status === "OBSERVED").length;
console.log(`\nTier 1 complete: ${results.length} scenarios -- ${pass} PASS, ${fail} FAIL, ${obs} OBSERVED.`);
if (fail > 0) {
  console.log("FAILED:");
  for (const r of results.filter((r) => r.status === "FAIL")) console.log(`  #${r.id} ${r.name}`);
}
