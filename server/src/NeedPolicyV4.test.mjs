import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { checkNeedAssessment } from "./EvidenceChecker.js";
import { compilePlan } from "./PolicyCompiler.js";
import { OPERATION_QUESTIONS } from "./CognitiveOperations.mjs";
import { runtimeGeneratorBundle } from "./prompts/PromptRuntime.mjs";

const sourceDir = path.dirname(fileURLToPath(import.meta.url));
const runtimeDir = path.join(sourceDir, "prompts/source/runtime/specialist");
const simulationDir = path.join(sourceDir, "../test/participant_sim/prompts/source/runtime/specialist");
const message = (name, text) => ({ text, sender: { id: name.toLowerCase(), name } });
const assessment = chat => ({
  need: "SCRUTINIZE",
  operation: "unsupported_claim",
  target: {
    label: "Alex's Cedar app-to-attendance guarantee is unsupported; Blair discusses another Cedar feature without endorsing the guarantee.",
    messageIds: ["m0", "m1"],
    evidence: chat.map((item, index) => ({ messageId: `m${index}`, span: item.text })),
    optionLabels: ["Cedar"],
    criteria: [],
  },
  rationale: "A specific unsupported guarantee is present while two participants substantively discuss Cedar.",
});

// These are deterministic integration checks, not tests of the model's semantic
// judgment. The Assessor must still establish same-option relevance and an open
// reasoning issue before the exact-quote/author checks below can be sufficient.
test("different-aspect participation evidence survives checking and compilation without becoming shared endorsement", () => {
  const chat = [
    message("Alex", "Cedar's event app will guarantee perfect attendance."),
    message("Blair", "Cedar has three outdoor courtyards for meeting areas."),
  ];
  const raw = assessment(chat);
  const checked = checkNeedAssessment(raw, { chat, activeParticipantNames: ["Alex", "Blair", "Casey"] });
  assert.equal(checked.need, "SCRUTINIZE");
  assert.equal(checked.downgradedReason, null);
  const plan = compilePlan(checked.role, checked.checkedFactors, { eligibleMessageIds: ["m0", "m1"] });
  assert.equal(plan.requiredReasoningAct, "EVIDENCE_AUDIT");
  assert.equal(plan.target.label, raw.target.label);
  assert.deepEqual(plan.evidence, raw.target.evidence);
  assert.deepEqual(plan.evidenceIds, ["m0", "m1"]);
  assert.match(plan.answerableQuestionTemplate, /strongest point anyone has already seen/);
  assert.match(plan.answerableQuestionTemplate, /other established options/);
  assert.match(plan.answerableQuestionTemplate, /unsupported claim without a choice preference/);
  assert.match(plan.answerableQuestionTemplate, /support that specific claim/);
  assert.match(plan.answerableQuestionTemplate, /Do not infer a preference or ask for proof of an ordinary reported task fact/);
  assert.doesNotMatch(plan.answerableQuestionTemplate, /^Before settling/);
});

test("the broad substantive-discussion policy retains the two-distinct-author guard", () => {
  const chat = [
    message("Alex", "Cedar's event app will guarantee perfect attendance."),
    message("Alex", "Cedar has three outdoor courtyards for meeting areas."),
  ];
  const checked = checkNeedAssessment(assessment(chat), { chat, activeParticipantNames: ["Alex", "Blair", "Casey"] });
  assert.equal(checked.need, "NONE");
  assert.equal(checked.downgradedReason, "INSUFFICIENT_DISTINCT_PARTICIPANTS");
});

test("the compiled audit question and composed Challenger guidance no longer require proof of a reported fact or an existing counterpoint", () => {
  const bundle = runtimeGeneratorBundle("challenger");
  assert.equal(bundle.blocked, false, bundle.reason);
  assert.match(OPERATION_QUESTIONS.EVIDENCE_AUDIT, /other established options/);
  assert.match(bundle.content, /a previously voiced opposing point is not required/);
  assert.match(bundle.content, /Do not ask for the source, verification or proof of an ordinary fact/);
  assert.doesNotMatch(bundle.content, /Challenger: the leading option and a point already raised against it/);
});

test("participant simulation uses the same current Assessor rules and common grounding contract", () => {
  for (const filename of ["assessor.md", "specialist_common.md", "specialist_base.md"]) {
    const source = readFileSync(path.join(runtimeDir, filename), "utf8");
    const simulation = readFileSync(path.join(simulationDir, filename), "utf8");
    // Example blocks are generated separately; this check owns the rule prefix.
    const rules = text => text.split("## ADAPTIVE FEW-SHOT EXAMPLES")[0];
    assert.equal(rules(simulation), rules(source), `${filename} rule mirror differs`);
  }
});

test("Assessor leaves participation to code and teaches a genuinely unclear causal link", () => {
  const prompt = readFileSync(path.join(runtimeDir, "assessor.md"), "utf8");
  assert.match(prompt, /participation invitations are decided by code, so never report a participation candidate/);
  assert.match(prompt, /volunteer availability is why its two bus routes share a crowded afternoon stop/);
  assert.doesNotMatch(prompt, /Those two things fit together, so I would choose Orsena/);
});
