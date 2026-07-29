/**
 * Unit tests for utils.js
 * No external dependencies needed — just run:
 *   NODE_OPTIONS=--experimental-vm-modules npx jest tests/utils.test.js
 */

import { computeGini, computeStateScores, selectRole, THRESHOLDS } from "../src/utils.js";

// ── Helper ─────────────────────────────────────────────────────────────────────

function makeFeatures({
  gini = 0.1,
  novelty = 0.8,
  redundancy = 0.0,
  agreement = 0.1,
  justification = 0.3,
} = {}) {
  return {
    gini_score:          gini,
    novelty_score:       novelty,
    redundancy_score:    redundancy,
    agreement_score:     agreement,
    justification_score: justification,
  };
}

// ── computeGini ────────────────────────────────────────────────────────────────

describe("computeGini", () => {
  test("equal values returns 0", () => {
    expect(computeGini([10, 10, 10])).toBeCloseTo(0, 2);
  });

  test("empty array returns 0", () => {
    expect(computeGini([])).toBe(0);
  });

  test("all zeros returns 0", () => {
    expect(computeGini([0, 0, 0])).toBe(0);
  });

  test("monopoly returns high value", () => {
    expect(computeGini([100, 1, 1])).toBeGreaterThan(0.6);
  });

  test("single value returns 0", () => {
    expect(computeGini([50])).toBe(0);
  });

  test("result always between 0 and 1", () => {
    const result = computeGini([10, 30, 60]);
    expect(result).toBeGreaterThanOrEqual(0);
    expect(result).toBeLessThanOrEqual(1);
  });
});

// ── computeStateScores ─────────────────────────────────────────────────────────

describe("computeStateScores", () => {
  test("high agreement low justification → high challenger score", () => {
    const features = makeFeatures({ agreement: 0.9, justification: 0.1 });
    const scores = computeStateScores(features);
    expect(scores.challenger).toBeGreaterThan(0.5);
  });

  test("low novelty high redundancy → high expander score", () => {
    const features = makeFeatures({ novelty: 0.1, redundancy: 0.9 });
    const scores = computeStateScores(features);
    expect(scores.expander).toBeGreaterThan(0.5);
  });

  test("high agreement high justification → high synthesiser score", () => {
    const features = makeFeatures({ agreement: 0.9, justification: 0.9 });
    const scores = computeStateScores(features);
    expect(scores.synthesiser).toBeGreaterThan(0.5);
  });

  test("high gini → high facilitator score", () => {
    const features = makeFeatures({ gini: 0.9 });
    const scores = computeStateScores(features);
    expect(scores.facilitator).toBe(0.9);
  });

  test("all scores present in output", () => {
    const scores = computeStateScores(makeFeatures());
    expect(scores).toHaveProperty("expander");
    expect(scores).toHaveProperty("challenger");
    expect(scores).toHaveProperty("synthesiser");
    expect(scores).toHaveProperty("facilitator");
  });

  test("expander formula: 0.6*(1-novelty) + 0.4*redundancy", () => {
    const features = makeFeatures({ novelty: 0.2, redundancy: 0.8 });
    const scores = computeStateScores(features);
    const expected = 0.6 * (1 - 0.2) + 0.4 * 0.8;
    expect(scores.expander).toBeCloseTo(expected, 4);
  });
});

// ── selectRole ─────────────────────────────────────────────────────────────────

describe("selectRole — basic", () => {
  test("no eligible roles returns silent", () => {
    const result = selectRole(makeFeatures(), 300000, null, false);
    expect(result.role).toBe("silent");
  });

  test("returns eligibleRoles array", () => {
    const result = selectRole(makeFeatures(), 300000, null, false);
    expect(Array.isArray(result.eligibleRoles)).toBe(true);
  });

  test("returns forced flag", () => {
    const result = selectRole(makeFeatures(), 300000, null, false);
    expect(result).toHaveProperty("forced");
  });
});

describe("selectRole — forced synthesiser", () => {
  test("fires when remainingTime <= 20s and not yet fired", () => {
    const result = selectRole(makeFeatures(), 15000, null, false);
    expect(result.role).toBe("synthesiser");
    expect(result.forced).toBe(true);
  });

  test("does not fire again if synthesiserFired = true", () => {
    const result = selectRole(makeFeatures(), 15000, null, true);
    expect(result.role).toBe("silent");
    expect(result.forced).toBe(false);
  });

  test("does not fire when time > 20s", () => {
    const result = selectRole(makeFeatures(), 30000, null, false);
    expect(result.role).toBe("silent"); // no eligible roles in default features
  });

  test("fires at exactly 20s boundary", () => {
    const result = selectRole(
      makeFeatures(),
      THRESHOLDS.synthesiser.forced_trigger_seconds * 1000,
      null,
      false
    );
    expect(result.role).toBe("synthesiser");
  });
});

describe("selectRole — priority rules", () => {
  test("facilitator takes priority over challenger", () => {
    const features = makeFeatures({ gini: 0.9, agreement: 0.9, justification: 0.1 });
    const result = selectRole(features, 300000, null, false);
    expect(result.role).toBe("facilitator");
  });

  test("challenger takes priority over expander", () => {
    const features = makeFeatures({
      agreement: 0.9, justification: 0.0,  // challenger eligible
      novelty: 0.1,   redundancy: 0.9,     // expander eligible
    });
    const result = selectRole(features, 300000, null, false);
    expect(result.role).toBe("challenger");
  });

  test("expander takes priority over synthesiser", () => {
    const features = makeFeatures({
      novelty: 0.1, redundancy: 0.9,       // expander eligible
      agreement: 0.8, justification: 0.8,  // synthesiser eligible
    });
    const result = selectRole(features, 300000, null, false);
    expect(result.role).toBe("expander");
  });
});

describe("selectRole — repeated role handling", () => {
  test("skips lastRole and picks next eligible", () => {
    const features = makeFeatures({ gini: 0.9, agreement: 0.9, justification: 0.1 });
    const result = selectRole(features, 300000, "facilitator", false);
    expect(result.role).toBe("challenger");
  });

  test("if all eligible roles are lastRole, still picks one", () => {
    // Only facilitator is eligible, and it is lastRole
    const features = makeFeatures({ gini: 0.9 });
    const result = selectRole(features, 300000, "facilitator", false);
    expect(result.role).toBe("facilitator"); // picks anyway rather than silent
  });

  test("lastRole = null never causes skip", () => {
    const features = makeFeatures({ gini: 0.9 });
    const result = selectRole(features, 300000, null, false);
    expect(result.role).toBe("facilitator");
  });
});

describe("selectRole — eligibleRoles list", () => {
  test("contains all roles that passed threshold", () => {
    const features = makeFeatures({ gini: 0.9, agreement: 0.9, justification: 0.1 });
    const result = selectRole(features, 300000, null, false);
    expect(result.eligibleRoles).toContain("facilitator");
    expect(result.eligibleRoles).toContain("challenger");
  });

  test("empty when no roles eligible", () => {
    const result = selectRole(makeFeatures(), 300000, null, false);
    expect(result.eligibleRoles).toHaveLength(0);
  });
});

describe("selectRole — individual role triggers", () => {
  test("challenger triggers: high agreement + low justification", () => {
    const features = makeFeatures({ agreement: 0.9, justification: 0.0 });
    const result = selectRole(features, 300000, null, false);
    expect(result.role).toBe("challenger");
  });

  test("facilitator triggers: high gini", () => {
    const features = makeFeatures({ gini: 0.9 });
    const result = selectRole(features, 300000, null, false);
    expect(result.role).toBe("facilitator");
  });

  test("expander triggers: low novelty + high redundancy", () => {
    const features = makeFeatures({ novelty: 0.1, redundancy: 0.9 });
    const result = selectRole(features, 300000, null, false);
    expect(result.role).toBe("expander");
  });

  test("synthesiser triggers: high agreement + high justification", () => {
    // Make sure higher priority roles are not eligible
    const features = makeFeatures({
      gini: 0.1,          // facilitator not eligible
      agreement: 0.9,
      justification: 0.9, // challenger not eligible (justification high)
      novelty: 0.8,       // expander not eligible
      redundancy: 0.0,
    });
    const result = selectRole(features, 300000, null, false);
    expect(result.role).toBe("synthesiser");
  });

  test("nothing triggers when all scores below threshold", () => {
    const features = makeFeatures({
      gini: 0.1,
      novelty: 0.9,
      redundancy: 0.0,
      agreement: 0.1,
      justification: 0.5,
    });
    const result = selectRole(features, 300000, null, false);
    expect(result.role).toBe("silent");
  });
});