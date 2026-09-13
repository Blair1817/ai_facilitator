// Runs every Tier 2 (real-LLM) scenario sequentially against the REAL live
// handleChat (server/.env's actual LLM_API_ENDPOINT/OPENAI_API_KEY/
// OPENAI_MODEL, loaded via fakes/loadCallbacks.mjs's getLiveHandleChat --
// no mocking of the decision logic or the network call). Progress prints
// after each scenario since each one can take ~45-60s (3 chained LLM
// calls: Semantic Assessor -> Generator -> Validator, sometimes a repair
// round too).
//
// If the LLM endpoint is unreachable (see TEST_REPORT.md's "Tier 2 could
// not be executed" note -- this session's network egress is blocked by
// organizational policy from reaching api.openai.com/api.minimax.chat, in
// both the device shell and the analysis container), every scenario will
// resolve to gateDecision "abstain"/outcome "SILENT" with a captured
// network error rather than a real generative verdict. This script marks
// that condition explicitly (status "BLOCKED") rather than reporting a
// false PASS/FAIL, and still writes the full attempted transcript, per-
// message firing trace, and raw error to results/tier2_results.json.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { TIER2_SCENARIOS } from "./tier2_scenarios.mjs";
import { runLiveScenario } from "./fakes/tier2Runner.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const RESULTS_DIR = path.join(__dirname, "results");
fs.mkdirSync(RESULTS_DIR, { recursive: true });
const OUT_PATH = path.join(RESULTS_DIR, "tier2_results.json");

const results = [];

function networkBlocked(logEntriesByMessageIndex) {
  return logEntriesByMessageIndex.some((e) => e.threw && /entry\.id must be a non-empty string/.test(e.error || ""))
    && logEntriesByMessageIndex.every((e) => e.fired !== "triggered" || true); // presence check only
}

console.log(`\n=== Tier 2: ${TIER2_SCENARIOS.length} real-LLM scenarios (sequential; each may take 45-60s) ===`);
let idx = 0;
for (const scenario of TIER2_SCENARIOS) {
  idx += 1;
  const startedAt = Date.now();
  process.stdout.write(`  [${idx}/${TIER2_SCENARIOS.length}] #${scenario.id} ${scenario.name} ... `);
  let entry;
  try {
    const result = await runLiveScenario(scenario);
    const detectorReachedLlm = result.llmLog.some((e) => !(typeof e.detectorError === "string" && /fetch failed|ECONNREFUSED|EAI_AGAIN|403/.test(e.detectorError))
      && !(typeof e.reason === "string" && /API Error/.test(e.reason)));
    const graded = scenario.check(result);
    const blocked = !detectorReachedLlm && result.llmLog.every((e) => typeof e.reason === "string" && /API Error/.test(e.reason) || typeof e.detectorError === "string");
    entry = {
      id: scenario.id, group: scenario.group, tier: 2, name: scenario.name,
      expected: scenario.expected ?? null,
      status: blocked ? "BLOCKED" : graded.status,
      notes: blocked ? "Network egress to the configured LLM endpoint is blocked in this environment (see TEST_REPORT.md); no real generative output was produced." : graded.notes,
      transcript: scenario.transcript,
      firingTrace: result.logEntriesByMessageIndex,
      lastLogEntry: result.lastEntry,
      publishedTexts: result.publishedTexts,
      elapsedMs: Date.now() - startedAt,
    };
  } catch (err) {
    entry = {
      id: scenario.id, group: scenario.group, tier: 2, name: scenario.name,
      expected: scenario.expected ?? null, status: "EXCEPTION",
      notes: `Harness threw: ${err.message}`, exception: err.stack,
      elapsedMs: Date.now() - startedAt,
    };
  }
  results.push(entry);
  console.log(`${entry.status} (${(entry.elapsedMs / 1000).toFixed(1)}s)`);
  fs.writeFileSync(OUT_PATH, JSON.stringify(results, null, 2)); // write progressively
}

const counts = results.reduce((acc, r) => { acc[r.status] = (acc[r.status] || 0) + 1; return acc; }, {});
console.log(`\nTier 2 complete: ${results.length} scenarios ->`, counts);
