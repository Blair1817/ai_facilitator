// Architecture doc Step 8. Pure-function tests -- no network, no Empirica,
// no filesystem reads, no fake-entry.js trick needed.
import assert from "node:assert/strict";
import test from "node:test";
import { compilePlan } from "./PolicyCompiler.js";

function present(overrides = {}) {
  return { status: "present", strength: 0.8, message_ids: [], span: "", ...overrides };
}
function absent() {
  return { status: "absent", strength: 0, message_ids: [], span: "" };
}

test("challenger plan pulls evidenceIds/gap from group_preference + justification_deficiency only", () => {
  const checked = {
    breadth_deficiency: absent(),
    group_preference: present({ message_ids: ["m0", "m1"], span: "Eldoron is best" }),
    justification_deficiency: present({ message_ids: ["m1"], span: "no real reason given" }),
    integration_deficiency: absent(),
    self_correction: absent(),
  };
  const plan = compilePlan("challenger", checked, { score: 0.9, threshold: 0.6, eligibleMessageIds: ["m0", "m1", "m2"] });
  assert.equal(plan.role, "challenger");
  assert.deepEqual([...plan.evidenceIds].sort(), ["m0", "m1"]);
  assert.match(plan.gap, /converged on the same preference/);
  assert.match(plan.gap, /not yet been backed by stated reasoning/);
  assert.equal(plan.maxSentences, 2);
});

test("evidenceIds is always a subset of eligibleMessageIds, even if a factor cites an ID outside it", () => {
  const checked = {
    breadth_deficiency: present({ message_ids: ["m0", "m99"], span: "x" }),
    group_preference: absent(),
    justification_deficiency: absent(),
    integration_deficiency: absent(),
    self_correction: absent(),
  };
  const plan = compilePlan("expander", checked, { score: 0.5, threshold: 0.35, eligibleMessageIds: ["m0"] });
  assert.deepEqual(plan.evidenceIds, ["m0"]);
});

test("gap falls back to a generic description when the role's factors aren't present (score-only selection)", () => {
  const checked = {
    breadth_deficiency: absent(),
    group_preference: absent(),
    justification_deficiency: absent(),
    integration_deficiency: absent(),
    self_correction: absent(),
  };
  const plan = compilePlan("synthesiser", checked, { score: 0.65, threshold: 0.6, eligibleMessageIds: [] });
  assert.match(plan.gap, /no single verified span available/);
  assert.deepEqual(plan.evidenceIds, []);
});

test("intensity is 'high' well above threshold, 'medium' just above it", () => {
  const checked = {
    breadth_deficiency: present({ message_ids: ["m0"], span: "x" }),
    group_preference: absent(), justification_deficiency: absent(), integration_deficiency: absent(), self_correction: absent(),
  };
  const barelyOver = compilePlan("expander", checked, { score: 0.36, threshold: 0.35, eligibleMessageIds: ["m0"] });
  const wellOver = compilePlan("expander", checked, { score: 0.95, threshold: 0.35, eligibleMessageIds: ["m0"] });
  assert.equal(barelyOver.intensity, "medium");
  assert.equal(wellOver.intensity, "high");
});

test("prohibitions are always the same fixed list, regardless of role", () => {
  const checked = {
    breadth_deficiency: present({ message_ids: ["m0"], span: "x" }),
    group_preference: absent(), justification_deficiency: absent(), integration_deficiency: absent(), self_correction: absent(),
  };
  const plan = compilePlan("expander", checked, { score: 0.9, threshold: 0.35, eligibleMessageIds: ["m0"] });
  assert.ok(plan.prohibitions.includes("MUST_NOT_RECOMMEND_OR_RANK_OPTION"));
  assert.ok(plan.prohibitions.includes("MUST_NOT_REVEAL_PRIVATE_PROFILE_INFORMATION"));
  assert.ok(plan.prohibitions.includes("MUST_NOT_CLAIM_TO_KNOW_CORRECT_ANSWER"));
});

test("throws on an unknown role", () => {
  assert.throws(() => compilePlan("facilitator", {}, { score: 0.9, threshold: 0.5, eligibleMessageIds: [] }));
});

test("synthesiser plan pulls from integration_deficiency only", () => {
  const checked = {
    breadth_deficiency: present({ message_ids: ["m5"], span: "unrelated" }),
    group_preference: absent(),
    justification_deficiency: absent(),
    integration_deficiency: present({ message_ids: ["m2", "m3"], span: "fragmented evidence" }),
    self_correction: absent(),
  };
  const plan = compilePlan("synthesiser", checked, { score: 0.9, threshold: 0.6, eligibleMessageIds: ["m2", "m3", "m5"] });
  assert.deepEqual([...plan.evidenceIds].sort(), ["m2", "m3"]); // m5 (breadth_deficiency) excluded -- not this role's factor
  assert.match(plan.gap, /organised or compared/);
});
