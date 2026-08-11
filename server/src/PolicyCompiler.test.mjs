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

test("synthesiser plan includes validated attributed-but-uncompared relation messages", () => {
  const checked = {
    breadth_deficiency: absent(),
    group_preference: absent(),
    justification_deficiency: absent(),
    integration_deficiency: present({ message_ids: ["m0"], span: "fragmented evidence" }),
    self_correction: absent(),
    evidenceRelations: [
      { messageId: "m0", attributed: true, compared: false, integrated: false },
      { messageId: "m1", attributed: true, compared: false, integrated: false },
      { messageId: "m2", attributed: true, compared: true, integrated: false },
    ],
  };
  const plan = compilePlan("synthesiser", checked, {
    score: 0.8,
    threshold: 0.6,
    eligibleMessageIds: ["m0", "m1", "m2"],
  });
  assert.deepEqual(plan.evidenceIds, ["m0", "m1"]);
});

// ── Delibra spec §11 additions: target / requiredReasoningAct / answerableQuestionTemplate
//    (added 2026-08-11 to close the spec gap; the Validator's
//    `requiredReasoningActMissing` and `unanswerable` booleans check
//    the Generator actually executed the act / produced an answerable
//    question matching the template's intent). ─────────────────────────────────

test("plan includes requiredReasoningAct + answerableQuestionTemplate, frozen per role", () => {
  const checked = {
    breadth_deficiency: present({ message_ids: ["m0"], span: "x" }),
    group_preference: absent(), justification_deficiency: absent(), integration_deficiency: absent(), self_correction: absent(),
  };
  const expander = compilePlan("expander", checked, { score: 0.9, threshold: 0.5, eligibleMessageIds: ["m0"] });
  const challenger = compilePlan("challenger", { ...checked, group_preference: present(), justification_deficiency: present() }, { score: 0.9, threshold: 0.5, eligibleMessageIds: ["m0"] });
  const synthesiser = compilePlan("synthesiser", { ...checked, integration_deficiency: present() }, { score: 0.9, threshold: 0.5, eligibleMessageIds: ["m0"] });

  assert.equal(expander.requiredReasoningAct, "invite_missing_task_relevant_information_or_consideration");
  assert.match(expander.answerableQuestionTemplate, /additional task-relevant facts/);

  assert.equal(challenger.requiredReasoningAct, "ask_for_evidence_or_justification");
  assert.match(challenger.answerableQuestionTemplate, /What evidence or reasoning supports/);

  assert.equal(synthesiser.requiredReasoningAct, "request_specific_comparison_or_tradeoff");
  assert.match(synthesiser.answerableQuestionTemplate, /How do.*compare on/);
});

test("expander target: missing_label with span when factor has one; generic label otherwise", () => {
  const withSpan = compilePlan(
    "expander",
    { breadth_deficiency: present({ message_ids: [], span: "no one mentioned commute time" }), group_preference: absent(), justification_deficiency: absent(), integration_deficiency: absent(), self_correction: absent() },
    { score: 0.9, threshold: 0.5, eligibleMessageIds: [] }
  );
  assert.equal(withSpan.target.kind, "missing_label");
  assert.match(withSpan.target.label, /commute time/);

  const withoutSpan = compilePlan(
    "expander",
    { breadth_deficiency: present({ message_ids: [], span: "" }), group_preference: absent(), justification_deficiency: absent(), integration_deficiency: absent(), self_correction: absent() },
    { score: 0.9, threshold: 0.5, eligibleMessageIds: [] }
  );
  assert.equal(withoutSpan.target.kind, "missing_label");
  assert.match(withoutSpan.target.label, /missing task-relevant information/);
});

test("challenger target: message-id of the first group_preference message (the preference owner)", () => {
  const plan = compilePlan(
    "challenger",
    {
      breadth_deficiency: absent(),
      group_preference: present({ message_ids: ["m3", "m7"], span: "Eldoron is best" }),
      justification_deficiency: present({ message_ids: ["m3"], span: "no real reason" }),
      integration_deficiency: absent(),
      self_correction: absent(),
    },
    { score: 0.9, threshold: 0.5, eligibleMessageIds: ["m3", "m7"] }
  );
  assert.equal(plan.target.kind, "message");
  assert.equal(plan.target.messageId, "m3"); // first message_id of the group_preference factor, not m7
});

test("synthesiser target: message-id of the first integration_deficiency message (the spot of fragmented evidence)", () => {
  const plan = compilePlan(
    "synthesiser",
    {
      breadth_deficiency: absent(),
      group_preference: absent(),
      justification_deficiency: absent(),
      integration_deficiency: present({ message_ids: ["m10", "m11"], span: "fragmented" }),
      self_correction: absent(),
    },
    { score: 0.9, threshold: 0.5, eligibleMessageIds: ["m10", "m11"] }
  );
  assert.equal(plan.target.kind, "message");
  assert.equal(plan.target.messageId, "m10");
});

test("target is null when role's factors have no usable source (score-only selection with no verified span)", () => {
  // The "no single verified span available" fallback path.
  const plan = compilePlan(
    "synthesiser",
    { breadth_deficiency: absent(), group_preference: absent(), justification_deficiency: absent(), integration_deficiency: absent(), self_correction: absent() },
    { score: 0.65, threshold: 0.6, eligibleMessageIds: [] }
  );
  assert.equal(plan.target, null);
  // Other spec-§11 fields should still be present (they're role-fixed, not factor-derived).
  assert.equal(plan.requiredReasoningAct, "request_specific_comparison_or_tradeoff");
});
