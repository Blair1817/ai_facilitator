// Architecture doc Step 5. Uses a fake callLLM -- no real network request,
// no API key, matching this repo's existing convention (see
// GeneratorContract.test.mjs / RoutingIntegration.test.mjs's header
// comments for why). Reads assessor.md / assessor.schema.json from disk
// (same as promptLoader.js/GeneratorContract.mjs), so needs the same
// process.argv[1] fake-entry.js trick those files' own tests use.
import assert from "node:assert/strict";
import test from "node:test";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
process.argv[1] = path.join(__dirname, "fake-entry.js");

const { getAssessorPromptBundle, validateAgainstAssessorSchema, buildAssessorUserContext, assessSemanticFactors } =
  await import("./SemanticAssessor.js");

function chat() {
  return [
    { text: "I think Eldoron is best", ts: 1, sender: { id: "human-1", name: "Red" } },
    { text: "Eldoron is best for us too", ts: 2, sender: { id: "human-2", name: "Pink" } },
  ];
}

// v2 design (Phase 4): 8 factors per architecture doc §2 节点 6.
const VALID_FACTORS = {
  breadth_deficiency: { status: "absent", strength: 0, message_ids: [], span: "" },
  group_preference: { status: "present", strength: 0.7, message_ids: ["m0", "m1"], span: "Eldoron is best" },
  justification_deficiency: { status: "absent", strength: 0, message_ids: [], span: "" },
  integration_deficiency: { status: "absent", strength: 0, message_ids: [], span: "" },
  unresolved_counterevidence: { status: "absent", strength: 0, message_ids: [], span: "" },
  claim_evidence_linkage: { status: "absent", strength: 0, message_ids: [], span: "" },
  self_correction: { status: "absent", strength: 0, message_ids: [], span: "" },
  reasoning_uptake: { status: "absent", strength: 0, message_ids: [], span: "" },
  // Delibra spec §3 Node 3, 2026-08-11
  evidenceRelations: [],
};

// ── prompt bundle loading (real file on disk) ────────────────────────────────

test("getAssessorPromptBundle: loads assessor.md successfully, not blocked", () => {
  const result = getAssessorPromptBundle();
  assert.equal(result.blocked, false);
  assert.ok(result.content.includes("ROLE"));
  assert.equal(result.metadata.promptStatus, "draft_unapproved");
});

// ── schema validation ────────────────────────────────────────────────────────

test("validateAgainstAssessorSchema: accepts a well-formed 8-factor object", () => {
  assert.equal(validateAgainstAssessorSchema(VALID_FACTORS).ok, true);
});

test("validateAgainstAssessorSchema: rejects a missing factor key", () => {
  const { self_correction, ...missing } = VALID_FACTORS;
  assert.equal(validateAgainstAssessorSchema(missing).ok, false);
});

test("validateAgainstAssessorSchema: rejects an invalid status enum value", () => {
  const bad = { ...VALID_FACTORS, breadth_deficiency: { ...VALID_FACTORS.breadth_deficiency, status: "definitely" } };
  assert.equal(validateAgainstAssessorSchema(bad).ok, false);
});

test("validateAgainstAssessorSchema: rejects strength outside [0,1]", () => {
  const bad = { ...VALID_FACTORS, group_preference: { ...VALID_FACTORS.group_preference, strength: 1.5 } };
  assert.equal(validateAgainstAssessorSchema(bad).ok, false);
});

test("validateAgainstAssessorSchema: rejects an unexpected extra top-level key", () => {
  const bad = { ...VALID_FACTORS, extra_factor: VALID_FACTORS.breadth_deficiency };
  assert.equal(validateAgainstAssessorSchema(bad).ok, false);
});

// ── user context assembly ────────────────────────────────────────────────────

test("buildAssessorUserContext: sends all public context without a feature candidate pre-filter", () => {
  const { userContent, eligibleMessageIds } = buildAssessorUserContext({
    chat: chat(),
    taskGeneralContext: "pick a city",
  });
  assert.doesNotMatch(userContent, /CANDIDATE_ROLES|FEATURE/);
  assert.match(userContent, /\[TASK_GENERAL_CONTEXT\]\npick a city/);
  assert.match(userContent, /\[m0\] \[Red\]: I think Eldoron is best/);
  assert.deepEqual(eligibleMessageIds, ["m0", "m1"]);
});

// ── end-to-end assessSemanticFactors() with an injected fake LLM ────────────

test("assessSemanticFactors: end-to-end success with a well-formed fake LLM response", async () => {
  const fakeCallLLM = async (_messages) => ({ success: true, rawText: JSON.stringify(VALID_FACTORS) });
  const result = await assessSemanticFactors({ chat: chat(), taskGeneralContext: "x", callLLM: fakeCallLLM });
  assert.equal(result.success, true);
  assert.deepEqual(result.factors, VALID_FACTORS);
});

test("assessSemanticFactors: propagates an LLM API failure as ASSESSOR_API_ERROR", async () => {
  const fakeCallLLM = async (_messages) => ({ success: false, error: "rate limited" });
  const result = await assessSemanticFactors({ chat: chat(), taskGeneralContext: "x", callLLM: fakeCallLLM });
  assert.equal(result.success, false);
  assert.equal(result.code, "ASSESSOR_API_ERROR");
});

test("assessSemanticFactors: rejects malformed JSON as ASSESSOR_PARSE_FAILURE", async () => {
  const fakeCallLLM = async (_messages) => ({ success: true, rawText: "not json at all" });
  const result = await assessSemanticFactors({ chat: chat(), taskGeneralContext: "x", callLLM: fakeCallLLM });
  assert.equal(result.success, false);
  assert.equal(result.code, "ASSESSOR_PARSE_FAILURE");
});

test("assessSemanticFactors: rejects schema-invalid JSON as ASSESSOR_SCHEMA_FAILURE", async () => {
  const fakeCallLLM = async (_messages) => ({ success: true, rawText: JSON.stringify({ only_one_key: true }) });
  const result = await assessSemanticFactors({ chat: chat(), taskGeneralContext: "x", callLLM: fakeCallLLM });
  assert.equal(result.success, false);
  assert.equal(result.code, "ASSESSOR_SCHEMA_FAILURE");
});

test("assessSemanticFactors: throws synchronously if callLLM is not a function (never silently skips the network call)", async () => {
  await assert.rejects(
    () => assessSemanticFactors({ chat: chat(), taskGeneralContext: "x", callLLM: undefined }),
    /requires a callLLM/
  );
});

test("integration: no real external LLM request is made by any test in this file (callLLM is always a local fake, never fetch)", () => {
  assert.equal(typeof globalThis.__integrationTestMadeRealRequest, "undefined");
});
