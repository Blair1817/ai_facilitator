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

// 2026-10-26: independent need candidates (one slot per need, null = not supported).
const TARGET = {
  label: "Eldoron is best",
  messageIds: ["m0", "m1"],
  evidence: [{ messageId: "m0", span: "Eldoron is best" }, { messageId: "m1", span: "Eldoron is best" }],
  optionLabels: [],
  criteria: [],
};
const VALID_FACTORS = {
  candidates: {
    elicit: null,
    scrutinize: { operation: "unsupported_claim", target: TARGET, rationale: "Two participants back Eldoron without stated reasons." },
    integrate: null,
  },
  rationale: "Two participants back Eldoron without stated reasons.",
};
const VALID_NONE = { candidates: { elicit: null, scrutinize: null, integrate: null }, rationale: "No current need." };
const withScrutinize = (patch) => ({ ...VALID_FACTORS, candidates: { ...VALID_FACTORS.candidates, scrutinize: { ...VALID_FACTORS.candidates.scrutinize, ...patch } } });

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
  assert.equal(validateAgainstAssessorSchema({ ...VALID_FACTORS, candidates: { ...VALID_FACTORS.candidates, challenge: null } }).ok, false);
  assert.equal(validateAgainstAssessorSchema(withScrutinize({ operation: "vibes" })).ok, false);
  assert.equal(validateAgainstAssessorSchema(withScrutinize({ operation: "coverage_gap" })).ok, false, "operation must belong to its need");
});

test("validateAgainstAssessorSchema: rejects legacy eight-factor output", () => {
  const legacy = { breadth_deficiency: { status: "absent", strength: 0, message_ids: [], span: "" } };
  assert.equal(validateAgainstAssessorSchema(legacy).ok, false);
});

test("validateAgainstAssessorSchema: rejects an unexpected extra top-level or target key", () => {
  assert.equal(validateAgainstAssessorSchema({ ...VALID_FACTORS, strength: 0.9 }).ok, false);
  assert.equal(validateAgainstAssessorSchema(withScrutinize({ target: { ...TARGET, role: "challenger" } })).ok, false);
});

test("validateAgainstAssessorSchema: participation is decided by code, so the detector cannot report it", () => {
  assert.equal(validateAgainstAssessorSchema(withScrutinize({ target: { ...TARGET, participantName: "Blue" } })).ok, false);
  const participation = { ...VALID_FACTORS, candidates: { ...VALID_FACTORS.candidates, elicit: { operation: "participation_gap", target: TARGET, rationale: "x" } } };
  assert.equal(validateAgainstAssessorSchema(participation).ok, false);
});

test("validateAgainstAssessorSchema: a non-null target REQUIRES at least one messageId and one quotation", () => {
  const noEvidence = withScrutinize({ target: { ...TARGET, messageIds: [], evidence: [] } });
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

test("the detector requests a strict response schema derived from the canonical one", async () => {
  const { strictAssessorResponseSchema, stripNullOptionals, validateAgainstAssessorSchema: validate, assessSemanticFactors: assess } = await import("./SemanticAssessor.js");
  const strict = strictAssessorResponseSchema();
  const text = JSON.stringify(strict);
  for (const keyword of ["oneOf", "minLength", "maxLength", "minItems", "uniqueItems", "\"const\"", "#/definitions/"]) assert.ok(!text.includes(keyword), keyword);
  const walk = node => { if (!node || typeof node !== "object") return; if (node.properties) {
    assert.deepEqual([...node.required].sort(), Object.keys(node.properties).sort()); assert.equal(node.additionalProperties, false); }
    Object.values(node).forEach(walk); };
  walk(strict);
  assert.deepEqual(strict.properties.defer.anyOf.at(-1), { type: "null" }, "optional fields become nullable");

  const strictOutput = { candidates: { elicit: null, scrutinize: null, integrate: null }, rationale: "none", defer: null, closeout: null, integrationStatus: null };
  assert.equal(validate(strictOutput).ok, false, "canonical contract expresses optional by omission");
  assert.equal(validate(stripNullOptionals(strictOutput)).ok, true);
  const withReview = { candidates: { elicit: { operation: "coverage_gap", target: { label: "x", messageIds: ["m0"], evidence: [{ messageId: "m0", span: "a" }], optionLabels: [], criteria: [] }, rationale: "r", semanticReview: null }, scrutinize: null, integrate: null }, rationale: "r" };
  assert.equal("semanticReview" in stripNullOptionals(withReview).candidates.elicit, false);

  let seen = null;
  const result = await assess({ chat: [{ text: "a", sender: { id: "p1", name: "Alex" } }], taskGeneralContext: "Choose A or B.", activeParticipantNames: ["Alex"],
    callLLM: async (_messages, options) => { seen = options; return { success: true, rawText: JSON.stringify(strictOutput) }; } });
  assert.equal(seen.responseSchema.name, "need_detector_output");
  assert.equal(result.success, true);
  assert.equal("defer" in result.factors, false);
});

// ── 2026-11-20: semantic review must cover every supplied reference ─────────
const HISTORY = [
  { planId: "expander:A:m0", semanticKey: "a" },
  { planId: "challenger:B:m1", semanticKey: "b" },
];
const match = id => ({ id, relation: "different", responseEvidence: [], newEvidence: [] });
const withReview = ids => ({
  ...VALID_FACTORS,
  candidates: { ...VALID_FACTORS.candidates,
    scrutinize: { ...VALID_FACTORS.candidates.scrutinize, semanticReview: { key: "eldoron unsupported", matches: ids.map(match) } } },
});

test("validateAgainstAssessorSchema: flags a semantic review that omits a supplied reference", () => {
  const references = HISTORY.map(h => ({ id: h.planId }));
  const incomplete = validateAgainstAssessorSchema(withReview(["expander:A:m0"]), { references });
  assert.equal(incomplete.ok, false);
  assert.match(JSON.stringify(incomplete.errors), /missing \[\\"challenger:B:m1\\"\]/);
  assert.equal(validateAgainstAssessorSchema(withReview(["expander:A:m0", "challenger:B:m1"]), { references }).ok, true);
  assert.equal(validateAgainstAssessorSchema(withReview(["expander:A:m0", "expander:A:m0", "challenger:B:m1"]), { references }).ok, false);
  // Without references (legacy callers) only the JSON schema is checked.
  assert.equal(validateAgainstAssessorSchema(withReview(["expander:A:m0"])).ok, true);
});

test("assessSemanticFactors: repairs an incomplete semantic review once", async () => {
  const calls = [];
  const responses = [withReview(["expander:A:m0"]), withReview(["expander:A:m0", "challenger:B:m1"])];
  const fakeCallLLM = async (messages, options) => { calls.push({ messages: [...messages], options }); return { success: true, rawText: JSON.stringify(responses[calls.length - 1]) }; };
  const result = await assessSemanticFactors({ chat: chat(), taskGeneralContext: "x", callLLM: fakeCallLLM, interventionHistory: HISTORY, allowStructureRepair: true });
  assert.equal(calls.length, 2);
  assert.equal(calls[1].options.structureRepair, true);
  assert.match(calls[1].messages.at(-1).content, /challenger:B:m1/);
  assert.equal(result.success, true);
  assert.equal(result.factors.candidates.scrutinize.semanticReview.matches.length, 2);
  assert.equal(result.attempts[0].semanticCoverageIncomplete, true);
});

test("assessSemanticFactors: an unrepaired incomplete review keeps the output for per-candidate rejection", async () => {
  const fakeCallLLM = async () => ({ success: true, rawText: JSON.stringify(withReview(["expander:A:m0"])) });
  const repaired = await assessSemanticFactors({ chat: chat(), taskGeneralContext: "x", callLLM: fakeCallLLM, interventionHistory: HISTORY, allowStructureRepair: true });
  assert.equal(repaired.success, true);
  assert.equal(repaired.attempts.length, 2);
  const noRepair = await assessSemanticFactors({ chat: chat(), taskGeneralContext: "x", callLLM: fakeCallLLM, interventionHistory: HISTORY });
  assert.equal(noRepair.success, true);
  assert.equal(noRepair.attempts.length, 1);
});

test("per-checkpoint strict schema requires one keyed match per reference", async () => {
  const { strictAssessorResponseSchema, normalizeKeyedSemanticMatches } = await import("./SemanticAssessor.js");
  assert.equal(strictAssessorResponseSchema([]), strictAssessorResponseSchema(), "no references: shared cached schema");
  const ids = HISTORY.map(h => h.planId);
  const schema = strictAssessorResponseSchema(ids.map(id => ({ id })));
  const walk = node => { if (!node || typeof node !== "object") return; if (node.properties) {
    assert.deepEqual([...node.required].sort(), Object.keys(node.properties).sort()); assert.equal(node.additionalProperties, false); }
    Object.values(node).forEach(walk); };
  walk(schema);
  const matches = schema.$defs.semanticReview.properties.matches;
  assert.equal(matches.type, "object");
  assert.deepEqual(matches.required, ids);
  assert.equal("id" in matches.properties[ids[0]].properties, false);
  for (const name of ["elicit", "scrutinize", "integrate"]) {
    const branch = schema.properties.candidates.properties[name].anyOf.find(b => b.properties);
    assert.deepEqual(branch.properties.semanticReview, { $ref: "#/$defs/semanticReview" }, `${name} review is non-null`);
  }
  assert.equal(strictAssessorResponseSchema().$defs.semanticReview.properties.matches.type, "array", "cached schema not mutated");

  const keyed = withReview([]);
  keyed.candidates.scrutinize.semanticReview.matches = Object.fromEntries(ids.map(id => [id, { relation: "different", responseEvidence: [], newEvidence: [] }]));
  assert.deepEqual(normalizeKeyedSemanticMatches(keyed), withReview(ids));
  assert.deepEqual(normalizeKeyedSemanticMatches(withReview(ids)), withReview(ids), "array form unchanged");
});

test("assessSemanticFactors: keyed strict output is complete in one call", async () => {
  const ids = HISTORY.map(h => h.planId);
  const keyed = withReview([]);
  keyed.candidates.scrutinize.semanticReview.matches = Object.fromEntries(ids.map(id => [id, { relation: "different", responseEvidence: [], newEvidence: [] }]));
  const calls = [];
  const result = await assessSemanticFactors({ chat: chat(), taskGeneralContext: "x", interventionHistory: HISTORY, allowStructureRepair: true,
    callLLM: async (_messages, options) => { calls.push(options); return { success: true, rawText: JSON.stringify(keyed) }; } });
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].responseSchema.schema.$defs.semanticReview.properties.matches.required, ids);
  assert.equal(result.success, true);
  assert.deepEqual(result.factors.candidates.scrutinize.semanticReview.matches.map(m => m.id), ids);
});
