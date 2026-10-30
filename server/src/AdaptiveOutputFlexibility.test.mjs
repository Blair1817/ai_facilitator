import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { normalizeGeneratorCandidate, presentationForMessage } from "../../client/src/components/facilitatorPresentation.mjs";
import { buildSynthesisPointContract, decodeSynthesisPoints } from "./SynthesisPointContract.mjs";
const dirname = path.dirname(fileURLToPath(import.meta.url));
process.argv[1] = path.join(dirname, "fake-entry.js");
const { parseGeneratorOutputStrict, validateAgainstGenerationSchema, runDeterministicValidation } = await import("./prompts/GeneratorContract.mjs");
const { checkNeedAssessment } = await import("./EvidenceChecker.js");
const { compilePlan } = await import("./PolicyCompiler.js");
const { preflightPlan } = await import("./PlanPreflight.mjs");
const { evaluateNeedGate } = await import("./utils.js");
const { validateAgainstAssessorSchema } = await import("./SemanticAssessor.js");
// 2026-10-26: detector few-shots report independent candidates.
const { candidateRaws, selectAdaptiveAssessment } = await import("./AdaptiveEvidence.mjs");
const source = path.join(dirname, "prompts/source/runtime/specialist");
function examples(file) {
  return [...fs.readFileSync(path.join(source, file), "utf8").matchAll(/### ([AG]-\d+)[^\n]*\n\nINPUT\n([^\n]+)\n\nOUTPUT\n([^\n]+)/g)]
    .map(m => ({ id: m[1], input: JSON.parse(m[2]), output: JSON.parse(m[3]) }));
}
function chatFor(input) {
  return input.CUMULATIVE_PUBLIC_CONTEXT.map(m => ({ text: m.text, sender: { id: m.sender, name: m.sender } }));
}
for (const file of ["expander.md", "challenger.md", "synthesiser.md"]) {
  for (const { id, input, output } of examples(file)) test(`${id}: loaded example preserves layout, role, sources and word ceiling`, () => {
    const parsed = parseGeneratorOutputStrict(JSON.stringify(output));
    assert.equal(parsed.ok, true);
    assert.equal(validateAgainstGenerationSchema(parsed.parsed, input.SELECTED_ROLE).ok, true);
    const candidate = normalizeGeneratorCandidate(parsed.parsed);
    const result = runDeterministicValidation(candidate, {
      selectedRole: input.SELECTED_ROLE,
      eligibleMessageIds: input.CUMULATIVE_PUBLIC_CONTEXT.map(m => m.messageId),
      allowedGroundingIds: input.ALLOWED_GROUNDING_MESSAGE_IDS,
      activeParticipantNames: input.ACTIVE_PARTICIPANT_NAMES,
      maxWords: input.SELECTED_ROLE === "INFORMATION_SYNTHESISER" ? null : 50,
      enforcePlanGrounding: true, forbidInternalDisclosure: true,
    });
    assert.equal(result.passed, true, result.failedCriteria.join(", "));
    assert.deepEqual(presentationForMessage({ content: candidate.message, presentation: candidate.presentation }), output.message);
  });
}
const assessments = examples("assessor.md");
for (const id of ["A-15"]) test(`${id}: ordinary fact-by-fact sharing without a decision/recap signal compiles to an executable plan`, () => {
  const { input, output } = assessments.find(e => e.id === id);
  const chat = chatFor(input);
  assert.equal(validateAgainstAssessorSchema(output).ok, true);
  const [candidate] = candidateRaws(output);
  const checked = checkNeedAssessment(candidate, { chat, activeParticipantNames: input.ACTIVE_PARTICIPANT_NAMES });
  assert.equal(checked.need, "INTEGRATE");
  const plan = compilePlan(checked.role, checked.checkedFactors, { eligibleMessageIds: input.CUMULATIVE_PUBLIC_CONTEXT.map(m => m.messageId), interventionHistory: [] });
  const marker = preflightPlan(plan, { chat, taskGeneralContext: input.TASK_GENERAL_CONTEXT, activeParticipantNames: input.ACTIVE_PARTICIPANT_NAMES, interventionHistory: [], contextScope: input.CONTEXT_SCOPE });
  assert.equal(marker.status, "passed", marker.failureReasons.join(", "));
  assert.equal(plan.maxWords, null);
  assert.equal(Object.hasOwn(plan, "maxSentences"), false);
});
test("A-08: explicit participant summary pauses automatic intervention, including Static fallback", () => {
  const { input, output } = assessments.find(e => e.id === "A-08");
  assert.equal(validateAgainstAssessorSchema(output).ok, true);
  const checked = selectAdaptiveAssessment(output, { chat: chatFor(input), roster: input.ACTIVE_PARTICIPANT_NAMES, remainingTimeMs: 60_000 });
  assert.equal(checked.downgradedReason, null);
  assert.equal(checked.selection.mode, "deferred");
  const gate = evaluateNeedGate(checked, { remainingTime: 60_000 });
  assert.equal(gate.decision, "abstain");
  assert.equal(gate.abstentionKind, "participant_summary_in_progress");
});
test("G-08 uses the ordinary-sharing A-15 context, not the waiting A-08 context", () => {
  const assessment = assessments.find(e => e.id === "A-15");
  const generator = examples("synthesiser.md").find(e => e.id === "G-08");
  assert.deepEqual(generator.input.CUMULATIVE_PUBLIC_CONTEXT, assessment.input.CUMULATIVE_PUBLIC_CONTEXT);
  assert.ok(generator.input.TARGET.messageIds.length >= assessment.output.candidates.integrate.target.messageIds.length);
  assert.equal(generator.input.SYNTHESIS_COVERAGE.scope, "all_public_task_information_this_round");
});
test("completed participant summary remains the authored NONE boundary (not a model evaluation)", () => {
  assert.deepEqual(assessments.find(e => e.id === "A-12").output.candidates, { elicit: null, scrutinize: null, integrate: null });
});
test("OpenAI point schema decodes three points, publishes numbering, and counts all rendered words", () => {
  const contract = buildSynthesisPointContract(["Arden"], ["m0", "m1", "m2"]);
  const value = { role: "INFORMATION_SYNTHESISER", scoreboard: [{ option: "Arden", points: [
    { text: "Covered walkways connect the main halls.", sourceMessageIds: ["m0"] },
    { text: "Some demo rooms are a 12-minute walk away.", sourceMessageIds: ["m1"] },
    { text: "The app sends no schedule-change alerts.", sourceMessageIds: ["m2"] },
  ] }], question: "How do you weigh these points together?", questionGroundingMessageIds: [] };
  const decoded = decodeSynthesisPoints(value, contract);
  assert.equal(decoded.ok, true);
  assert.equal(validateAgainstGenerationSchema(decoded.parsed, value.role).ok, true);
  const candidate = normalizeGeneratorCandidate(decoded.parsed);
  const options = { selectedRole: value.role, eligibleMessageIds: ["m0", "m1", "m2"], allowedGroundingIds: ["m0", "m1", "m2"], enforcePlanGrounding: true, maxWords: null };
  assert.equal(runDeterministicValidation(candidate, options).passed, true);
  assert.match(candidate.message, /\n3\. The app sends no schedule-change alerts\./);
  const words = candidate.message.trim().split(/\s+/).length;
  value.question += " extra".repeat(55 - words);
  const atCap = normalizeGeneratorCandidate(decodeSynthesisPoints(value, contract).parsed);
  assert.equal(runDeterministicValidation(atCap, options).passed, true);
  value.question += " extra";
  assert.equal(runDeterministicValidation(normalizeGeneratorCandidate(decodeSynthesisPoints(value, contract).parsed), options).passed, true);
});
test("legacy string numbering is also preserved through parsing and validation", () => {
  const message = "1. Covered walkways.\n2. Rooms are 12 minutes away.\n3. No app alerts.\n\nHow do you weigh these points?";
  const parsed = parseGeneratorOutputStrict(JSON.stringify({role:"INFORMATION_SYNTHESISER",message,groundingMessageIds:["m0"]}));
  assert.equal(parsed.parsed.message, message);
  assert.equal(runDeterministicValidation(parsed.parsed,{selectedRole:"INFORMATION_SYNTHESISER",eligibleMessageIds:["m0"],maxWords:55}).passed,true);
});
