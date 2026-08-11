import assert from "node:assert/strict";
import test from "node:test";

import {
  THRESHOLDS,
  ROLES,
  computeDetectorRoleScores,
  evaluateGate,
  chooseRole,
} from "./utils.js";

const absent = () => ({ status: "absent", strength: 0, message_ids: [], span: "" });
const present = (strength) => ({ status: "present", strength, message_ids: ["m0"], span: "evidence" });
const factors = (overrides = {}) => ({
  breadth_deficiency: absent(),
  group_preference: absent(),
  justification_deficiency: absent(),
  integration_deficiency: absent(),
  unresolved_counterevidence: absent(),
  claim_evidence_linkage: absent(),
  self_correction: absent(),
  reasoning_uptake: absent(),
  ...overrides,
});

test("role scores come only from checked LLM detector strengths", () => {
  const checked = factors({
    breadth_deficiency: present(0.7),
    group_preference: present(0.8),
    justification_deficiency: present(0.6),
    integration_deficiency: present(0.9),
  });
  assert.deepEqual(computeDetectorRoleScores(checked), {
    expander: 0.7,
    challenger: 0.7,
    synthesiser: 0.9,
  });
  assert.equal(THRESHOLDS.weights, undefined);
  assert.equal(THRESHOLDS.candidate, undefined);
});

test("abstains at the time floor before classification", () => {
  const result = evaluateGate(null, {
    remainingTime: THRESHOLDS.gate.min_time_for_intervention_seconds * 1000,
  });
  assert.equal(result.decision, "abstain");
  assert.equal(result.abstentionKind, "time_floor");
});

test("abstains when detector output is unavailable", () => {
  const result = evaluateGate(null, { remainingTime: 600_000 });
  assert.equal(result.decision, "abstain");
  assert.equal(result.abstentionKind, "detector_unavailable");
});

test("abstains when no role's required semantic factors are present", () => {
  const result = evaluateGate(factors(), { remainingTime: 600_000 });
  assert.equal(result.decision, "abstain");
  assert.equal(result.abstentionKind, "no_semantic_need");
});

test("challenger requires both preference and justification deficiency", () => {
  const result = evaluateGate(factors({ group_preference: present(0.9) }), { remainingTime: 600_000 });
  assert.equal(result.perRole.challenger.detectorGate, false);
  assert.match(result.perRole.challenger.failureReason, /justification_deficiency/);
});

test("generalist when a checked need remains below its specialist threshold", () => {
  const result = evaluateGate(factors({ breadth_deficiency: present(0.2) }), { remainingTime: 600_000 });
  assert.equal(result.decision, "generalist");
  assert.equal(result.fallbackKind, "no_role_meets_threshold");
});

test("fixed deliberative priority breaks near-ties between detector scores", () => {
  const result = evaluateGate(factors({
    breadth_deficiency: present(0.7),
    integration_deficiency: present(0.7),
  }), { remainingTime: 600_000 });
  assert.equal(result.decision, "specialist");
  assert.equal(result.chosenRole, "synthesiser");
});

test("challenger wins a near-tie under the frozen scrutiny-first priority", () => {
  const result = evaluateGate(factors({
    breadth_deficiency: present(0.9),
    group_preference: present(0.9),
    justification_deficiency: present(0.8),
  }), { remainingTime: 600_000 });
  assert.equal(result.chosenRole, "challenger");
});

test("specialist is the clear highest LLM detector score", () => {
  const result = evaluateGate(factors({
    breadth_deficiency: present(0.65),
    integration_deficiency: present(0.9),
  }), { remainingTime: 600_000 });
  assert.equal(result.decision, "specialist");
  assert.equal(result.chosenRole, "synthesiser");
  assert.equal(result.scores.synthesiser, 0.9);
});

test("per-role audit record is complete", () => {
  const result = evaluateGate(factors({ breadth_deficiency: present(0.8) }), { remainingTime: 600_000 });
  for (const role of ROLES) {
    assert.equal(typeof result.perRole[role].eligible, "boolean");
    assert.equal(typeof result.perRole[role].score, "number");
    assert.equal(typeof result.perRole[role].threshold, "number");
    assert.equal(typeof result.perRole[role].detectorGate, "boolean");
  }
});

test("chooseRole uses the classified specialist", () => {
  const gate = evaluateGate(factors({ integration_deficiency: present(0.9) }), { remainingTime: 600_000 });
  assert.equal(chooseRole(gate, { remainingTime: 600_000 }).role, "synthesiser");
});
