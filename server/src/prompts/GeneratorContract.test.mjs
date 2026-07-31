// Prompt 3B, requirements #6/#7/#8: strict Generator JSON parsing,
// generation.schema.json enforcement (with per-request role `const`), and
// deterministic validation. Pure-function tests -- no network, no Empirica.
import assert from "node:assert/strict";
import test from "node:test";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
process.argv[1] = path.join(__dirname, "..", "fake-entry.js");

const {
  strictParseJsonObject,
  parseGeneratorOutputStrict,
  buildRuntimeGenerationSchema,
  validateAgainstGenerationSchema,
  runDeterministicValidation,
} = await import("./GeneratorContract.mjs");

const VALID_CANDIDATE = { role: "INFORMATION_EXPANDER", message: "Is there anything else anyone has not shared yet?", groundingMessageIds: [] };

// ── strict JSON parsing ──────────────────────────────────────────────────

test("strict parser: accepts a single valid JSON object", () => {
  const result = parseGeneratorOutputStrict(JSON.stringify(VALID_CANDIDATE));
  assert.equal(result.ok, true);
  assert.deepEqual(result.parsed, VALID_CANDIDATE);
});

test("strict parser: rejects invalid JSON", () => {
  const result = parseGeneratorOutputStrict("{role: INFORMATION_EXPANDER, message: 'hi'}");
  assert.equal(result.ok, false);
  assert.equal(result.code, "GENERATOR_PARSE_FAILURE");
});

test("strict parser: rejects markdown code-fenced JSON", () => {
  const result = parseGeneratorOutputStrict("```json\n" + JSON.stringify(VALID_CANDIDATE) + "\n```");
  assert.equal(result.ok, false);
});

test("strict parser: rejects prose before the JSON object", () => {
  const result = parseGeneratorOutputStrict("Sure, here is my answer: " + JSON.stringify(VALID_CANDIDATE));
  assert.equal(result.ok, false);
});

test("strict parser: rejects prose after the JSON object", () => {
  const result = parseGeneratorOutputStrict(JSON.stringify(VALID_CANDIDATE) + "\nHope that helps!");
  assert.equal(result.ok, false);
});

test("strict parser: rejects a bare JSON array (not a single object)", () => {
  const result = parseGeneratorOutputStrict(JSON.stringify([VALID_CANDIDATE]));
  assert.equal(result.ok, false);
});

test("strict parser: rejects a bare JSON primitive", () => {
  assert.equal(parseGeneratorOutputStrict('"just a string"').ok, false);
  assert.equal(parseGeneratorOutputStrict("42").ok, false);
  assert.equal(parseGeneratorOutputStrict("null").ok, false);
});

test("strict parser: rejects the legacy DECISION/WAIT/MESSAGE/RATIONALE output contract outright (not valid JSON)", () => {
  const legacy = 'DECISION: WAIT\nMESSAGE: "Let us hear more."\nRATIONALE: agreement is low';
  const result = parseGeneratorOutputStrict(legacy);
  assert.equal(result.ok, false);
  assert.equal(result.code, "GENERATOR_PARSE_FAILURE");
});

test("strict parser: does not do permissive regex extraction (a JSON object embedded in other text is still rejected wholesale)", () => {
  const result = parseGeneratorOutputStrict(`noise ${JSON.stringify(VALID_CANDIDATE)} noise`);
  assert.equal(result.ok, false, "must not extract and accept the embedded JSON object");
});

// ── generation.schema.json enforcement ──────────────────────────────────

test("generation schema: accepts a candidate whose role matches SELECTED_ROLE", () => {
  const result = validateAgainstGenerationSchema(VALID_CANDIDATE, "INFORMATION_EXPANDER");
  assert.equal(result.ok, true);
});

test("generation schema: rejects missing required field", () => {
  const { message, ...withoutMessage } = VALID_CANDIDATE;
  const result = validateAgainstGenerationSchema(withoutMessage, "INFORMATION_EXPANDER");
  assert.equal(result.ok, false);
  assert.equal(result.code, "GENERATION_SCHEMA_FAILURE");
});

test("generation schema: rejects an additional/unexpected field", () => {
  const result = validateAgainstGenerationSchema({ ...VALID_CANDIDATE, rationale: "because" }, "INFORMATION_EXPANDER");
  assert.equal(result.ok, false);
});

test("generation schema: rejects incorrect field types", () => {
  const result = validateAgainstGenerationSchema({ ...VALID_CANDIDATE, groundingMessageIds: "m1" }, "INFORMATION_EXPANDER");
  assert.equal(result.ok, false);
});

test("generation schema: rejects an empty message", () => {
  const result = validateAgainstGenerationSchema({ ...VALID_CANDIDATE, message: "" }, "INFORMATION_EXPANDER");
  assert.equal(result.ok, false);
});

test("generation schema: rejects a role that differs from SELECTED_ROLE, via the per-request const", () => {
  const result = validateAgainstGenerationSchema({ ...VALID_CANDIDATE, role: "EVIDENCE_CHALLENGER" }, "INFORMATION_EXPANDER");
  assert.equal(result.ok, false);
});

test("generation schema: rejects duplicate grounding IDs (schema uniqueItems)", () => {
  const result = validateAgainstGenerationSchema({ ...VALID_CANDIDATE, groundingMessageIds: ["m1", "m1"] }, "INFORMATION_EXPANDER");
  assert.equal(result.ok, false);
});

test("generation schema: per-request runtime schema is non-mutating -- the shared source schema keeps its full role enum after building a runtime copy", () => {
  const before = JSON.stringify(buildRuntimeGenerationSchema("INFORMATION_EXPANDER"));
  buildRuntimeGenerationSchema("EVIDENCE_CHALLENGER");
  const after = JSON.stringify(buildRuntimeGenerationSchema("INFORMATION_EXPANDER"));
  assert.equal(before, after, "building a schema for one role must not affect schemas built for another role");
});

test("generation schema: concurrent requests with different selected roles receive independent runtime schemas that do not cross-validate", async () => {
  const [expanderSchema, challengerSchema] = await Promise.all([
    Promise.resolve().then(() => buildRuntimeGenerationSchema("INFORMATION_EXPANDER")),
    Promise.resolve().then(() => buildRuntimeGenerationSchema("EVIDENCE_CHALLENGER")),
  ]);
  assert.equal(expanderSchema.properties.role.const, "INFORMATION_EXPANDER");
  assert.equal(challengerSchema.properties.role.const, "EVIDENCE_CHALLENGER");
  assert.notEqual(expanderSchema, challengerSchema, "must be distinct object instances, not a shared mutated schema");

  const expanderCandidate = { role: "INFORMATION_EXPANDER", message: "x", groundingMessageIds: [] };
  const challengerCandidate = { role: "EVIDENCE_CHALLENGER", message: "y", groundingMessageIds: [] };
  assert.equal(validateAgainstGenerationSchema(expanderCandidate, "INFORMATION_EXPANDER").ok, true);
  assert.equal(validateAgainstGenerationSchema(expanderCandidate, "EVIDENCE_CHALLENGER").ok, false);
  assert.equal(validateAgainstGenerationSchema(challengerCandidate, "EVIDENCE_CHALLENGER").ok, true);
  assert.equal(validateAgainstGenerationSchema(challengerCandidate, "INFORMATION_EXPANDER").ok, false);
});

// ── deterministic validation ─────────────────────────────────────────────

const DETERMINISTIC_CONTEXT = {
  selectedRole: "INFORMATION_EXPANDER",
  eligibleMessageIds: ["m0", "m1", "m2"],
  aiOrSystemMessageIds: ["m3"],
  recentAiMessageTexts: ["Has everyone shared their materials?"],
};

test("deterministic validation: passes a fully valid candidate", () => {
  const result = runDeterministicValidation({ role: "INFORMATION_EXPANDER", message: "Any new info?", groundingMessageIds: ["m1"] }, DETERMINISTIC_CONTEXT);
  assert.equal(result.passed, true);
  assert.deepEqual(result.failedCriteria, []);
});

test("deterministic validation: flags ROLE_MISMATCH", () => {
  const result = runDeterministicValidation({ role: "EVIDENCE_CHALLENGER", message: "x", groundingMessageIds: [] }, DETERMINISTIC_CONTEXT);
  assert.ok(result.failedCriteria.includes("ROLE_MISMATCH"));
  assert.equal(result.passed, false);
});

test("deterministic validation: flags EMPTY_MESSAGE", () => {
  const result = runDeterministicValidation({ role: "INFORMATION_EXPANDER", message: "   ", groundingMessageIds: [] }, DETERMINISTIC_CONTEXT);
  assert.ok(result.failedCriteria.includes("EMPTY_MESSAGE"));
});

test("deterministic validation: flags MARKDOWN_DETECTED for a code fence", () => {
  const result = runDeterministicValidation({ role: "INFORMATION_EXPANDER", message: "```not allowed```", groundingMessageIds: [] }, DETERMINISTIC_CONTEXT);
  assert.ok(result.failedCriteria.includes("MARKDOWN_DETECTED"));
});

test("deterministic validation: flags MARKDOWN_DETECTED for a markdown list", () => {
  const result = runDeterministicValidation({ role: "INFORMATION_EXPANDER", message: "- point one\n- point two", groundingMessageIds: [] }, DETERMINISTIC_CONTEXT);
  assert.ok(result.failedCriteria.includes("MARKDOWN_DETECTED"));
});

test("deterministic validation: flags UNKNOWN_GROUNDING_ID for an ID not in the eligible public context", () => {
  const result = runDeterministicValidation({ role: "INFORMATION_EXPANDER", message: "x", groundingMessageIds: ["m999"] }, DETERMINISTIC_CONTEXT);
  assert.ok(result.failedCriteria.includes("UNKNOWN_GROUNDING_ID"));
});

test("deterministic validation: flags GROUNDING_ID_NOT_PARTICIPANT_MESSAGE for an ID that refers to an AI message", () => {
  const result = runDeterministicValidation({ role: "INFORMATION_EXPANDER", message: "x", groundingMessageIds: ["m3"] }, DETERMINISTIC_CONTEXT);
  assert.ok(result.failedCriteria.includes("GROUNDING_ID_NOT_PARTICIPANT_MESSAGE"));
});

test("deterministic validation: flags DUPLICATE_OF_RECENT_AI_MESSAGE for an exact normalized duplicate", () => {
  const result = runDeterministicValidation({ role: "INFORMATION_EXPANDER", message: "  Has  everyone shared their materials?  ", groundingMessageIds: [] }, DETERMINISTIC_CONTEXT);
  assert.ok(result.failedCriteria.includes("DUPLICATE_OF_RECENT_AI_MESSAGE"));
});

test("deterministic validation: a merely similar (non-exact) message is not flagged as a duplicate -- no invented similarity threshold", () => {
  const result = runDeterministicValidation({ role: "INFORMATION_EXPANDER", message: "Has everyone shared their materials with the group yet?", groundingMessageIds: [] }, DETERMINISTIC_CONTEXT);
  assert.equal(result.failedCriteria.includes("DUPLICATE_OF_RECENT_AI_MESSAGE"), false);
});

test("deterministic validation: flags UNEXPECTED_FIELD when an extra field is present", () => {
  const result = runDeterministicValidation({ role: "INFORMATION_EXPANDER", message: "x", groundingMessageIds: [], rationale: "y" }, DETERMINISTIC_CONTEXT);
  assert.ok(result.failedCriteria.includes("UNEXPECTED_FIELD"));
});

test("deterministic validation: does not mutate, repair, or replace the candidate", () => {
  const candidate = { role: "EVIDENCE_CHALLENGER", message: "```bad```", groundingMessageIds: ["m999"] };
  const before = JSON.stringify(candidate);
  runDeterministicValidation(candidate, DETERMINISTIC_CONTEXT);
  assert.equal(JSON.stringify(candidate), before, "deterministic validation must not repair or alter the candidate object");
});

test("deterministic validation: multiple simultaneous failures are all reported, not just the first", () => {
  const result = runDeterministicValidation({ role: "EVIDENCE_CHALLENGER", message: "", groundingMessageIds: ["m999"] }, DETERMINISTIC_CONTEXT);
  assert.ok(result.failedCriteria.includes("ROLE_MISMATCH"));
  assert.ok(result.failedCriteria.includes("EMPTY_MESSAGE"));
  assert.ok(result.failedCriteria.includes("UNKNOWN_GROUNDING_ID"));
});
