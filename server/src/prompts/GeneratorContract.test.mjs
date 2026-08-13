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

test("strict parser: tolerates a single leading ```json + trailing ``` wrapper (Phase 6 pilot fix for MiniMax-Text-01 chatty output)", () => {
  // Phase 6 pilot update: the live model wraps its JSON in a
  // markdown code fence despite the prompt forbidding it. The parser
  // strips a single wrapper and parses the inside. Schema-level
  // strictness is unchanged (this test confirms both halves: the
  // wrapper IS stripped, AND the inside is still validated as a
  // single object).
  const result = parseGeneratorOutputStrict("```json\n" + JSON.stringify(VALID_CANDIDATE) + "\n```");
  assert.equal(result.ok, true);
  assert.deepEqual(result.parsed, VALID_CANDIDATE);
});

test("strict parser: tolerates a single leading ``` + trailing ``` wrapper (no language tag)", () => {
  const result = parseGeneratorOutputStrict("```\n" + JSON.stringify(VALID_CANDIDATE) + "\n```");
  assert.equal(result.ok, true);
  assert.deepEqual(result.parsed, VALID_CANDIDATE);
});

test("strict parser: tolerates a code fence with extra surrounding whitespace", () => {
  const result = parseGeneratorOutputStrict("  \n```json\n" + JSON.stringify(VALID_CANDIDATE) + "\n```\n  ");
  assert.equal(result.ok, true);
  assert.deepEqual(result.parsed, VALID_CANDIDATE);
});

test("strict parser: tolerates an uppercase JSON code-fence label from a live provider", () => {
  const result = strictParseJsonObject('```JSON\n{"role":"STATIC"}\n```');
  assert.equal(result.ok, true);
  assert.equal(result.parsed.role, "STATIC");
});

test("strict parser: still rejects an EMPTY code fence (the inside must still be valid JSON)", () => {
  const result = parseGeneratorOutputStrict("```json\n\n```");
  assert.equal(result.ok, false);
  assert.equal(result.code, "GENERATOR_PARSE_FAILURE");
});

test("strict parser: still rejects a code fence wrapping INVALID JSON", () => {
  // The fence-strip fallback succeeds syntactically (extracts the
  // inside), but the inside is still invalid JSON. The original
  // strictness is preserved here.
  const result = parseGeneratorOutputStrict("```json\n{not: valid}\n```");
  assert.equal(result.ok, false);
  assert.equal(result.code, "GENERATOR_PARSE_FAILURE");
  assert.match(result.error, /after code-fence strip/);
});

test("strict parser: rejects prose before the JSON object (no fence)", () => {
  const result = parseGeneratorOutputStrict("Sure, here is my answer: " + JSON.stringify(VALID_CANDIDATE));
  assert.equal(result.ok, false);
});

test("strict parser: rejects prose after the JSON object (no fence)", () => {
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

// ── 2026-08-13 mention-pilot regression cases ────────────────────────────────
//
// The 2026-08-13 16:05 / 21:33 mention-pilot exposed a strict-plan-evidence
// over-constraint. The plan's `evidenceIds` is the LLM's snapshot of which
// public messages support the detected gap; the Generator must ground only
// in that set. In practice the plan is too narrow: the Generator legitimately
// wants to cite adjacent messages for context, and the LLM-built plan
// frequently misses the very message the Generator ended up grounding in
// (e.g. an `expander_broad_silence` plan that forgot to include the
// single-spoken message in evidenceIds). The current strict subset check
// then fails the candidate on GROUNDING_ID_OUTSIDE_PLAN_EVIDENCE even though
// the grounding ID is a legitimate public participant message.
//
// The principled fix: the plan's evidenceIds is a *hint* (helps the Generator
// focus), not a hard *constraint*. The hard constraint is "grounding ID must
// be a public participant message that isn't a recent AI message". When
// the Generator goes outside the plan but stays inside the public transcript,
// the plan was probably too narrow -- the Generator's choice is at least as
// defensible as the plan's. The two tests below pin the corrected behaviour.

test("deterministic validation: a grounding ID in eligibleMessageIds but not in allowedGroundingIds is accepted (the plan is a hint, not a hard constraint)", () => {
  const ctx = { ...DETERMINISTIC_CONTEXT, allowedGroundingIds: ["m0"] };  // plan only authorises m0
  const result = runDeterministicValidation(
    { role: "INFORMATION_EXPANDER", message: "x", groundingMessageIds: ["m2"] },  // Generator grounded in m2
    ctx,
  );
  assert.equal(result.passed, true, `unexpected failed criteria: ${result.failedCriteria.join(", ")}`);
  assert.equal(result.failedCriteria.includes("GROUNDING_ID_OUTSIDE_PLAN_EVIDENCE"), false);
});

test("deterministic validation: a grounding ID outside both allowedGroundingIds and eligibleMessageIds is still rejected (the public-transcript check is the real constraint)", () => {
  const ctx = { ...DETERMINISTIC_CONTEXT, allowedGroundingIds: ["m0"] };
  const result = runDeterministicValidation(
    { role: "INFORMATION_EXPANDER", message: "x", groundingMessageIds: ["m999"] },
    ctx,
  );
  assert.ok(result.failedCriteria.includes("UNKNOWN_GROUNDING_ID"));
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

// ── deterministic @-mention hygiene (2026-08-13) ────────────────────────

const MENTION_CONTEXT = {
  ...DETERMINISTIC_CONTEXT,
  activeParticipantNames: ["Alex", "Sam", "Pat", "Jordan"],
};

test("deterministic @-mention: a single valid @[Name] against a known participant passes", () => {
  const result = runDeterministicValidation({ role: "INFORMATION_EXPANDER", message: "@[Alex], anything to add?", groundingMessageIds: [] }, MENTION_CONTEXT);
  assert.equal(result.passed, true, `unexpected failed criteria: ${result.failedCriteria.join(", ")}`);
});

test("deterministic @-mention: a no-mention message still passes (tagging is optional)", () => {
  const result = runDeterministicValidation({ role: "INFORMATION_EXPANDER", message: "Has anyone else got something to share?", groundingMessageIds: [] }, MENTION_CONTEXT);
  assert.equal(result.passed, true);
});

test("deterministic @-mention: multiple @[Name] tokens against known participants are allowed (no per-message count cap, matches Alsobay et al. and normal group-member behaviour)", () => {
  const result = runDeterministicValidation({ role: "INFORMATION_EXPANDER", message: "@[Alex] @[Sam] @[Pat], anything to add?", groundingMessageIds: [] }, MENTION_CONTEXT);
  assert.equal(result.passed, true, `unexpected failed criteria: ${result.failedCriteria.join(", ")}`);
});

test("deterministic @-mention: a broad participation-imbalance nudge naming everyone silent is allowed", () => {
  const result = runDeterministicValidation({ role: "INFORMATION_EXPANDER", message: "@[Alex] @[Sam] @[Pat] @[Jordan], I haven't heard from any of you yet — anything from your reports you think the group is missing?", groundingMessageIds: [] }, MENTION_CONTEXT);
  assert.equal(result.passed, true, `unexpected failed criteria: ${result.failedCriteria.join(", ")}`);
});

test("deterministic @-mention: a Synthesiser naming two sources of a two-sided comparison is allowed", () => {
  const synthContext = { ...MENTION_CONTEXT, selectedRole: "INFORMATION_SYNTHESISER" };
  const result = runDeterministicValidation({ role: "INFORMATION_SYNTHESISER", message: "For delivery time, @[Sam] gave Option A as 12 days and @[Pat]'s report gave Option B as 18 days. Is anything about this comparison still unclear?", groundingMessageIds: [] }, synthContext);
  assert.equal(result.passed, true, `unexpected failed criteria: ${result.failedCriteria.join(", ")}`);
});

test("deterministic @-mention: flags UNKNOWN_MENTION_TARGET for a name not in the roster", () => {
  const result = runDeterministicValidation({ role: "INFORMATION_EXPANDER", message: "@[Nina], what's your view?", groundingMessageIds: [] }, MENTION_CONTEXT);
  assert.ok(result.failedCriteria.includes("UNKNOWN_MENTION_TARGET"));
});

test("deterministic @-mention: flags UNKNOWN_MENTION_TARGET even when one valid name and one unknown name are tagged together", () => {
  const result = runDeterministicValidation({ role: "INFORMATION_EXPANDER", message: "@[Alex] @[Nina], please share.", groundingMessageIds: [] }, MENTION_CONTEXT);
  assert.ok(result.failedCriteria.includes("UNKNOWN_MENTION_TARGET"));
});

test("deterministic @-mention: flags FACILITATOR_SELF_MENTION", () => {
  const result = runDeterministicValidation({ role: "INFORMATION_EXPANDER", message: "@[Facilitator], can you decide for us?", groundingMessageIds: [] }, MENTION_CONTEXT);
  assert.ok(result.failedCriteria.includes("FACILITATOR_SELF_MENTION"));
});

test("deterministic @-mention: FACILITATOR_SELF_MENTION is reported once even if the Facilitator is tagged multiple times in the same message (single offence, not N offences)", () => {
  const result = runDeterministicValidation({ role: "INFORMATION_EXPANDER", message: "@[Facilitator] @[facilitator] what do we do?", groundingMessageIds: [] }, MENTION_CONTEXT);
  const count = result.failedCriteria.filter((c) => c === "FACILITATOR_SELF_MENTION").length;
  assert.equal(count, 1);
});

test("deterministic @-mention: case-insensitive name match (matches the client UI's case-insensitive mention rendering)", () => {
  const result = runDeterministicValidation({ role: "INFORMATION_EXPANDER", message: "@[ALEX], please share.", groundingMessageIds: [] }, MENTION_CONTEXT);
  assert.equal(result.passed, true);
});

test("deterministic @-mention: FACILITATOR_SELF_MENTION check is also case-insensitive", () => {
  const result = runDeterministicValidation({ role: "INFORMATION_EXPANDER", message: "@[facilitator], what should we do?", groundingMessageIds: [] }, MENTION_CONTEXT);
  assert.ok(result.failedCriteria.includes("FACILITATOR_SELF_MENTION"));
});

test("deterministic @-mention: bare @Alex (no square brackets) is NOT a mention and does not flag any @-criteria", () => {
  const result = runDeterministicValidation({ role: "INFORMATION_EXPANDER", message: "Hey @Alex, how about it?", groundingMessageIds: [] }, MENTION_CONTEXT);
  assert.equal(result.failedCriteria.includes("UNKNOWN_MENTION_TARGET"), false);
});

test("deterministic @-mention: check is disabled when activeParticipantNames is omitted (only intended in tests of the check itself)", () => {
  const result = runDeterministicValidation({ role: "INFORMATION_EXPANDER", message: "@[Anyone], please share.", groundingMessageIds: [] }, DETERMINISTIC_CONTEXT);
  assert.equal(result.passed, true, "@-check must be a no-op when no roster is supplied; the Validator LLM still catches misuse semantically");
});

test("deterministic @-mention: check is disabled when activeParticipantNames is an empty array (no participants known yet)", () => {
  const result = runDeterministicValidation({ role: "INFORMATION_EXPANDER", message: "@[Anyone], please share.", groundingMessageIds: [] }, { ...DETERMINISTIC_CONTEXT, activeParticipantNames: [] });
  assert.equal(result.passed, true);
});
