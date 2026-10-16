import assert from "node:assert/strict";
import test from "node:test";
import { compilePlan } from "./PolicyCompiler.js";
import { preflightPlan } from "./PlanPreflight.mjs";
import { COGNITIVE_NEEDS } from "./CognitiveOperations.mjs";
import { checkEvidence, FACTOR_KEYS } from "./EvidenceChecker.js";
import { evaluateGate, computeDetectorRoleScores } from "./utils.js";

const chat = [
  { text: "City A transport is 12 minutes.", sender: { id: "p1", name: "Alex" } },
  { text: "City B transport is 18 minutes.", sender: { id: "p2", name: "Casey" } },
  { text: "City A cost is 25000.", sender: { id: "p1", name: "Alex" } },
];
const ids = ["m0", "m1", "m2"];
function facts() { return Object.fromEntries(FACTOR_KEYS.map(k => [k, { status: "absent", strength: 0, message_ids: [], evidence: [] }])); }
function quote(i) { return { messageId: ids[i], span: chat[i].text }; }
function fixture(need, changes = {}) {
  const [role, act, key] = COGNITIVE_NEEDS[need];
  const raw = facts();
  raw[key] = { status: "present", strength: .9, message_ids: ids, evidence: ids.map((_, i) => quote(i)) };
  raw.cognitiveTargets = [{ need, label: "Public transport contributions", messageIds: ids, evidence: ids.map((_, i) => quote(i)), optionLabels: ["City A", "City B"], criteria: ["transport"], status: "open", ...(need === "participation_gap" ? { participantName: "Jordan" } : {}), ...changes }];
  return { role, act, raw, checked: checkEvidence(raw, { chat }) };
}
for (const need of Object.keys(COGNITIVE_NEEDS)) test(`v3.2 compiles and validates ${need} without changing the selected role`, () => {
  const { role, act, checked } = fixture(need);
  const plan = compilePlan(role, checked, { eligibleMessageIds: ids });
  assert.equal(plan.requiredReasoningAct, act);
  assert.equal(plan.role, role);
  assert.equal(plan.maxWords, role === "synthesiser" ? 55 : 50);
  assert.equal(plan.maxSentences, 3);
  assert.deepEqual(plan.target.messageIds, ids);
  assert.equal(preflightPlan(plan, { chat, activeParticipantNames: ["Alex", "Casey", "Jordan"] }).status, "passed");
});
test("unknown role cannot compile", () => assert.throws(() => compilePlan("facilitator", {}), /unknown role/));
test("single public claim can be a Challenger target without inventing group agreement", () => {
  const f = fixture("unsupported_claim");
  const plan = compilePlan("challenger", f.checked, { eligibleMessageIds: ids });
  assert.equal(plan.target.kind, "claim");
  assert.deepEqual(plan.target.messageIds, ids);
  assert.equal(f.checked.group_preference.status, "absent");
  assert.equal(computeDetectorRoleScores(f.checked).challenger, .9);
  assert.equal(evaluateGate(f.checked, { remainingTime: 400000 }).chosenRole, "challenger");
});
test("only source-verified observation survives fabricated quotations", () => {
  const f = fixture("cross_option_evidence", { evidence: [{ messageId: "m0", span: "not said" }] });
  assert.equal(f.checked.cognitiveTargets.length, 0);
});
test("per-message preference quotes can differ across two participants", () => {
  const raw = facts();
  raw.group_preference = { status: "present", strength: .8, message_ids: ["m0", "m1"], evidence: [{ messageId: "m0", span: "I prefer B" }, { messageId: "m1", span: "B is my choice" }] };
  const different = [{ text: "I prefer B", sender: { id: "p1" } }, { text: "B is my choice", sender: { id: "p2" } }];
  assert.equal(checkEvidence(raw, { chat: different }).group_preference.status, "present");
  different[1].sender.id = "p1";
  assert.equal(checkEvidence(raw, { chat: different }).group_preference.status, "uncertain");
});
test("system/AI text cannot support factors or targets", () => {
  const raw = fixture("coverage_gap").raw;
  const systemChat = chat.map(m => ({ ...m, sender: { id: "ai", name: "Facilitator" } }));
  const checked = checkEvidence(raw, { chat: systemChat });
  assert.equal(checked.breadth_deficiency.status, "uncertain");
  assert.deepEqual(checked.cognitiveTargets, []);
});
test("new-format integration requires three messages across two participant authors", () => {
  const raw = fixture("fragmented_evidence").raw;
  const oneAuthor = chat.map(m => ({ ...m, sender: { id: "p1", name: "Alex" } }));
  assert.equal(checkEvidence(raw, { chat: oneAuthor }).integration_deficiency.status, "uncertain");
});
test("empty evidence or wrong operation fails before generation", () => {
  const plan = compilePlan("synthesiser", {}, { eligibleMessageIds: ids });
  assert.equal(preflightPlan(plan, { chat }).status, "failed");
  plan.requiredReasoningAct = "EVIDENCE_AUDIT";
  assert.ok(preflightPlan(plan, { chat }).failureReasons.includes("INPUT_INVALID"));
});
test("one-option comparison cannot be completed with invented missing data", () => {
  const { checked } = fixture("cross_option_evidence", { messageIds: ["m0"], evidence: [quote(0)], optionLabels: ["City A"] });
  const plan = compilePlan("synthesiser", checked, { eligibleMessageIds: ids });
  assert.ok(preflightPlan(plan, { chat }).failureReasons.includes("EVIDENCE_INSUFFICIENT"));
});
test("already addressed public targets replan rather than repeat", () => {
  const { checked } = fixture("unsupported_claim", { status: "addressed" });
  const plan = compilePlan("challenger", checked, { eligibleMessageIds: ids });
  assert.ok(preflightPlan(plan, { chat }).failureReasons.includes("TARGET_ALREADY_ADDRESSED"));
});
test("delivered history blocks rephrasing the same operation and source target", () => {
  const { checked } = fixture("unsupported_claim");
  const plan = compilePlan("challenger", checked, { eligibleMessageIds: ids });
  const history = [{ ...plan, signature: "different wording" }];
  assert.ok(preflightPlan(plan, { chat, interventionHistory: history }).failureReasons.includes("TARGET_ALREADY_ADDRESSED"));
});
test("partial scope and existing contributors cannot authorize a participation nudge", () => {
  const { checked } = fixture("participation_gap");
  const plan = compilePlan("expander", checked, { eligibleMessageIds: ids });
  assert.equal(preflightPlan(plan, { chat, activeParticipantNames: ["Jordan"], contextScope: "partial_recent_window" }).status, "failed");
  plan.target.participantName = "Alex";
  assert.equal(preflightPlan(plan, { chat, activeParticipantNames: ["Alex"] }).status, "failed");
});
test("out-of-scope IDs are excluded and then fail source completeness rather than being invented", () => {
  const { checked } = fixture("cross_option_evidence");
  const plan = compilePlan("synthesiser", checked, { eligibleMessageIds: ["m0"] });
  assert.deepEqual(plan.evidenceIds, ["m0"]);
  assert.equal(preflightPlan(plan, { chat }).status, "failed");
});

test("a public claim and its concern in one message are not rejected solely for sharing a source", () => {
  const source = [{ text: "I prefer City B despite its six-month approval period, which worries me.", sender: { id: "p1", name: "Alex" } }];
  const raw = facts();
  raw.unresolved_counterevidence = { status: "present", strength: .9, message_ids: ["m0"], evidence: [{ messageId: "m0", span: source[0].text }] };
  raw.cognitiveTargets = [{ need: "unresolved_concern", label: "B approval concern and preference", messageIds: ["m0"], evidence: raw.unresolved_counterevidence.evidence, optionLabels: ["City B"], criteria: [], status: "open" }];
  const plan = compilePlan("challenger", checkEvidence(raw, { chat: source }), { eligibleMessageIds: ["m0"] });
  assert.equal(preflightPlan(plan, { chat: source }).status, "passed");
});
test("a repeated role stays selected when the dominant need has not changed", async () => {
  const { chooseRole } = await import("./utils.js");
  const role = chooseRole({ decision: "specialist", chosenRole: "challenger", eligibleRoles: ["challenger", "expander"], scores: { challenger: .8, expander: .7 } }, { remainingTime: 400000, lastRole: "challenger" });
  assert.equal(role.role, "challenger");
});
