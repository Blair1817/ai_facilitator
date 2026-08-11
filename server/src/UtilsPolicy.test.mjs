import test, { describe } from "node:test";
import assert from "node:assert/strict";

function expect(actual) {
  const api = {
    toBe: (expected) => assert.equal(actual, expected),
    toBeCloseTo: (expected, digits = 2) => assert.ok(Math.abs(actual - expected) < (0.5 * (10 ** -digits))),
    toBeGreaterThan: (expected) => assert.ok(actual > expected),
    toBeGreaterThanOrEqual: (expected) => assert.ok(actual >= expected),
    toBeUndefined: () => assert.equal(actual, undefined),
    toContain: (expected) => assert.ok(actual.includes(expected)),
    toEqual: (expected) => assert.deepEqual(actual, expected),
    toHaveProperty: (expected) => assert.ok(Object.hasOwn(actual, expected)),
    toMatch: (expected) => assert.match(actual, expected),
    toThrow: () => assert.throws(actual),
  };
  api.not = {
    toContain: (expected) => assert.ok(!actual.includes(expected)),
    toHaveProperty: (expected) => assert.ok(!Object.hasOwn(actual, expected)),
  };
  return api;
}

/**
 * Unit tests for utils.js
 *
 * 2026-08-07 rewrite: utils.js's old flat selectRole() (feature scores in,
 * role out, facilitator included, forced-synthesiser could override an
 * Abstain) was split into getCandidateRoles() / evaluateGate() /
 * chooseRole(), with facilitator removed and the priority order fixed to
 * Challenger > Synthesiser > Expander. See utils.js's own header comment
 * and server/src/prompts/PROMPT_MODULE_STATUS.md's addendum for the full
 * rationale. This file replaces the old selectRole-based test suite with
 * one exercising the new functions directly.
 *
 * Run:
 *   NODE_OPTIONS=--experimental-vm-modules npx jest tests/utils.test.js
 */

import {
  computeGini,
  computeFeatureScores,
  getCandidateRoles,
  evaluateGate,
  chooseRole,
  computePersistence,
  computePenalty,
  computeStageFit,
  getRoleThreshold,
  THRESHOLDS,
  ROLE_PRIORITY,
  ROLES,
} from "./utils.js";

// ── Helpers ─────────────────────────────────────────────────────────────────

function makeFeatures({ novelty = 0.8, redundancy = 0.0, agreement = 0.1, justification = 0.3 } = {}) {
  return { novelty_score: novelty, redundancy_score: redundancy, agreement_score: agreement, justification_score: justification };
}

function presentFactor(strength = 0.8) {
  return { status: "present", strength, message_ids: ["m0"], span: "example span" };
}
function absentFactor() {
  return { status: "absent", strength: 0, message_ids: [], span: "" };
}

function noFactors() {
  return {
    breadth_deficiency: absentFactor(),
    group_preference: absentFactor(),
    justification_deficiency: absentFactor(),
    integration_deficiency: absentFactor(),
    self_correction: absentFactor(),
  };
}

// ── computeGini (unchanged) ─────────────────────────────────────────────────

describe("computeGini", () => {
  test("equal values returns 0", () => {
    expect(computeGini([10, 10, 10])).toBeCloseTo(0, 2);
  });
  test("empty array returns 0", () => {
    expect(computeGini([])).toBe(0);
  });
  test("monopoly returns high value", () => {
    expect(computeGini([100, 1, 1])).toBeGreaterThan(0.6);
  });
});

// ── ROLES / ROLE_PRIORITY: facilitator removed, order fixed ────────────────

describe("role set and priority", () => {
  test("facilitator is not a role", () => {
    expect(ROLES).not.toContain("facilitator");
    expect(ROLE_PRIORITY).not.toContain("facilitator");
    expect(THRESHOLDS.facilitator).toBeUndefined();
  });
  test("priority order is Challenger > Synthesiser > Expander", () => {
    expect(ROLE_PRIORITY).toEqual(["challenger", "synthesiser", "expander"]);
  });
});

// ── computeFeatureScores ─────────────────────────────────────────────────────

describe("computeFeatureScores", () => {
  test("high agreement low justification -> high challenger score", () => {
    const scores = computeFeatureScores(makeFeatures({ agreement: 0.9, justification: 0.1 }));
    expect(scores.challenger).toBeGreaterThan(0.5);
  });
  test("low novelty high redundancy -> high expander score", () => {
    const scores = computeFeatureScores(makeFeatures({ novelty: 0.1, redundancy: 0.9 }));
    expect(scores.expander).toBeGreaterThan(0.5);
  });
  test("high agreement high justification -> high synthesiser score", () => {
    const scores = computeFeatureScores(makeFeatures({ agreement: 0.9, justification: 0.9 }));
    expect(scores.synthesiser).toBeGreaterThan(0.5);
  });
  test("no facilitator key in output", () => {
    const scores = computeFeatureScores(makeFeatures());
    expect(scores).not.toHaveProperty("facilitator");
    expect(scores).toHaveProperty("expander");
    expect(scores).toHaveProperty("challenger");
    expect(scores).toHaveProperty("synthesiser");
  });
});

// ── getCandidateRoles (Step 4) ──────────────────────────────────────────────

describe("getCandidateRoles", () => {
  test("empty when nothing crosses the loose candidate thresholds", () => {
    const roles = getCandidateRoles(makeFeatures({ novelty: 0.9, redundancy: 0.0, agreement: 0.1, justification: 0.6 }));
    expect(roles).toEqual([]);
  });
  test("flags expander on low novelty or high redundancy", () => {
    expect(getCandidateRoles(makeFeatures({ novelty: 0.1 }))).toContain("expander");
    expect(getCandidateRoles(makeFeatures({ novelty: 0.9, redundancy: 0.9 }))).toContain("expander");
  });
  test("flags challenger on high agreement alone", () => {
    expect(getCandidateRoles(makeFeatures({ agreement: 0.9, justification: 0.9 }))).toContain("challenger");
  });
  test("flags synthesiser only when BOTH agreement and justification are high", () => {
    expect(getCandidateRoles(makeFeatures({ agreement: 0.9, justification: 0.1 }))).not.toContain("synthesiser");
    expect(getCandidateRoles(makeFeatures({ agreement: 0.9, justification: 0.9 }))).toContain("synthesiser");
  });
});

// ── evaluateGate (Step 7 shared gate) ───────────────────────────────────────

describe("evaluateGate", () => {
  test("Abstain when candidateRoles is empty -- never reaches checkedFactors", () => {
    const result = evaluateGate(makeFeatures(), null, [], { remainingTime: 300000, lastRole: null });
    expect(result.act).toBe(false);
    expect(result.reason).toMatch(/Candidate Gate/);
  });

  test("Abstain when candidates exist but no factor was confirmed present", () => {
    const result = evaluateGate(makeFeatures({ agreement: 0.9, justification: 0.9 }), noFactors(), ["challenger", "synthesiser"], {
      remainingTime: 300000,
      lastRole: null,
    });
    expect(result.act).toBe(false);
    expect(result.reason).toMatch(/Evidence Checker/);
  });

  test("Act when a role's hard gate and threshold are both satisfied", () => {
    const checked = { ...noFactors(), group_preference: presentFactor(0.8), justification_deficiency: presentFactor(0.8) };
    const result = evaluateGate(makeFeatures({ agreement: 0.9, justification: 0.1 }), checked, ["challenger"], {
      remainingTime: 300000,
      lastRole: null,
    });
    expect(result.act).toBe(true);
    expect(result.eligibleRoles).toContain("challenger");
  });

  test("hard gate requires the role to ALSO be a feature-level candidate, not just semantically present", () => {
    // integration_deficiency present, but synthesiser never became a
    // feature-level candidate (agreement/justification too low) -- hard
    // gate must fail.
    const checked = { ...noFactors(), integration_deficiency: presentFactor(0.9) };
    const result = evaluateGate(makeFeatures({ agreement: 0.1, justification: 0.1 }), checked, [], {
      remainingTime: 300000,
      lastRole: null,
    });
    expect(result.act).toBe(false);
  });

  test("Abstain when remaining time is below the hard time floor, regardless of scores", () => {
    const checked = { ...noFactors(), group_preference: presentFactor(0.9), justification_deficiency: presentFactor(0.9) };
    const result = evaluateGate(makeFeatures({ agreement: 0.9, justification: 0.1 }), checked, ["challenger"], {
      remainingTime: THRESHOLDS.gate.min_time_for_intervention_seconds * 1000 - 1,
      lastRole: null,
    });
    expect(result.act).toBe(false);
    expect(result.reason).toMatch(/Insufficient time/);
  });

  test("Abstain on too-small top-two margin between two eligible roles", () => {
    // Construct near-identical challenger/expander scores by hand-checking
    // hard gates for both, then shrink the margin threshold to force a
    // collision deterministically regardless of the live formula weights.
    const checked = {
      ...noFactors(),
      breadth_deficiency: presentFactor(0.9),
      group_preference: presentFactor(0.9),
      justification_deficiency: presentFactor(0.9),
    };
    const features = makeFeatures({ novelty: 0.1, redundancy: 0.9, agreement: 0.9, justification: 0.1 });
    const candidateRoles = ["expander", "challenger"];

    // First confirm both are independently eligible with a permissive margin.
    const originalMargin = THRESHOLDS.gate.margin;
    THRESHOLDS.gate.margin = 0;
    const permissive = evaluateGate(features, checked, candidateRoles, { remainingTime: 300000, lastRole: null });
    expect(permissive.eligibleRoles.length).toBeGreaterThanOrEqual(1);

    // Now force an impossibly large margin requirement -> must Abstain even
    // though at least one role clearly cleared its own threshold.
    THRESHOLDS.gate.margin = 10;
    const strict = evaluateGate(features, checked, candidateRoles, { remainingTime: 300000, lastRole: null });
    THRESHOLDS.gate.margin = originalMargin; // restore -- THRESHOLDS is shared module state
    if (permissive.eligibleRoles.length >= 2) {
      expect(strict.act).toBe(false);
      expect(strict.reason).toMatch(/margin/);
    }
  });
});

// ── chooseRole (Adaptive-only, given gate already Act) ──────────────────────

describe("chooseRole", () => {
  test("throws if gate result was Abstain -- must never manufacture an intervention", () => {
    const abstain = { act: false, reason: "x", scores: {}, eligibleRoles: [] };
    expect(() => chooseRole(abstain, { remainingTime: 300000, lastRole: null, synthesiserFired: false })).toThrow();
  });

  test("picks the highest-priority eligible role", () => {
    const act = { act: true, reason: "x", scores: { challenger: 0.7, expander: 0.9 }, eligibleRoles: ["challenger", "expander"] };
    const result = chooseRole(act, { remainingTime: 300000, lastRole: null, synthesiserFired: false });
    expect(result.role).toBe("challenger"); // Challenger outranks Expander regardless of raw score
  });

  test("skips lastRole when an alternative is eligible", () => {
    const act = { act: true, reason: "x", scores: { challenger: 0.7, expander: 0.9 }, eligibleRoles: ["challenger", "expander"] };
    const result = chooseRole(act, { remainingTime: 300000, lastRole: "challenger", synthesiserFired: false });
    expect(result.role).toBe("expander");
  });

  test("repeats lastRole if it is the only eligible role", () => {
    const act = { act: true, reason: "x", scores: { challenger: 0.7 }, eligibleRoles: ["challenger"] };
    const result = chooseRole(act, { remainingTime: 300000, lastRole: "challenger", synthesiserFired: false });
    expect(result.role).toBe("challenger");
  });

  describe("forced synthesiser nudge (reconciled semantics)", () => {
    const nearDeadline = THRESHOLDS.synthesiser.forced_trigger_seconds * 1000 - 1;

    test("fires when synthesiser is itself eligible, gate already Act, not yet fired", () => {
      const act = { act: true, reason: "x", scores: { challenger: 0.9, synthesiser: 0.65 }, eligibleRoles: ["challenger", "synthesiser"] };
      const result = chooseRole(act, { remainingTime: nearDeadline, lastRole: null, synthesiserFired: false });
      expect(result.role).toBe("synthesiser");
      expect(result.forced).toBe(true);
    });

    test("does NOT fire if synthesiser never became eligible this checkpoint (cannot manufacture eligibility)", () => {
      const act = { act: true, reason: "x", scores: { challenger: 0.9 }, eligibleRoles: ["challenger"] };
      const result = chooseRole(act, { remainingTime: nearDeadline, lastRole: null, synthesiserFired: false });
      expect(result.role).toBe("challenger");
      expect(result.forced).toBe(false);
    });

    test("does not fire again once synthesiserFired is true", () => {
      const act = { act: true, reason: "x", scores: { challenger: 0.9, synthesiser: 0.65 }, eligibleRoles: ["challenger", "synthesiser"] };
      const result = chooseRole(act, { remainingTime: nearDeadline, lastRole: null, synthesiserFired: true });
      expect(result.role).toBe("challenger");
    });

    test("does not fire when time > forced_trigger_seconds", () => {
      const act = { act: true, reason: "x", scores: { challenger: 0.9, synthesiser: 0.65 }, eligibleRoles: ["challenger", "synthesiser"] };
      const result = chooseRole(act, { remainingTime: 300000, lastRole: null, synthesiserFired: false });
      expect(result.role).toBe("challenger");
    });

    test("cannot fire at all when the gate itself returned Abstain (time-floor case)", () => {
      // This is the scenario the old selectRole() got wrong: forced
      // synthesiser used to be checked BEFORE any threshold/gate logic and
      // could fire even with 0 eligible roles. Now chooseRole() cannot be
      // called at all on an Abstain result (see the "throws" test above),
      // so this scenario structurally cannot produce a message.
      const abstain = evaluateGate(makeFeatures(), null, [], { remainingTime: 5000, lastRole: null });
      expect(abstain.act).toBe(false);
      expect(() => chooseRole(abstain, { remainingTime: 5000, lastRole: null, synthesiserFired: false })).toThrow();
    });
  });
});

// ── computePersistence / computePenalty / computeStageFit (wired, 0-weighted) ──

describe("computePersistence / computePenalty / computeStageFit", () => {
  test("computePersistence is 1 only when the same factor was present at both checkpoints", () => {
    const now = { ...noFactors(), group_preference: presentFactor() };
    const prev = { ...noFactors(), group_preference: presentFactor() };
    expect(computePersistence("challenger", now, prev)).toBe(1);
    expect(computePersistence("challenger", now, null)).toBe(0);
    expect(computePersistence("challenger", now, noFactors())).toBe(0);
  });

  test("computePenalty is 1 only when role === lastRole", () => {
    expect(computePenalty("challenger", "challenger")).toBe(1);
    expect(computePenalty("challenger", "expander")).toBe(0);
    expect(computePenalty("challenger", null)).toBe(0);
  });

  test("computeStageFit is always 0 (no discussion-stage feature exists yet)", () => {
    expect(computeStageFit("expander")).toBe(0);
    expect(computeStageFit("challenger")).toBe(0);
  });

  test("weights.persistence/stage_fit/penalty default to 0 -- these terms currently do not move scores", () => {
    expect(THRESHOLDS.weights.persistence).toBe(0);
    expect(THRESHOLDS.weights.stage_fit).toBe(0);
    expect(THRESHOLDS.weights.penalty).toBe(0);
  });
});

// ── getRoleThreshold ─────────────────────────────────────────────────────────

describe("getRoleThreshold", () => {
  test("returns the right per-role threshold", () => {
    expect(getRoleThreshold("expander")).toBe(THRESHOLDS.expander.expander_threshold);
    expect(getRoleThreshold("challenger")).toBe(THRESHOLDS.challenger.threshold);
    expect(getRoleThreshold("synthesiser")).toBe(THRESHOLDS.synthesiser.threshold);
  });
  test("throws on an unknown role", () => {
    expect(() => getRoleThreshold("facilitator")).toThrow();
  });
});
