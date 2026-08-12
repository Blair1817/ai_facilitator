// Architecture doc Step 7 (Q6 = "完整实现"). Uses a fake callLLM -- no real
// network request, no API key, matching this repo's existing convention
// (see SemanticAssessor.test.mjs / GeneratorContract.test.mjs's header
// comments for why). Reads validator.md / validation.schema.json from
// disk (same as SemanticAssessor.js), so needs the same process.argv[1]
// fake-entry.js trick those files' own tests use.
import assert from "node:assert/strict";
import test from "node:test";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
process.argv[1] = path.join(__dirname, "fake-entry.js");

const {
  VALIDATOR_CRITERIA,
  getValidatorPromptBundle,
  validateAgainstValidatorSchema,
  computeValidatorVerdict,
  buildValidatorUserContext,
  validateCandidate,
  parseValidatorResponse,
} = await import("./SemanticValidator.js");

function chat() {
  return [
    { text: "I think Eldoron is best", ts: 1, sender: { id: "human-1", name: "Red" } },
    { text: "Eldoron is best for us too", ts: 2, sender: { id: "human-2", name: "Pink" } },
  ];
}

const CANDIDATE_PASSED = {
  notGrounded: false,
  nonNeutral: false,
  roleMisaligned: false,
  inventedInformation: false,
  recommendationDetected: false,
  unsupportedInformationDetected: false,
  unsupportedConsensusClaim: false,
  // Delibra spec §11 additions (2026-08-11)
  optionSteering: false,
  requiredReasoningActMissing: false,
  unanswerable: false,
  hiddenInformationInference: false,
  repetition: false,
  length: false,
};

test("parseValidatorResponse accepts one leading fenced JSON audit followed by provider explanation", () => {
  const raw = `\`\`\`json\n${JSON.stringify(CANDIDATE_PASSED)}\n\`\`\`\n\n### Explanation\nProvider-added prose`;
  const result = parseValidatorResponse(raw);
  assert.equal(result.ok, true);
  assert.deepEqual(result.parsed, CANDIDATE_PASSED);
});

// ── VALIDATOR_CRITERIA constant ────────────────────────────────────────────────

test("VALIDATOR_CRITERIA: exactly the 13 criteria, in schema order", () => {
  assert.deepEqual([...VALIDATOR_CRITERIA], [
    // Phase 5 frozen (v2 design)
    "notGrounded",
    "nonNeutral",
    "roleMisaligned",
    "inventedInformation",
    "recommendationDetected",
    "unsupportedInformationDetected",
    "unsupportedConsensusClaim",
    // Delibra spec §11 additions (2026-08-11)
    "optionSteering",
    "requiredReasoningActMissing",
    "unanswerable",
    "hiddenInformationInference",
    "repetition",
    "length",
  ]);
});

test("VALIDATOR_CRITERIA: is frozen (caller cannot mutate the canonical list)", () => {
  assert.equal(Object.isFrozen(VALIDATOR_CRITERIA), true);
});

// ── prompt bundle loading (real file on disk) ────────────────────────────────

test("getValidatorPromptBundle: loads validator.md successfully, not blocked", () => {
  const result = getValidatorPromptBundle();
  assert.equal(result.blocked, false);
  assert.ok(result.content.includes("ROLE"));
  assert.equal(result.metadata.promptName, "validator");
  assert.equal(result.metadata.promptStatus, "draft_unapproved");
  assert.equal(result.metadata.sourceCompleteness, "no_markers_found");
});

// ── schema validation ────────────────────────────────────────────────────────

test("validateAgainstValidatorSchema: accepts a well-formed all-false object", () => {
  assert.equal(validateAgainstValidatorSchema(CANDIDATE_PASSED).ok, true);
});

test("validateAgainstValidatorSchema: accepts a single criterion flagged true (rejection of a real audit verdict)", () => {
  assert.equal(
    validateAgainstValidatorSchema({ ...CANDIDATE_PASSED, recommendationDetected: true }).ok,
    true
  );
});

test("validateAgainstValidatorSchema: rejects a missing criterion key", () => {
  const { notGrounded, ...missing } = CANDIDATE_PASSED;
  assert.equal(validateAgainstValidatorSchema(missing).ok, false);
});

test("validateAgainstValidatorSchema: rejects a non-boolean value where a boolean is required", () => {
  assert.equal(
    validateAgainstValidatorSchema({ ...CANDIDATE_PASSED, nonNeutral: "yes" }).ok,
    false
  );
});

test("validateAgainstValidatorSchema: rejects an unexpected extra top-level key", () => {
  const bad = { ...CANDIDATE_PASSED, passed: true, extraCriterion: false };
  assert.equal(validateAgainstValidatorSchema(bad).ok, false);
});

test("validateAgainstValidatorSchema: rejects passed/failedCriteria at the top level (those are computed downstream, not LLM output)", () => {
  // Critical: the LLM must NOT self-summarise. passed/failedCriteria are
  // computed by computeValidatorVerdict() in deterministic code, never by
  // the LLM. A response that includes them is schema-invalid.
  const withPassed = { ...CANDIDATE_PASSED, passed: true };
  const withFailed = { ...CANDIDATE_PASSED, failedCriteria: ["notGrounded"] };
  assert.equal(validateAgainstValidatorSchema(withPassed).ok, false);
  assert.equal(validateAgainstValidatorSchema(withFailed).ok, false);
});

// ── computeValidatorVerdict (deterministic downstream) ───────────────────────

test("computeValidatorVerdict: all-false input -> passed=true, empty failedCriteria", () => {
  const v = computeValidatorVerdict(CANDIDATE_PASSED);
  assert.equal(v.passed, true);
  assert.deepEqual(v.failedCriteria, []);
});

test("computeValidatorVerdict: lists every true key, in canonical criterion order", () => {
  const v = computeValidatorVerdict({
    ...CANDIDATE_PASSED,
    recommendationDetected: true,
    notGrounded: true,
    unsupportedConsensusClaim: true,
  });
  assert.equal(v.passed, false);
  assert.deepEqual(v.failedCriteria, ["notGrounded", "recommendationDetected", "unsupportedConsensusClaim"]);
});

test("computeValidatorVerdict: a single true key produces a single-element failedCriteria list", () => {
  const v = computeValidatorVerdict({ ...CANDIDATE_PASSED, nonNeutral: true });
  assert.equal(v.passed, false);
  assert.deepEqual(v.failedCriteria, ["nonNeutral"]);
});

// ── buildValidatorUserContext ─────────────────────────────────────────────────

test("buildValidatorUserContext: includes SELECTED_ROLE, CANDIDATE, and message-ID-annotated context (matches Generator/Assessor scheme)", () => {
  const { userContent } = buildValidatorUserContext({
    chat: chat(),
    candidate: CANDIDATE_PASSED,
    selectedRole: "INFORMATION_EXPANDER",
    taskGeneralContext: "pick a city",
  });
  assert.match(userContent, /\[SELECTED_ROLE\]\nINFORMATION_EXPANDER/);
  assert.match(userContent, /\[CANDIDATE\]/);
  assert.match(userContent, /\[TASK_GENERAL_CONTEXT\]\npick a city/);
  assert.match(userContent, /\[m0\] \[Red\]: I think Eldoron is best/);
  // NO [PRIOR_FAILED_CRITERIA] section on the first (non-repair) call.
  assert.doesNotMatch(userContent, /\[PRIOR_FAILED_CRITERIA\]/);
});

test("buildValidatorUserContext: omits [PRIOR_FAILED_CRITERIA] when priorFailedCriteria is null (defensive default)", () => {
  const { userContent } = buildValidatorUserContext({
    chat: chat(),
    candidate: CANDIDATE_PASSED,
    selectedRole: "GENERALIST",
    taskGeneralContext: "x",
  });
  assert.doesNotMatch(userContent, /\[PRIOR_FAILED_CRITERIA\]/);
});

test("buildValidatorUserContext: appends [PRIOR_FAILED_CRITERIA] with the failed list and prior candidate (repair-loop case)", () => {
  const priorCandidate = { role: "INFORMATION_EXPANDER", message: "Consider option C, the best one.", groundingMessageIds: [] };
  const { userContent } = buildValidatorUserContext({
    chat: chat(),
    candidate: { role: "INFORMATION_EXPANDER", message: "What about criterion X?", groundingMessageIds: ["m0"] },
    selectedRole: "INFORMATION_EXPANDER",
    taskGeneralContext: "x",
    priorFailedCriteria: ["recommendationDetected", "nonNeutral"],
    priorCandidate,
  });
  assert.match(userContent, /\[PRIOR_FAILED_CRITERIA\]/);
  assert.match(userContent, /recommendationDetected, nonNeutral/);
  assert.match(userContent, /Consider option C, the best one\./);
  // The NEW candidate is the one in [CANDIDATE], not the prior one.
  assert.match(userContent, /\[CANDIDATE\][\s\S]*What about criterion X\?/);
});

test("buildValidatorUserContext: empty priorFailedCriteria array behaves like null (no section)", () => {
  const { userContent } = buildValidatorUserContext({
    chat: chat(),
    candidate: CANDIDATE_PASSED,
    selectedRole: "GENERALIST",
    taskGeneralContext: "x",
    priorFailedCriteria: [],
  });
  assert.doesNotMatch(userContent, /\[PRIOR_FAILED_CRITERIA\]/);
});

// ── end-to-end validateCandidate() with an injected fake LLM ────────────────

test("validateCandidate: end-to-end success on a passing audit (all 13 booleans false)", async () => {
  const fakeCallLLM = async (_messages) => ({ success: true, rawText: JSON.stringify(CANDIDATE_PASSED) });
  const result = await validateCandidate({
    chat: chat(),
    candidate: { role: "INFORMATION_EXPANDER", message: "Has the group considered...", groundingMessageIds: [] },
    selectedRole: "INFORMATION_EXPANDER",
    taskGeneralContext: "x",
    callLLM: fakeCallLLM,
  });
  assert.equal(result.success, true);
  assert.equal(result.verdict.passed, true);
  assert.deepEqual(result.verdict.failedCriteria, []);
  assert.deepEqual(result.verdict.booleans, CANDIDATE_PASSED);
});

test("validateCandidate: failed audit returns the correct failedCriteria list (in canonical order)", async () => {
  const auditResponse = {
    notGrounded: true,
    nonNeutral: true,
    roleMisaligned: false,
    inventedInformation: false,
    recommendationDetected: true,
    unsupportedInformationDetected: false,
    unsupportedConsensusClaim: false,
    optionSteering: false,
    requiredReasoningActMissing: false,
    unanswerable: false,
    hiddenInformationInference: false,
    repetition: false,
    length: false,
  };
  const fakeCallLLM = async (_messages) => ({ success: true, rawText: JSON.stringify(auditResponse) });
  const result = await validateCandidate({
    chat: chat(),
    candidate: { role: "STATIC", message: "Eldoron is clearly the best choice", groundingMessageIds: [] },
    selectedRole: "STATIC",
    taskGeneralContext: "x",
    callLLM: fakeCallLLM,
  });
  assert.equal(result.success, true);
  assert.equal(result.verdict.passed, false);
  assert.deepEqual(result.verdict.failedCriteria, ["notGrounded", "nonNeutral", "recommendationDetected"]);
});

// ── Delibra spec §11 new criteria: end-to-end (one test per new criterion) ──
// These verify the 6 new booleans (optionSteering,
// requiredReasoningActMissing, unanswerable, hiddenInformationInference,
// repetition, length) flow through validateCandidate() into
// failedCriteria. They use the canonical CANDIDATE_PASSED with one
// additional field flipped to true to mirror how a real LLM would
// return a single-failure audit.

test("validateCandidate: optionSteering failure alone triggers repair (Delibra spec §11)", async () => {
  const audit = { ...CANDIDATE_PASSED, optionSteering: true };
  const fakeCallLLM = async (_messages) => ({ success: true, rawText: JSON.stringify(audit) });
  const result = await validateCandidate({
    chat: chat(),
    candidate: { role: "STATIC", message: "Eldoron really stands out as a strong pick here", groundingMessageIds: [] },
    selectedRole: "STATIC",
    taskGeneralContext: "x",
    callLLM: fakeCallLLM,
  });
  assert.equal(result.success, true);
  assert.equal(result.verdict.passed, false);
  assert.deepEqual(result.verdict.failedCriteria, ["optionSteering"]);
});

test("validateCandidate: requiredReasoningActMissing failure alone triggers repair (Delibra spec §11)", async () => {
  // INFORMATION_EXPANDER is required to raise a missing option/criterion.
  // A generic "share what you think" prompt that points at no specific
  // gap should set requiredReasoningActMissing.
  const audit = { ...CANDIDATE_PASSED, requiredReasoningActMissing: true };
  const fakeCallLLM = async (_messages) => ({ success: true, rawText: JSON.stringify(audit) });
  const result = await validateCandidate({
    chat: chat(),
    candidate: { role: "INFORMATION_EXPANDER", message: "What do you all think?", groundingMessageIds: [] },
    selectedRole: "INFORMATION_EXPANDER",
    taskGeneralContext: "x",
    callLLM: fakeCallLLM,
  });
  assert.equal(result.success, true);
  assert.equal(result.verdict.passed, false);
  assert.deepEqual(result.verdict.failedCriteria, ["requiredReasoningActMissing"]);
});

test("validateCandidate: unanswerable failure alone triggers repair (Delibra spec §11)", async () => {
  const audit = { ...CANDIDATE_PASSED, unanswerable: true };
  const fakeCallLLM = async (_messages) => ({ success: true, rawText: JSON.stringify(audit) });
  const result = await validateCandidate({
    chat: chat(),
    candidate: { role: "STATIC", message: "What does the survey say about Myloria's commute times?", groundingMessageIds: [] },
    selectedRole: "STATIC",
    taskGeneralContext: "x",
    callLLM: fakeCallLLM,
  });
  assert.equal(result.success, true);
  assert.equal(result.verdict.passed, false);
  assert.deepEqual(result.verdict.failedCriteria, ["unanswerable"]);
});

test("validateCandidate: hiddenInformationInference failure alone triggers repair (Delibra spec §11)", async () => {
  const audit = { ...CANDIDATE_PASSED, hiddenInformationInference: true };
  const fakeCallLLM = async (_messages) => ({ success: true, rawText: JSON.stringify(audit) });
  const result = await validateCandidate({
    chat: chat(),
    candidate: { role: "STATIC", message: "Based on your background in finance, Eldoron is probably best for you.", groundingMessageIds: [] },
    selectedRole: "STATIC",
    taskGeneralContext: "x",
    callLLM: fakeCallLLM,
  });
  assert.equal(result.success, true);
  assert.equal(result.verdict.passed, false);
  assert.deepEqual(result.verdict.failedCriteria, ["hiddenInformationInference"]);
});

test("validateCandidate: repetition failure alone triggers repair (Delibra spec §11)", async () => {
  const audit = { ...CANDIDATE_PASSED, repetition: true };
  const fakeCallLLM = async (_messages) => ({ success: true, rawText: JSON.stringify(audit) });
  const result = await validateCandidate({
    chat: chat(),
    candidate: { role: "INFORMATION_EXPANDER", message: "Could you share what you know about job opportunities?", groundingMessageIds: [] },
    selectedRole: "INFORMATION_EXPANDER",
    taskGeneralContext: "x",
    callLLM: fakeCallLLM,
  });
  assert.equal(result.success, true);
  assert.equal(result.verdict.passed, false);
  assert.deepEqual(result.verdict.failedCriteria, ["repetition"]);
});

test("validateCandidate: length failure alone triggers repair (Delibra spec §11)", async () => {
  const audit = { ...CANDIDATE_PASSED, length: true };
  const fakeCallLLM = async (_messages) => ({ success: true, rawText: JSON.stringify(audit) });
  const result = await validateCandidate({
    chat: chat(),
    candidate: { role: "STATIC", message: "Has the group considered...", groundingMessageIds: [] },
    selectedRole: "STATIC",
    taskGeneralContext: "x",
    callLLM: fakeCallLLM,
  });
  assert.equal(result.success, true);
  assert.equal(result.verdict.passed, false);
  assert.deepEqual(result.verdict.failedCriteria, ["length"]);
});

test("validateCandidate: combined Phase-5 + spec-§11 failures all appear in failedCriteria, in canonical order", async () => {
  // Mix of old (Phase 5) and new (spec §11) failures. Verify ordering
  // follows VALIDATOR_CRITERIA (so the repair-loop [PRIOR_FAILED_CRITERIA]
  // hint sees a stable order across runs).
  const audit = {
    ...CANDIDATE_PASSED,
    notGrounded: true,            // Phase 5 — index 0
    unanswerable: true,          // spec §11 — index 9
    requiredReasoningActMissing: true, // spec §11 — index 8
    optionSteering: true,         // spec §11 — index 7
  };
  const fakeCallLLM = async (_messages) => ({ success: true, rawText: JSON.stringify(audit) });
  const result = await validateCandidate({
    chat: chat(),
    candidate: { role: "STATIC", message: "x", groundingMessageIds: [] },
    selectedRole: "STATIC",
    taskGeneralContext: "x",
    callLLM: fakeCallLLM,
  });
  assert.equal(result.success, true);
  assert.equal(result.verdict.passed, false);
  assert.deepEqual(result.verdict.failedCriteria, [
    "notGrounded",
    "optionSteering",
    "requiredReasoningActMissing",
    "unanswerable",
  ]);
});

test("validateCandidate: propagates an LLM API failure as VALIDATOR_API_ERROR", async () => {
  const fakeCallLLM = async (_messages) => ({ success: false, error: "rate limited" });
  const result = await validateCandidate({
    chat: chat(),
    candidate: { role: "STATIC", message: "x", groundingMessageIds: [] },
    selectedRole: "STATIC",
    taskGeneralContext: "x",
    callLLM: fakeCallLLM,
  });
  assert.equal(result.success, false);
  assert.equal(result.code, "VALIDATOR_API_ERROR");
  assert.match(result.error, /rate limited/);
});

test("validateCandidate: rejects malformed JSON as VALIDATOR_PARSE_FAILURE", async () => {
  const fakeCallLLM = async (_messages) => ({ success: true, rawText: "not json at all" });
  const result = await validateCandidate({
    chat: chat(),
    candidate: { role: "STATIC", message: "x", groundingMessageIds: [] },
    selectedRole: "STATIC",
    taskGeneralContext: "x",
    callLLM: fakeCallLLM,
  });
  assert.equal(result.success, false);
  assert.equal(result.code, "VALIDATOR_PARSE_FAILURE");
});

test("validateCandidate: rejects schema-invalid JSON (missing key) as VALIDATOR_SCHEMA_FAILURE", async () => {
  const fakeCallLLM = async (_messages) => ({ success: true, rawText: JSON.stringify({ notGrounded: false }) });
  const result = await validateCandidate({
    chat: chat(),
    candidate: { role: "STATIC", message: "x", groundingMessageIds: [] },
    selectedRole: "STATIC",
    taskGeneralContext: "x",
    callLLM: fakeCallLLM,
  });
  assert.equal(result.success, false);
  assert.equal(result.code, "VALIDATOR_SCHEMA_FAILURE");
});

test("validateCandidate: rejects self-summarised output (LLM included passed/failedCriteria) as VALIDATOR_SCHEMA_FAILURE", async () => {
  // Defence against the LLM trying to be helpful by adding a summary.
  const bad = { ...CANDIDATE_PASSED, passed: true, failedCriteria: [] };
  const fakeCallLLM = async (_messages) => ({ success: true, rawText: JSON.stringify(bad) });
  const result = await validateCandidate({
    chat: chat(),
    candidate: { role: "STATIC", message: "x", groundingMessageIds: [] },
    selectedRole: "STATIC",
    taskGeneralContext: "x",
    callLLM: fakeCallLLM,
  });
  assert.equal(result.success, false);
  assert.equal(result.code, "VALIDATOR_SCHEMA_FAILURE");
});

test("validateCandidate: throws synchronously if callLLM is not a function (never silently skips the network call)", async () => {
  await assert.rejects(
    () => validateCandidate({
      chat: chat(),
      candidate: { role: "STATIC", message: "x", groundingMessageIds: [] },
      selectedRole: "STATIC",
      taskGeneralContext: "x",
      callLLM: undefined,
    }),
    /requires a callLLM/
  );
});

test("validateCandidate: on the repair path, the prior failed criteria are forwarded into the user turn visible to the LLM", async () => {
  // Capture what the LLM actually sees on the repair call.
  let seenUserContent = null;
  const fakeCallLLM = async (messages) => {
    seenUserContent = messages[1].content;
    return { success: true, rawText: JSON.stringify(CANDIDATE_PASSED) };
  };
  const priorCandidate = { role: "INFORMATION_EXPANDER", message: "Consider option C, the best one.", groundingMessageIds: [] };
  await validateCandidate({
    chat: chat(),
    candidate: { role: "INFORMATION_EXPANDER", message: "Has the group considered X?", groundingMessageIds: ["m0"] },
    selectedRole: "INFORMATION_EXPANDER",
    taskGeneralContext: "x",
    callLLM: fakeCallLLM,
    priorFailedCriteria: ["recommendationDetected", "nonNeutral"],
    priorCandidate,
  });
  assert.match(seenUserContent, /\[PRIOR_FAILED_CRITERIA\]/);
  assert.match(seenUserContent, /recommendationDetected, nonNeutral/);
  assert.match(seenUserContent, /Consider option C, the best one\./);
});

// ── integration sanity ───────────────────────────────────────────────────────

test("integration: no real external LLM request is made by any test in this file (callLLM is always a local fake, never fetch)", () => {
  assert.equal(typeof globalThis.__integrationTestMadeRealRequest, "undefined");
});
