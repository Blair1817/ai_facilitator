// Static/config-level integration tests: verify the real connection between
// the counterbalancing sequence table (server/src/Counterbalancing.mjs) and
// server/src/callbacks.js's real LLM-dispatch gate, without executing
// callbacks.js itself (it registers real Empirica listeners and imports
// dotenv/fetch on load, which would need heavy mocking to run safely) and
// without any network request or real LLM call.
//
// These are deliberately *static* checks (reading source as text and
// asserting structure, plus pure computation over the real, imported
// SEQUENCES table) -- not a full runtime harness.
//
// ── Gate 3 (obsolete-contract correction) ──────────────────────────────────
// This file previously asserted a TREATMENT-LEVEL facilitation design:
//   - .empirica/treatments.yaml declares a "facilitation" factor
//     (none/static/adaptive);
//   - callbacks.js imports and gates dispatch through
//     ConditionRouting.mjs's resolveFacilitationDispatch(facilitation),
//     fed by `game.get("treatment").facilitation`.
// Both premises are now FALSE, verified fresh against the current repo
// state (not assumed):
//   - .empirica/treatments.yaml's one treatment ("main") declares no
//     "facilitation" factor at all -- confirmed by reading the file (only
//     playerCount/gameDuration/phase1Duration/introDuration/hiddenInfoCue
//     remain).
//   - callbacks.js:398 reads `const facilitation =
//     currentRound?.get("facilitation")` -- i.e. per-Round, sourced from
//     the counterbalancing sequence assignment (StudyCounterbalanceStore.mjs
//     -> Counterbalancing.mjs's applyRoundAssignment), never from
//     `game.get("treatment")`.
//   - callbacks.js does its own direct `facilitation === "static"` /
//     `facilitation === "adaptive"` dispatch (handleChat, callbacks.js
//     :442,472) -- ConditionRouting.mjs's resolveFacilitationDispatch is
//     not imported by callbacks.js at all (grepped the whole src/ tree:
//     only test files import it).
// This is the CURRENT, correct, within-group design (Static vs Adaptive
// assigned per-Round via the counterbalanced sequence, not once per Game at
// treatment level) -- per this task's explicit instruction, production
// routing is NOT changed back to treatment-level to satisfy the old
// contract. This file is rewritten to validate the real, current contract
// instead. ConditionRouting.mjs itself is left in place (see its own
// updated header comment) as an unused, orphaned module from the earlier
// treatment-level design -- nothing in production imports it, so it is not
// a live routing bug, and rewiring it into callbacks.js's real dispatch
// path is out of Prompt 3A's scope (would be a Static/Adaptive execution
// logic change, explicitly excluded).
import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { SEQUENCE_IDS, SEQUENCES, buildRoundAssignments } from "./Counterbalancing.mjs";

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
// Verified directly against the real, imported SEQUENCES table -- the exact
// data StudyCounterbalanceStore.mjs's setUpCounterbalancedGame() writes onto
// each Round via applyRoundAssignment(), and the exact data callbacks.js's
// handleChat reads back via currentRound.get("facilitation").

test("every sequence (S1-S4) assigns Round facilitation from exactly {static, adaptive} -- never treatment-level 'none' or any other value", () => {
  for (const sequenceId of SEQUENCE_IDS) {
    const { round1, round2 } = SEQUENCES[sequenceId];
    assert.ok(["static", "adaptive"].includes(round1.facilitation), `${sequenceId} round1.facilitation must be static or adaptive, got ${round1.facilitation}`);
    assert.ok(["static", "adaptive"].includes(round2.facilitation), `${sequenceId} round2.facilitation must be static or adaptive, got ${round2.facilitation}`);
  }
});

test("a Static Round routes to Static (never Adaptive) and an Adaptive Round routes to Adaptive (never Static) for all four sequences", () => {
  for (const sequenceId of SEQUENCE_IDS) {
    const { round1, round2 } = buildRoundAssignments(sequenceId);
    for (const round of [round1, round2]) {
      const routesStatic = round.facilitation === "static";
      const routesAdaptive = round.facilitation === "adaptive";
      assert.notEqual(routesStatic, routesAdaptive, `${sequenceId} Round with facilitation=${round.facilitation} must route to exactly one of Static/Adaptive, never both or neither`);
    }
  }
});

test("every sequence's Game contains exactly one Static Round and exactly one Adaptive Round (never two of the same)", () => {
  for (const sequenceId of SEQUENCE_IDS) {
    const { round1, round2 } = buildRoundAssignments(sequenceId);
    const facilitations = [round1.facilitation, round2.facilitation].sort();
    assert.deepEqual(facilitations, ["adaptive", "static"], `${sequenceId} must have exactly one static + one adaptive Round, got ${JSON.stringify(facilitations)}`);
  }
});

test("reversing the counterbalanced condition order (SA <-> AS) reverses which Round is Static vs Adaptive", () => {
  for (const sequenceId of SEQUENCE_IDS) {
    const { round1, round2, conditionOrder } = SEQUENCES[sequenceId];
    if (conditionOrder === "SA") {
      assert.equal(round1.facilitation, "static", `${sequenceId} (SA) round1 must be static`);
      assert.equal(round2.facilitation, "adaptive", `${sequenceId} (SA) round2 must be adaptive`);
    } else if (conditionOrder === "AS") {
      assert.equal(round1.facilitation, "adaptive", `${sequenceId} (AS) round1 must be adaptive`);
      assert.equal(round2.facilitation, "static", `${sequenceId} (AS) round2 must be static`);
    } else {
      assert.fail(`unexpected conditionOrder ${JSON.stringify(conditionOrder)} for ${sequenceId}`);
    }
  }
  // At least one SA and one AS sequence must exist, or this test would
  // vacuously pass without ever exercising the reversal.
  const orders = SEQUENCE_IDS.map((id) => SEQUENCES[id].conditionOrder);
  assert.ok(orders.includes("SA") && orders.includes("AS"), "both condition orders must be represented across S1-S4");
});

test("treatment metadata cannot override the Round-level facilitation assignment: buildRoundFields's returned fields never include a treatment reference", () => {
  // buildRoundFields (Counterbalancing.mjs) returns ROUND_FIELD_KEYS
  // straight from the sequence table -- confirm none of those keys is
  // itself sourced from or named after "treatment", which would reopen a
  // path for treatment-level data to leak into round-level dispatch.
  const counterbalancingSource = readFileSync(path.join(__dirname, "Counterbalancing.mjs"), "utf8");
  const bodyStart = counterbalancingSource.indexOf("export function buildRoundFields");
  const bodyEnd = counterbalancingSource.indexOf("\nexport function validateGamePlayerCount", bodyStart);
  const buildRoundFieldsBody = counterbalancingSource.slice(bodyStart, bodyEnd !== -1 ? bodyEnd : bodyStart + 600);
  assert.doesNotMatch(buildRoundFieldsBody, /game\.get\("treatment"\)/, "buildRoundFields must never read game.get(\"treatment\") to determine a Round's facilitation");
});

test("S1-S4 route according to their exact condition order (SA/AS) and produce the corresponding facilitationOrder", () => {
  const expected = {
    S1: { conditionOrder: "SA", facilitationOrder: ["static", "adaptive"] },
    S2: { conditionOrder: "SA", facilitationOrder: ["static", "adaptive"] },
    S3: { conditionOrder: "AS", facilitationOrder: ["adaptive", "static"] },
    S4: { conditionOrder: "AS", facilitationOrder: ["adaptive", "static"] },
  };
  for (const sequenceId of SEQUENCE_IDS) {
    const entry = SEQUENCES[sequenceId];
    assert.equal(entry.conditionOrder, expected[sequenceId].conditionOrder, `${sequenceId} conditionOrder`);
    assert.deepEqual([...entry.facilitationOrder], expected[sequenceId].facilitationOrder, `${sequenceId} facilitationOrder`);
    assert.deepEqual([entry.round1.facilitation, entry.round2.facilitation], [...entry.facilitationOrder], `${sequenceId} round1/round2 facilitation must match facilitationOrder in sequence`);
  }
});
