import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { toDetectorOutput } from "../test/participant_sim/fakes/detectorOutput.mjs";

process.argv[1] = path.join(path.dirname(fileURLToPath(import.meta.url)), "fake-entry.js");
const { validateAgainstAssessorSchema } = await import("./SemanticAssessor.js");
const { checkNeedAssessment } = await import("./EvidenceChecker.js");
const { compilePlan } = await import("./PolicyCompiler.js");
const { preflightPlan, dropUnestablishedCriteria } = await import("./PlanPreflight.mjs");

test("schema-valid discrepancy with an unestablished criterion is stopped at actual preflight", () => {
  const chat = [
    { text: "My notes say Briar's main hall seats 600 people.", sender: { id: "alex", name: "Alex" } },
    { text: "My notes say Briar's main hall seats 450 people.", sender: { id: "blair", name: "Blair" } },
  ];
  const raw = {
    need: "INTEGRATE", operation: "public_discrepancy",
    target: {
      label: "Two reports give different seating capacities for Briar's main hall.",
      messageIds: ["m0", "m1"],
      evidence: chat.map((message, index) => ({ messageId: `m${index}`, span: message.text })),
      optionLabels: ["Briar"], criteria: ["main-hall seating capacity"],
    },
    rationale: "The two participants report different numbers for the same hall.",
  };
  const context = {
    chat,
    activeParticipantNames: ["Alex", "Blair", "Casey"],
    taskGeneralContext: "Choose Arden, Briar or Cedar. All meet the essential requirements for facilities, public safety, finance and legal compliance.",
  };
  const compile = value => {
    const checked = checkNeedAssessment(value, context);
    assert.equal(checked.need, "INTEGRATE", "exact quotation/author checks do not validate a criterion label");
    return compilePlan(checked.role, checked.checkedFactors, { eligibleMessageIds: ["m0", "m1"] });
  };
  assert.equal(validateAgainstAssessorSchema(toDetectorOutput(raw)).ok, true);
  const rejected = preflightPlan(compile(raw), context);
  assert.equal(rejected.status, "failed");
  assert.deepEqual(rejected.failureReasons, ["TARGET_UNSUPPORTED"]);
  assert.equal(rejected.checks.evidenceCoverageVerified, true);

  // public_discrepancy needs exact reports/scope, not a newly coined criterion.
  // Remove only the unestablished label; preserve both reports and their units.
  const grounded = structuredClone(raw);
  grounded.target.criteria = [];
  assert.equal(validateAgainstAssessorSchema(toDetectorOutput(grounded)).ok, true);
  const accepted = preflightPlan(compile(grounded), context);
  assert.equal(accepted.status, "passed");
  assert.deepEqual(accepted.failureReasons, []);
  assert.deepEqual(grounded.target.evidence, raw.target.evidence);
});

test("a criterion the detector coined is removed before selection and the candidate still qualifies", () => {
  const chat = [
    { text: "Rovenna has mid-range rooms close to the venues.", sender: { id: "alex", name: "Alex" } },
    { text: "Meridia has affordable independent hotels near the centre.", sender: { id: "blair", name: "Blair" } },
    { text: "Talwick hotels offer flexible check-in.", sender: { id: "casey", name: "Casey" } },
  ];
  const context = { chat, activeParticipantNames: ["Alex", "Blair", "Casey"], taskGeneralContext: "Choose Talwick, Rovenna or Meridia." };
  const candidate = criteria => ({ operation: "cross_option_evidence", rationale: "Room facts for three cities are not yet side by side.", target: {
    label: "Room information for the three cities has not been compared.", messageIds: ["m0", "m1", "m2"],
    evidence: chat.map((message, index) => ({ messageId: `m${index}`, span: message.text })),
    optionLabels: ["Rovenna", "Meridia", "Talwick"], criteria } });
  const factors = { candidates: { elicit: null, scrutinize: null, integrate: candidate(["accommodation", "rooms"]) }, rationale: "x" };
  const { factors: cleaned, dropped } = dropUnestablishedCriteria(factors, context);
  assert.deepEqual(dropped, [{ candidate: "integrate", criterion: "accommodation" }]);
  assert.deepEqual(cleaned.candidates.integrate.target.criteria, ["rooms"], "public wording is kept");
  assert.deepEqual(factors.candidates.integrate.target.criteria, ["accommodation", "rooms"], "raw detector output is not mutated");

  const plan = value => { const checked = checkNeedAssessment({ need: "INTEGRATE", ...value }, context);
    return compilePlan(checked.role, checked.checkedFactors, { eligibleMessageIds: ["m0", "m1", "m2"] }); };
  assert.deepEqual(preflightPlan(plan(candidate(["accommodation"])), context).failureReasons, ["TARGET_UNSUPPORTED"], "preflight itself still refuses a coined label");
  assert.equal(preflightPlan(plan(dropUnestablishedCriteria({ candidates: { integrate: candidate(["accommodation"]) } }, context).factors.candidates.integrate), context).status, "passed",
    "a cross-option comparison no longer needs a named criterion");
  assert.equal(dropUnestablishedCriteria(null, context).factors, null);
});
