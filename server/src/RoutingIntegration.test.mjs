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
// never from `game.get("treatment")`. ConditionRouting.mjs itself is left in
// place as an unused, orphaned module from the earlier treatment-level
// design -- nothing in production imports it.
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

// ── GRAIL scope-reduction refactor correction ───────────────────────────────
// This file previously asserted TWO independent getLLMResponse call sites,
// one textually inside each of the Static/Adaptive branches. That premise
// is now FALSE, verified fresh against the current repo state: the scope-
// reduction refactor's whole point is that Static and Adaptive share ONE
// post-selection generation/validation/publication path
// (runSharedGeneration, called once, unconditionally, after the condition-
// specific prompt/role selection step). Asserting two separate call sites
// would be asserting the OLD, now-intentionally-removed duplication. This
// file is rewritten to validate the real, current, shared-path contract.

test("callbacks.js: Static and Adaptive select their prompt/role differently, but call the SAME shared generation path exactly once (no per-condition duplication)", () => {
  const handleChatSource = callbacksSource.slice(callbacksSource.indexOf("async function handleChat"));
  assert.match(handleChatSource, /facilitation\s*===\s*"adaptive"/, "the adaptive-only Controller/role-selection step must still be gated by facilitation===\"adaptive\"");

  const buildCallSites = [...handleChatSource.matchAll(/buildGeneratorContext\(/g)];
  const sharedCallSites = [...handleChatSource.matchAll(/runSharedGeneration\(/g)];
  assert.equal(buildCallSites.length, 1, "buildGeneratorContext must be called exactly once per checkpoint, for both conditions");
  assert.equal(sharedCallSites.length, 1, "runSharedGeneration must be called exactly once per checkpoint, for both conditions");

  // Neither call site may be textually nested inside a static-only or
  // adaptive-only branch -- both conditions must reach the same call.
  const adaptiveOnlyBlockStart = handleChatSource.indexOf('if (facilitation === "adaptive")');
  const adaptiveOnlyBlockEnd = handleChatSource.indexOf("// ── Shared:");
  assert.ok(adaptiveOnlyBlockStart !== -1 && adaptiveOnlyBlockEnd !== -1 && adaptiveOnlyBlockStart < adaptiveOnlyBlockEnd);
  assert.ok(sharedCallSites[0].index >= adaptiveOnlyBlockEnd, "runSharedGeneration must be called after (outside) the adaptive-only role-selection block, not nested inside it");
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
  const earlyReturnIndex = handleChatSource.indexOf("if (!facilitation) return;");
  const sharedCallIndex = handleChatSource.indexOf("runSharedGeneration(");
  assert.ok(earlyReturnIndex !== -1 && sharedCallIndex !== -1 && earlyReturnIndex < sharedCallIndex);
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

test("treatment metadata cannot override the Round-level facilitation assignment: round1/round2 creation reads facilitation only from `sequence`, never from `treatment`", () => {
  const round1Block = callbacksSource.slice(callbacksSource.indexOf("const round1 = game.addRound("), callbacksSource.indexOf("const round2 = game.addRound("));
  const round2Block = callbacksSource.slice(callbacksSource.indexOf("const round2 = game.addRound("), callbacksSource.indexOf("// MIGRATED from old 2nd (TEMP-BE-007"));
  for (const block of [round1Block, round2Block]) {
    assert.match(block, /facilitation:\s*sequence\.facilitationOrder\[\d\]/, "Round facilitation must come from `sequence` (the claimed S1-S4 entry), not `treatment`");
    assert.doesNotMatch(block, /facilitation:\s*treatment/, "Round facilitation must never be sourced from `treatment`");
  }
});
