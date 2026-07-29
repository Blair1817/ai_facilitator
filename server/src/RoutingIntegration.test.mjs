// Static/config-level integration tests: verify the real connection between
// .empirica/treatments.yaml and server/src/callbacks.js, without executing
// callbacks.js itself (it registers real Empirica listeners and imports
// dotenv/fetch on load, which would need heavy mocking to run safely) and
// without any network request or real LLM call.
//
// These are deliberately *static* checks (reading source/config as text and
// asserting structure), not a general YAML parser or a full runtime harness
// -- see the comment above extractFacilitationValues() for the precise,
// narrow scope of what it actually parses.
import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { resolveFacilitationDispatch } from "./ConditionRouting.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const treatmentsPath = path.join(__dirname, "../../.empirica/treatments.yaml");
const callbacksPath = path.join(__dirname, "callbacks.js");

const treatmentsYaml = readFileSync(treatmentsPath, "utf8");
const callbacksSource = readFileSync(callbacksPath, "utf8");

// Narrow, targeted extraction for this file's specific structure only:
//   - name: facilitation
//     desc: ...
//     values:
//       - value: none
//       - value: static
//       - value: adaptive
// Not a general YAML parser -- stops at the next "  - name:" line.
function extractFacilitationValues(yamlText) {
  const lines = yamlText.split("\n");
  const startIndex = lines.findIndex((line) => line.trim() === "- name: facilitation");
  assert.ok(startIndex !== -1, "could not find '- name: facilitation' in treatments.yaml");

  const values = [];
  for (let i = startIndex + 1; i < lines.length; i++) {
    const line = lines[i];
    if (/^\s*-\s*name:/.test(line)) break; // next factor
    const match = line.match(/^\s*-\s*value:\s*(\S+)/);
    if (match) values.push(match[1]);
  }
  return values;
}

test("treatments.yaml: facilitation factor values are exactly none/static/adaptive", () => {
  const values = extractFacilitationValues(treatmentsYaml).sort();
  assert.deepEqual(values, ["adaptive", "none", "static"]);
});

test("callbacks.js: imports the centralized resolver from ConditionRouting.mjs", () => {
  assert.match(
    callbacksSource,
    /import\s*\{\s*resolveFacilitationDispatch\s*\}\s*from\s*["']\.\/ConditionRouting\.mjs["']/
  );
});

test("callbacks.js: reads `facilitation` from game.get(\"treatment\") (same factor as treatments.yaml)", () => {
  // Both onGameStart and onStageStart destructure `facilitation` directly off
  // game.get("treatment") -- the exact factor object treatments.yaml feeds in.
  const destructureCount = (callbacksSource.match(/const\s*\{[^}]*\bfacilitation\b[^}]*\}\s*=\s*game\.get\("treatment"\)/g) || []).length;
  assert.ok(destructureCount >= 2, `expected facilitation to be destructured from game.get("treatment") at least twice, found ${destructureCount}`);
});

test("callbacks.js: the old llmFacilitationModes allow-list is fully removed", () => {
  assert.doesNotMatch(callbacksSource, /llmFacilitationModes/);
});

test("callbacks.js: no direct facilitation === \"LLM\" style comparison remains", () => {
  assert.doesNotMatch(callbacksSource, /facilitation\s*===?\s*["']LLM["']/);
});

test("callbacks.js: onStageStart's LLM interval is gated by resolveFacilitationDispatch(facilitation).eligible", () => {
  const stageStartBlock = callbacksSource.slice(
    callbacksSource.indexOf("Empirica.onStageStart"),
    callbacksSource.indexOf("Empirica.onStageEnded")
  );
  assert.match(stageStartBlock, /resolveFacilitationDispatch\(facilitation\)/);
  assert.match(stageStartBlock, /if\s*\(\s*dispatch\.eligible\s*&&\s*stage\.get\("name"\)\s*==\s*"Task"\s*\)\s*\{/);

  // getLLMResponse must only appear inside the setInterval body, which is
  // itself inside the `if (dispatch.eligible ...)` block above -- assert the
  // gate textually precedes the first getLLMResponse call in this block.
  const gateIndex = stageStartBlock.indexOf("if (dispatch.eligible && stage.get(\"name\") == \"Task\")");
  const llmCallIndex = stageStartBlock.indexOf("getLLMResponse(");
  assert.ok(gateIndex !== -1 && llmCallIndex !== -1 && gateIndex < llmCallIndex);
});

test('callbacks.js: the participant-tag ("game","chat") listener is gated by resolveFacilitationDispatch(facilitation).eligible', () => {
  const chatListenerBlock = callbacksSource.slice(callbacksSource.indexOf('Empirica.on("game", "chat"'));
  assert.match(chatListenerBlock, /resolveFacilitationDispatch\(facilitation\)/);
  assert.match(chatListenerBlock, /if\s*\(\s*dispatch\.eligible\s*&&\s*lastSender\s*!=\s*"ai"\s*&&\s*isFacilitatorTagged\s*\)\s*\{/);

  const gateIndex = chatListenerBlock.indexOf('if (dispatch.eligible && lastSender != "ai" && isFacilitatorTagged)');
  const llmCallIndex = chatListenerBlock.indexOf("getLLMResponse(");
  assert.ok(gateIndex !== -1 && llmCallIndex !== -1 && gateIndex < llmCallIndex);
});

// Re-derive, from the real facilitation values extracted from treatments.yaml
// plus the legacy/unknown/missing cases, that none of them are eligible --
// i.e. that a request to getLLMResponse could never be reached today for any
// value treatments.yaml (or a misconfigured/legacy one) could actually produce.
test("none of treatments.yaml's real facilitation values, nor unknown/missing/legacy \"LLM\", are eligible today", () => {
  const realValues = extractFacilitationValues(treatmentsYaml);
  const casesToCheck = [...realValues, "LLM", undefined, "bogus", ""];
  for (const value of casesToCheck) {
    const dispatch = resolveFacilitationDispatch(value);
    assert.equal(
      dispatch.eligible,
      false,
      `expected facilitation ${JSON.stringify(value)} to be ineligible, got eligible=true (kind=${dispatch.kind})`
    );
  }
});
