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
  // Original priority challenger > synthesiser > expander (Scrutiny >
  // Integration > Expansion). A tied expander/synthesiser pair with no
  // challenger in the band picks synthesiser. This test pins the
  // original priority; the 2026-08-13 "expand-before-integrate"
  // experimental change was tried and reverted (see ROLE_PRIORITY in
  // server/src/utils.js for the rationale).
  const result = evaluateGate(factors({
    breadth_deficiency: present(0.7),
    integration_deficiency: present(0.7),
  }), { remainingTime: 600_000 });
  assert.equal(result.decision, "specialist");
  assert.equal(result.chosenRole, "synthesiser");
});

test("challenger wins a near-tie under the frozen scrutiny-first priority", () => {
  // challenger is still highest in ROLE_PRIORITY. Even with expander
  // also eligible, scrutinize wins.
  const result = evaluateGate(factors({
    breadth_deficiency: present(0.9),
    group_preference: present(0.9),
    justification_deficiency: present(0.8),
  }), { remainingTime: 600_000 });
  assert.equal(result.chosenRole, "challenger");
});

test("specialist is the clear highest LLM detector score", () => {
  // Clear margin (0.9 - 0.65 = 0.25) bypasses the priority band, so the
  // higher score wins regardless of role priority. The 2026-08-13
  // priority change to challenger > expander > synthesiser still picks
  // synthesiser here because the LLM's top score is synthesiser.
  const result = evaluateGate(factors({
    breadth_deficiency: present(0.65),
    integration_deficiency: present(0.9),
  }), { remainingTime: 600_000 });
  assert.equal(result.decision, "specialist");
  assert.equal(result.chosenRole, "synthesiser");
  assert.equal(result.scores.synthesiser, 0.9);
});

// ── 2026-08-13 mention-pilot regression: deliberative priority band ──────────
//
// The 2026-08-13 21:33 mention-pilot on real LLM produced cases like
// `expander=0.6, synthesiser=0.8` -- a 0.2 margin. With the previous
// 0.05 margin band, the frozen deliberative priority
// (Scrutiny > Integration > Expansion, ROLE_PRIORITY) only fired for
// near-ties (margin <= 0.05) and so did not catch the LLM's natural
// score jitter on the @-mention scenarios. Widening the band lets the
// priority fire more often, so an LLM that rates `integration_deficiency`
// 0.8 and `breadth_deficiency` 0.6 -- where the LLM is treating the
// situation as "I should integrate what's been said" rather than
// "I should broaden to silent participants" -- still loses to the
// scrutiny-first priority if a scrutinisable claim is present. The two
// tests below pin the new behaviour at 0.2.

test("deliberative priority band: 0.2 margin -- challenger wins when scores are close enough that LLM jitter shouldn't decide", () => {
  // 2026-08-13 priority change: with all three roles eligible and close
  // scores, the new priority (challenger > expander > synthesiser) still
  // picks challenger because scrutinize is still highest.
  const result = evaluateGate(factors({
    breadth_deficiency: present(0.6),
    group_preference: present(0.6),
    justification_deficiency: present(0.6),
    integration_deficiency: present(0.8),
  }), { remainingTime: 600_000 });
  assert.equal(result.chosenRole, "challenger",
    `expected challenger (scrutiny-first priority), got ${result.chosenRole}`);
});

test("deliberative priority band: 0.2 margin -- with original priority, synthesiser wins over expander in the tied band (regression pin)", () => {
  // 2026-08-13: an experimental priority change to
  // ["challenger", "expander", "synthesiser"] (expand-before-integrate)
  // was tried and reverted because the live LLM's score noise
  // dominates the 0.1-0.2 margin band -- the change produced no net win
  // on the mention-pilot. The original priority
  // ["challenger", "synthesiser", "expander"] is kept. This test pins
  // that the original priority is the active one in the tied band.
  const result = evaluateGate(factors({
    breadth_deficiency: present(0.6),
    integration_deficiency: present(0.8),
  }), { remainingTime: 600_000 });
  assert.equal(result.chosenRole, "synthesiser",
    `expected synthesiser (original priority), got ${result.chosenRole}`);
});

test("deliberative priority band: 0.2 margin -- clear wins (>= 0.3) still go to the higher score", () => {
  // synthesiser 0.9 vs expander 0.6 -> margin 0.3, still clear synthesiser.
  // This guards against over-relaxing the band.
  const result = evaluateGate(factors({
    breadth_deficiency: present(0.6),
    integration_deficiency: present(0.9),
  }), { remainingTime: 600_000 });
  assert.equal(result.chosenRole, "synthesiser");
});

// ── 2026-08-13 no-need detection: self_correction routes to generalist ────────
//
// When the LLM detector rates self_correction strongly, recent
// participants are already doing the work a specialist intervention
// would request (asking for justification, broadening coverage,
// challenging, integrating). The Facilitator's value-add in that case
// is low. Route to generalist (a non-specialist facilitation prompt)
// instead of forcing a role pick on top of evidence the group is
// already self-processing. The 2026-08-13 mention-pilot's
// `control_no_mention_needed` scenario (3-person healthy discussion)
// is the canonical case.

test("no-need: self_correction at 0.5+ routes to generalist, even with specialist roles eligible", () => {
  const result = evaluateGate(factors({
    breadth_deficiency: present(0.6),
    self_correction: present(0.6),
    integration_deficiency: present(0.8),
  }), { remainingTime: 600_000 });
  assert.equal(result.decision, "generalist");
  assert.equal(result.fallbackKind, "participants_self_correcting");
  assert.match(result.reason, /self_correction=0\.600/);
});

test("no-need: self_correction at 0.49 does NOT route to generalist (threshold is 0.5)", () => {
  // Just below the threshold; the priority band still applies. With
  // the original priority, expander/synthesiser ties pick synthesiser.
  const result = evaluateGate(factors({
    breadth_deficiency: present(0.6),
    self_correction: present(0.49),
    integration_deficiency: present(0.8),
  }), { remainingTime: 600_000 });
  assert.equal(result.decision, "specialist");
  assert.equal(result.chosenRole, "synthesiser");
});

test("no-need: absent self_correction does NOT route to generalist (the LLM said participants are NOT self-correcting)", () => {
  // status='absent' with strength=0 is the typical "not happening" case.
  // The no-need detection should not fire; the priority band decides
  // (synthesiser wins for the original priority in the tied band).
  const result = evaluateGate(factors({
    breadth_deficiency: present(0.6),
    self_correction: absent(),
    integration_deficiency: present(0.8),
  }), { remainingTime: 600_000 });
  assert.equal(result.decision, "specialist");
  assert.equal(result.chosenRole, "synthesiser");
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
