// Minimal, dependency-free routing test. No test framework exists in this
// project (server/package.json has no jest/vitest/mocha), so this uses only
// Node's built-in assert/test runner rather than adding a new dependency.
// Run with: node server/src/ConditionRouting.test.mjs
//
// This tests ROUTING only: whether a given `facilitation` value reaches an
// eligible dispatch. It does not call getLLMResponse/fetch, does not use a
// real API key, and does not claim a full Static/Adaptive intervention
// succeeds -- INTERVENTION_HANDLER_IMPLEMENTED in ConditionRouting.mjs is
// currently false for both, so "static"/"adaptive" are correctly *recognized*
// but never currently *eligible*, matching the real, current state of the
// codebase (no intervention handler implemented yet).
import assert from "node:assert/strict";
import test from "node:test";
import { resolveFacilitationDispatch } from "./ConditionRouting.mjs";

// Mirrors the exact gate used in callbacks.js's onStageStart/chat listener:
// only `dispatch.eligible` may proceed to attempt an LLM request.
function countEligibleDispatches(facilitationValues) {
  let llmRequestCount = 0;
  for (const facilitation of facilitationValues) {
    const dispatch = resolveFacilitationDispatch(facilitation);
    if (dispatch.eligible) {
      llmRequestCount += 1; // stand-in for "would call getLLMResponse()"
    }
  }
  return llmRequestCount;
}

test("none: never eligible, LLM request count = 0", () => {
  const dispatch = resolveFacilitationDispatch("none");
  assert.equal(dispatch.kind, "none");
  assert.equal(dispatch.eligible, false);
  assert.equal(countEligibleDispatches(["none", "none", "none"]), 0);
});

test("static: recognized and routed to the static dispatch kind", () => {
  const dispatch = resolveFacilitationDispatch("static");
  assert.equal(dispatch.kind, "static");
  // Not currently eligible -- no intervention handler implemented yet
  // (see LLMConfig.js blocker). Routing correctness != full intervention success.
  assert.equal(dispatch.eligible, false);
});

test("adaptive: recognized and routed to the adaptive dispatch kind", () => {
  const dispatch = resolveFacilitationDispatch("adaptive");
  assert.equal(dispatch.kind, "adaptive");
  assert.equal(dispatch.eligible, false);
});

test("missing value (undefined): fail closed, LLM request count = 0", () => {
  const dispatch = resolveFacilitationDispatch(undefined);
  assert.equal(dispatch.kind, "unknown");
  assert.equal(dispatch.eligible, false);
  assert.equal(countEligibleDispatches([undefined]), 0);
});

test("unknown/misspelled value: fail closed, LLM request count = 0", () => {
  const dispatch = resolveFacilitationDispatch("staticc");
  assert.equal(dispatch.kind, "unknown");
  assert.equal(dispatch.eligible, false);
  assert.equal(countEligibleDispatches(["Static", "ADAPTIVE", "staticc", ""]), 0);
});

test('"LLM": the old sentinel is no longer a valid condition', () => {
  const dispatch = resolveFacilitationDispatch("LLM");
  assert.equal(dispatch.kind, "unknown");
  assert.equal(dispatch.eligible, false);
});

test("mixed batch: only recognized+implemented conditions would ever count (currently none)", () => {
  const count = countEligibleDispatches(["none", "static", "adaptive", "LLM", undefined, "bogus"]);
  assert.equal(count, 0); // true today because no handler is implemented yet; see blocker above
});
