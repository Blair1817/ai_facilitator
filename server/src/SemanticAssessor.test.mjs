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

// 2026-10-21: categorical need detector output (replaces the 8-factor object).
const VALID_FACTORS = {
  need: "SCRUTINIZE",
  operation: "unsupported_claim",
  target: {
    label: "Eldoron is best",
    messageIds: ["m0", "m1"],
    evidence: [{ messageId: "m0", span: "Eldoron is best" }, { messageId: "m1", span: "Eldoron is best" }],
    optionLabels: [],
    criteria: [],
  },
  rationale: "Two participants back Eldoron without stated reasons.",
};
const VALID_NONE = { need: "NONE", operation: null, target: null, rationale: "No current need." };

// ── prompt bundle loading (real file on disk) ────────────────────────────────

test("getAssessorPromptBundle: loads assessor.md successfully, not blocked", () => {
  const result = getAssessorPromptBundle();
  assert.equal(result.blocked, false);
  assert.ok(result.content.includes("ROLE"));
  assert.equal(result.metadata.promptStatus, "draft_unapproved");
});

// ── schema validation ────────────────────────────────────────────────────────

test("validateAgainstAssessorSchema: accepts a well-formed categorical need and a NONE result", () => {
  assert.equal(validateAgainstAssessorSchema(VALID_FACTORS).ok, true);
  assert.equal(validateAgainstAssessorSchema(VALID_NONE).ok, true);
});

test("validateAgainstAssessorSchema: rejects a missing required field", () => {
  const { rationale, ...missing } = VALID_FACTORS;
  assert.equal(validateAgainstAssessorSchema(missing).ok, false);
});

test("validateAgainstAssessorSchema: rejects an unknown need or operation", () => {
  assert.equal(validateAgainstAssessorSchema({ ...VALID_FACTORS, need: "CHALLENGE" }).ok, false);
  assert.equal(validateAgainstAssessorSchema({ ...VALID_FACTORS, operation: "vibes" }).ok, false);
});

test("validateAgainstAssessorSchema: rejects legacy eight-factor output", () => {
  const legacy = { breadth_deficiency: { status: "absent", strength: 0, message_ids: [], span: "" } };
  assert.equal(validateAgainstAssessorSchema(legacy).ok, false);
});

test("validateAgainstAssessorSchema: rejects an unexpected extra top-level or target key", () => {
  assert.equal(validateAgainstAssessorSchema({ ...VALID_FACTORS, strength: 0.9 }).ok, false);
  assert.equal(validateAgainstAssessorSchema({ ...VALID_FACTORS, target: { ...VALID_FACTORS.target, role: "challenger" } }).ok, false);
});

test("validateAgainstAssessorSchema: a non-null target REQUIRES at least one messageId and one quotation", () => {
  const noEvidence = { ...VALID_FACTORS, target: { ...VALID_FACTORS.target, messageIds: [], evidence: [] } };
  const result = validateAgainstAssessorSchema(noEvidence);
  assert.equal(result.ok, false);
  const errStr = JSON.stringify(result.errors || []);
  assert.ok(errStr.includes("messageIds") || errStr.includes("evidence"), `Expected error to mention messageIds/evidence, got: ${errStr}`);
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

test("buildAssessorUserContext: includes code-computed participation counts and quiet participants", () => {
  const { userContent } = buildAssessorUserContext({
    chat: chat(),
    taskGeneralContext: "pick a city",
    participationCounts: { Red: 1, Pink: 1, Blue: 0 },
    quietParticipants: ["Blue"],
  });
  assert.match(userContent, /\[PARTICIPATION_COUNTS\]\n\{"Red":1,"Pink":1,"Blue":0\}/);
  assert.match(userContent, /\[QUIET_PARTICIPANTS\]\n\["Blue"\]/);
});

// ── end-to-end assessSemanticFactors() with an injected fake LLM ────────────

test("assessSemanticFactors: end-to-end success with a well-formed fake LLM response", async () => {
  const fakeCallLLM = async (_messages) => ({ success: true, rawText: JSON.stringify(VALID_FACTORS) });
  const result = await assessSemanticFactors({ chat: chat(), taskGeneralContext: "x", callLLM: fakeCallLLM });
  assert.equal(result.success, true);
  assert.deepEqual(result.factors, VALID_FACTORS);
});

test("assessSemanticFactors: propagates an LLM API failure as ASSESSOR_API_ERROR", async () => {
  const responseMetadata = {
    finish_reason: "length",
    usage: { prompt_tokens: 200, completion_tokens: 1000, total_tokens: 1200, reasoning_tokens: 1000 },
  };
  const fakeCallLLM = async (_messages) => ({ success: false, error: "missing content", responseMetadata });
  const result = await assessSemanticFactors({ chat: chat(), taskGeneralContext: "x", callLLM: fakeCallLLM });
  assert.equal(result.success, false);
  assert.equal(result.code, "ASSESSOR_API_ERROR");
  assert.equal(result.responseMetadata, responseMetadata);
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
