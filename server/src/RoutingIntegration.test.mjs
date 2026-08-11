// Static/config-level integration tests: verify the real connection between
// callbacks.js's own inline S1-S4 sequence table and its real LLM-dispatch
// gate, without executing callbacks.js itself (it registers real Empirica
// listeners and imports dotenv/fetch on load, which would need heavy
// mocking to run safely) and without any network request or real LLM call.
//
// These are deliberately *static* checks (reading source as text and
// asserting structure) -- not a full runtime harness.
//
// ── Counterbalancing.mjs removal (cleanup) ──────────────────────────────────
// This file previously imported SEQUENCE_IDS/SEQUENCES/buildRoundAssignments
// from server/src/Counterbalancing.mjs to cross-check that module's sequence
// table against callbacks.js's dispatch behavior. Counterbalancing.mjs has
// been deleted: it was never imported by any production code (confirmed via
// `rg "Counterbalancing.mjs"` across the whole tree before deletion -- only
// this file and Counterbalancing.test.mjs referenced it), because
// callbacks.js already performs its own S1-S4 randomized-block allocation
// inline (`SEQUENCES`, `SEQUENCE_IDS`, `claimNextSequence()` in
// callbacks.js). Full behavioral coverage of that real, live sequence table
// and allocator lives in Counterbalancing.test.mjs (a faithful reproduction
// of callbacks.js's actual algorithm, plus structural checks against
// callbacks.js's real source) -- not duplicated here a second time. This
// file keeps only its own original, distinct concern: Round-level
// facilitation dispatch never coming from `game.get("treatment")`.
//
// ── Gate 3 (obsolete-contract correction, still valid) ──────────────────────
// This file previously asserted a TREATMENT-LEVEL facilitation design
// (.empirica/treatments.yaml declaring a "facilitation" factor, callbacks.js
// gating through ConditionRouting.mjs's resolveFacilitationDispatch). Both
// premises are false: callbacks.js reads `const facilitation =
// currentRound?.get("facilitation")` -- per-Round, sourced from the Round's
// own facilitation field (set in onGameStart from the sequence table),
// never from `game.get("treatment")`. ConditionRouting.mjs and its test
// were deleted in Phase 6.1 (Q7 = "可" -- nothing in production imported
// them, and callbacks.js performs the dispatch inline).
import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const treatmentsPath = path.join(__dirname, "../../.empirica/treatments.yaml");
const callbacksPath = path.join(__dirname, "callbacks.js");

const treatmentsYaml = readFileSync(treatmentsPath, "utf8");
const callbacksSource = readFileSync(callbacksPath, "utf8");

test("treatments.yaml: no longer declares a treatment-level 'facilitation' factor (superseded by round-level assignment)", () => {
  assert.doesNotMatch(
    treatmentsYaml,
    /-\s*name:\s*facilitation/,
    "facilitation must not reappear as a treatment.yaml factor -- it is assigned per-Round via the counterbalancing sequence, not once per Game"
  );
});

test("callbacks.js: reads `facilitation` from the current Round, never from game.get(\"treatment\")", () => {
  assert.match(
    callbacksSource,
    /const\s+facilitation\s*=\s*currentRound\?\.get\("facilitation"\)/,
    "handleChat must read facilitation from the current Round (the real, current design)"
  );
  assert.doesNotMatch(
    callbacksSource,
    /facilitation\s*\}\s*=\s*game\.get\("treatment"\)/,
    "facilitation must never be destructured from game.get(\"treatment\") -- that was the obsolete treatment-level design"
  );
});

test("callbacks.js: the old llmFacilitationModes allow-list is fully removed", () => {
  assert.doesNotMatch(callbacksSource, /llmFacilitationModes/);
});

test("callbacks.js: no direct facilitation === \"LLM\" style comparison remains", () => {
  assert.doesNotMatch(callbacksSource, /facilitation\s*===?\s*["']LLM["']/);
});

// ── Approved condition-specific intervention permission ────────────────────
// Static and Adaptive retain one checkpoint and one shared implementation of
// generation/validation/publication, but reach it from separate permission
// paths: Static directly; Adaptive only after its controller returns ACT.

test("callbacks.js: Static bypasses Adaptive assessment while both conditions reuse the same shared generation implementation", () => {
  const handleChatSource = callbacksSource.slice(callbacksSource.indexOf("async function handleChat"));
  const staticStart = handleChatSource.indexOf('if (facilitation === "static")');
  const staticEnd = handleChatSource.indexOf('if (facilitation !== "adaptive")', staticStart);
  const detectorStart = handleChatSource.indexOf("assessSemanticFactors(", staticEnd);
  const staticBlock = handleChatSource.slice(staticStart, staticEnd);

  assert.ok(staticStart !== -1 && staticEnd !== -1 && detectorStart !== -1);
  assert.ok(staticStart < detectorStart, "Static must branch before the Adaptive LLM detector");
  assert.match(staticBlock, /buildGeneratorContext\([\s\S]*?"static"[\s\S]*?null[\s\S]*?null/);
  assert.match(staticBlock, /runSharedGeneration\(/);
  assert.match(staticBlock, /return;/, "Static must return before entering the Adaptive assessment path");
  assert.doesNotMatch(staticBlock, /extractFeatures|getCandidateRoles|assessSemanticFactors|checkEvidence|evaluateGate|chooseRole|compilePlan/);

  assert.equal([...callbacksSource.matchAll(/async function runSharedGeneration\(/g)].length, 1, "there must still be exactly one shared generation implementation");
  // Phase 4 design (audit-phase1.md v3): the Adaptive path has TWO
  // independent branches after the gate -- Generalist (matched-frequency
  // control) and Specialist (one of the three Controllers). Both call
  // the same shared `runSharedGeneration` as the Static branch, so
  // there are 5 call sites in handleChat: 1 participant-requested
  // Generalist + 1 Static + 1 automatic Generalist + 1 Specialist +
  // 1 Specialist-to-Generalist repair fallback.
  assert.equal([...handleChatSource.matchAll(/runSharedGeneration\(/g)].length, 5, "requested Generalist and all automatic routes must share the same generation implementation");
});

test("callbacks.js: getLLMResponse has exactly one INVOCATION site in the whole file (the shared generation path), not one per facilitation branch", () => {
  // Matches the call ("await getLLMResponse(...)"), not the function's own
  // declaration ("async function getLLMResponse(...)").
  const llmCallSites = [...callbacksSource.matchAll(/await\s+getLLMResponse\(/g)];
  assert.equal(llmCallSites.length, 1, "expected exactly one getLLMResponse(...) invocation -- Static and Adaptive must share it, not each have their own");
  const declarationSites = [...callbacksSource.matchAll(/function\s+getLLMResponse\(/g)];
  assert.equal(declarationSites.length, 1, "expected exactly one getLLMResponse function declaration (no second LLM client)");
});

test("callbacks.js: handleChat bails out before any dispatch if the current Round has no facilitation value at all", () => {
  const handleChatSource = callbacksSource.slice(callbacksSource.indexOf("async function handleChat"));
  const earlyReturnIndex = handleChatSource.indexOf("if (!facilitation) {");
  const sharedCallIndex = handleChatSource.indexOf("runSharedGeneration(");
  assert.ok(earlyReturnIndex !== -1 && sharedCallIndex !== -1 && earlyReturnIndex < sharedCallIndex);
  const guardBlock = handleChatSource.slice(earlyReturnIndex, handleChatSource.indexOf("const players", earlyReturnIndex));
  assert.match(guardBlock, /MISSING_ROUND_FACILITATION/);
  assert.match(guardBlock, /return;/);
});

// ── Round-level facilitation regression coverage (Gate 3) ──────────────────
// Structural checks against callbacks.js's own real, live SEQUENCES table
// (the single source of truth -- no second copy of the S1-S4 mapping is
// maintained in this file). Full behavioral coverage of the actual mapping
// values and the allocator's runtime behavior lives in
// Counterbalancing.test.mjs.

test("callbacks.js's SEQUENCES table only ever assigns 'static'/'adaptive' facilitation -- never treatment-level 'none' or any other value", () => {
  const sequencesBlockStart = callbacksSource.indexOf("const SEQUENCES = {");
  const sequencesBlockEnd = callbacksSource.indexOf("const SEQUENCE_IDS", sequencesBlockStart);
  const sequencesBlock = callbacksSource.slice(sequencesBlockStart, sequencesBlockEnd);
  const facilitationValues = [...sequencesBlock.matchAll(/facilitationOrder:\s*\[([^\]]+)\]/g)]
    .flatMap((m) => m[1].split(",").map((v) => v.trim().replace(/["']/g, "")));
  assert.ok(facilitationValues.length > 0, "expected to find facilitationOrder entries in callbacks.js's SEQUENCES table");
  for (const value of facilitationValues) {
    assert.ok(["static", "adaptive"].includes(value), `unexpected facilitation value "${value}" in callbacks.js's SEQUENCES table`);
  }
});

test("callbacks.js's SEQUENCES table defines exactly S1-S4, each with one static and one adaptive Round (never both or neither)", () => {
  const sequencesBlockStart = callbacksSource.indexOf("const SEQUENCES = {");
  const sequencesBlockEnd = callbacksSource.indexOf("const SEQUENCE_IDS", sequencesBlockStart);
  const sequencesBlock = callbacksSource.slice(sequencesBlockStart, sequencesBlockEnd);
  const sequenceKeys = [...sequencesBlock.matchAll(/^\s{2}(S\d):\s*\{/gm)].map((m) => m[1]);
  assert.deepEqual(sequenceKeys.sort(), ["S1", "S2", "S3", "S4"]);

  const perSequenceOrders = [...sequencesBlock.matchAll(/facilitationOrder:\s*\[([^\]]+)\]/g)]
    .map((m) => m[1].split(",").map((v) => v.trim().replace(/["']/g, "")));
  assert.equal(perSequenceOrders.length, 4);
  for (const order of perSequenceOrders) {
    assert.deepEqual([...order].sort(), ["adaptive", "static"], `expected exactly one static + one adaptive Round, got ${JSON.stringify(order)}`);
  }
});

test("callbacks.js's S1-S4 table produces the canonical 8 round-level taskIndex/taskVersion/facilitation mappings", () => {
  const sequencesBlockStart = callbacksSource.indexOf("const SEQUENCES = {");
  const sequencesBlockEnd = callbacksSource.indexOf("const SEQUENCE_IDS", sequencesBlockStart);
  const sequencesBlock = callbacksSource.slice(sequencesBlockStart, sequencesBlockEnd);
  const parseArray = (entryBody, field) => {
    const match = entryBody.match(new RegExp(`${field}:\\s*\\[([^\\]]+)\\]`));
    assert.ok(match, `expected ${field} in every sequence entry`);
    return match[1].split(",").map((value) => value.trim().replace(/["']/g, ""));
  };

  const actual = [];
  for (const match of sequencesBlock.matchAll(/^\s{2}(S[1-4]):\s*\{([\s\S]*?)^\s{2}\},/gm)) {
    const [, sequenceId, entryBody] = match;
    const facilitationOrder = parseArray(entryBody, "facilitationOrder");
    const taskOrder = parseArray(entryBody, "taskOrder").map(Number);
    const taskVersionOrder = parseArray(entryBody, "taskVersionOrder");
    assert.deepEqual(
      taskOrder,
      taskVersionOrder.map((taskVersion) => ({ A: 0, B: 1 })[taskVersion]),
      `${sequenceId} taskVersionOrder must preserve the existing HPT material order`,
    );
    for (let roundIndex = 0; roundIndex < 2; roundIndex += 1) {
      actual.push({
        sequenceId,
        round: roundIndex + 1,
        taskIndex: roundIndex,
        taskVersion: taskVersionOrder[roundIndex],
        facilitation: facilitationOrder[roundIndex],
      });
    }
  }

  assert.deepEqual(actual, [
    { sequenceId: "S1", round: 1, taskIndex: 0, taskVersion: "A", facilitation: "static" },
    { sequenceId: "S1", round: 2, taskIndex: 1, taskVersion: "B", facilitation: "adaptive" },
    { sequenceId: "S2", round: 1, taskIndex: 0, taskVersion: "A", facilitation: "adaptive" },
    { sequenceId: "S2", round: 2, taskIndex: 1, taskVersion: "B", facilitation: "static" },
    { sequenceId: "S3", round: 1, taskIndex: 0, taskVersion: "B", facilitation: "static" },
    { sequenceId: "S3", round: 2, taskIndex: 1, taskVersion: "A", facilitation: "adaptive" },
    { sequenceId: "S4", round: 1, taskIndex: 0, taskVersion: "B", facilitation: "adaptive" },
    { sequenceId: "S4", round: 2, taskIndex: 1, taskVersion: "A", facilitation: "static" },
  ]);

  assert.deepEqual(
    [...new Set(actual.map(({ taskVersion, facilitation }) => `${taskVersion}+${facilitation}`))].sort(),
    ["A+adaptive", "A+static", "B+adaptive", "B+static"],
  );
});

test("round creation stores exposure index directly and consumes taskVersion/facilitation from the selected sequence", () => {
  const round1Block = callbacksSource.slice(callbacksSource.indexOf("const round1 = game.addRound("), callbacksSource.indexOf("const round2 = game.addRound("));
  const round2Block = callbacksSource.slice(callbacksSource.indexOf("const round2 = game.addRound("), callbacksSource.indexOf("// MIGRATED from old 2nd (TEMP-BE-007"));

  assert.match(round1Block, /taskIndex:\s*0/);
  assert.match(round1Block, /taskVersion:\s*sequence\.taskVersionOrder\[0\]/);
  assert.match(round1Block, /facilitation:\s*sequence\.facilitationOrder\[0\]/);
  assert.match(round2Block, /taskIndex:\s*1/);
  assert.match(round2Block, /taskVersion:\s*sequence\.taskVersionOrder\[1\]/);
  assert.match(round2Block, /facilitation:\s*sequence\.facilitationOrder\[1\]/);

  assert.match(callbacksSource, /const TASK_CONFIG_INDEX_BY_VERSION = Object\.freeze\(\{ A: 0, B: 1 \}\)/, "Task A/B must retain their existing HPTConfig.json material indexes");
  assert.match(callbacksSource, /const taskConfigIndex = TASK_CONFIG_INDEX_BY_VERSION\[taskVersion\]/, "Task materials must be selected by canonical taskVersion");
  assert.doesNotMatch(callbacksSource, /taskVersion:\s*sequence\.facilitationOrder/, "taskVersion must never be inferred from facilitation");
});

test("treatment metadata cannot override the Round-level facilitation assignment: round1/round2 creation reads facilitation only from `sequence`, never from `treatment`", () => {
  const round1Block = callbacksSource.slice(callbacksSource.indexOf("const round1 = game.addRound("), callbacksSource.indexOf("const round2 = game.addRound("));
  const round2Block = callbacksSource.slice(callbacksSource.indexOf("const round2 = game.addRound("), callbacksSource.indexOf("// MIGRATED from old 2nd (TEMP-BE-007"));
  for (const block of [round1Block, round2Block]) {
    assert.match(block, /facilitation:\s*sequence\.facilitationOrder\[\d\]/, "Round facilitation must come from `sequence` (the claimed S1-S4 entry), not `treatment`");
    assert.doesNotMatch(block, /facilitation:\s*treatment/, "Round facilitation must never be sourced from `treatment`");
  }
});
