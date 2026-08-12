/**
 * Deterministic classification rules for the LLM-only discussion detector.
 *
 * The detector (SemanticAssessor.js) reads the public discussion and assigns
 * 0-1 strengths to semantic factors.  This module never extracts textual or
 * statistical features.  It only verifies the rule prerequisites, converts
 * the checked LLM strengths into role scores, and classifies the checkpoint
 * as specialist, generalist, or abstain.
 */

export const ROLES = ["expander", "challenger", "synthesiser"];
export const ROLE_PRIORITY = ["challenger", "synthesiser", "expander"];

export const THRESHOLDS = {
  expander: { threshold: 0.35 },
  challenger: { threshold: 0.6 },
  synthesiser: { threshold: 0.6, forced_trigger_seconds: 20 },
  gate: {
    min_time_for_intervention_seconds: 10,
    margin: 0.05,
  },
};

export function getRoleThreshold(role) {
  const threshold = THRESHOLDS[role]?.threshold;
  if (typeof threshold !== "number") {
    throw new Error(`getRoleThreshold(): unknown role "${role}"`);
  }
  return threshold;
}

function isPresent(factor) {
  return factor?.status === "present";
}

function strengthOf(factor) {
  if (!isPresent(factor) || typeof factor.strength !== "number") return 0;
  return Math.max(0, Math.min(1, factor.strength));
}

function requiredFactors(role) {
  if (role === "expander") return ["breadth_deficiency"];
  if (role === "challenger") return ["group_preference", "justification_deficiency"];
  if (role === "synthesiser") return ["integration_deficiency"];
  return [];
}

function missingRequiredFactor(role, checkedFactors) {
  return requiredFactors(role).find((key) => !isPresent(checkedFactors?.[key])) ?? null;
}

/**
 * Role scores are based only on checked LLM detector strengths:
 * - Expander: breadth deficiency
 * - Challenger: mean of group preference and justification deficiency;
 *   both are mandatory
 * - Synthesiser: integration deficiency
 *
 * EvidenceChecker may reduce a strength when the transcript does not support
 * it or when the group is already self-correcting. No non-LLM feature enters
 * this calculation.
 */
export function computeDetectorRoleScores(checkedFactors) {
  return {
    expander: strengthOf(checkedFactors?.breadth_deficiency),
    challenger:
      (strengthOf(checkedFactors?.group_preference) +
        strengthOf(checkedFactors?.justification_deficiency)) /
      2,
    synthesiser: strengthOf(checkedFactors?.integration_deficiency),
  };
}

/**
 * Classify one adaptive checkpoint from checked LLM detector output.
 * Operational failures/time pressure abstain; a real but non-distinct need
 * uses the Generalist; a clear, threshold-crossing winner uses a Specialist.
 */
export function evaluateGate(checkedFactors, ctx = {}) {
  const { remainingTime } = ctx;

  if (remainingTime <= THRESHOLDS.gate.min_time_for_intervention_seconds * 1000) {
    return {
      decision: "abstain",
      reason: `Insufficient time remaining (${remainingTime}ms <= ${THRESHOLDS.gate.min_time_for_intervention_seconds}s floor) for a meaningful intervention-response cycle`,
      scores: {}, eligibleRoles: [], hardGatedRoles: [], perRole: {},
      abstentionKind: "time_floor",
    };
  }

  if (!checkedFactors) {
    return {
      decision: "abstain",
      reason: "LLM detector output was unavailable or invalid",
      scores: {}, eligibleRoles: [], hardGatedRoles: [], perRole: {},
      abstentionKind: "detector_unavailable",
    };
  }

  const detectorScores = computeDetectorRoleScores(checkedFactors);
  const perRole = {};
  const hardGatedRoles = [];

  for (const role of ROLES) {
    const missing = missingRequiredFactor(role, checkedFactors);
    const hardGate = missing === null;
    if (hardGate) hardGatedRoles.push(role);
    const score = hardGate ? detectorScores[role] : 0;
    const threshold = getRoleThreshold(role);
    const eligible = hardGate && score >= threshold;
    perRole[role] = {
      eligible,
      score: Number(score.toFixed(4)),
      threshold,
      detectorGate: hardGate,
      supportingFactors: hardGate
        ? Object.fromEntries(requiredFactors(role).map((key) => [key, strengthOf(checkedFactors[key])]))
        : null,
      failureReason: !hardGate
        ? `required_factor_missing:${missing}`
        : (!eligible ? `below_threshold (${score.toFixed(3)} < ${threshold})` : null),
    };
  }

  if (hardGatedRoles.length === 0) {
    return {
      decision: "abstain",
      reason: "The checked LLM detector found no role's required semantic factors present",
      scores: detectorScores, eligibleRoles: [], hardGatedRoles: [], perRole,
      abstentionKind: "no_semantic_need",
    };
  }

  const scores = Object.fromEntries(hardGatedRoles.map((role) => [role, perRole[role].score]));
  const eligibleRoles = hardGatedRoles.filter((role) => perRole[role].eligible);
  if (eligibleRoles.length === 0) {
    return {
      decision: "generalist",
      reason: "The LLM detector found a discussion need, but no specialist score reached its rule threshold",
      scores, eligibleRoles: [], hardGatedRoles, perRole,
      fallbackKind: "no_role_meets_threshold",
    };
  }

  const ranked = [...eligibleRoles].sort((a, b) => scores[b] - scores[a]);
  let chosenRole = ranked[0];
  if (ranked.length >= 2) {
    const margin = scores[ranked[0]] - scores[ranked[1]];
    if (margin <= THRESHOLDS.gate.margin + Number.EPSILON * 8) {
      // Scores this close are not meaningfully distinct. Apply the frozen
      // deliberative-need priority (Scrutiny > Integration > Expansion)
      // instead of allowing minor LLM decimal jitter to select the role.
      const tiedBand = ranked.filter((role) => scores[ranked[0]] - scores[role] <= THRESHOLDS.gate.margin + Number.EPSILON * 8);
      chosenRole = ROLE_PRIORITY.find((role) => tiedBand.includes(role)) || ranked[0];
    }
  }

  return {
    decision: "specialist",
    reason: `Eligible from LLM detector: ${eligibleRoles.join(", ")} (selected: ${chosenRole} @ ${scores[chosenRole].toFixed(3)})`,
    scores, eligibleRoles, hardGatedRoles, perRole, chosenRole,
  };
}

export function chooseRole(gateResult, { remainingTime, lastRole = null, synthesiserFired = false, topTwoMarginFactor = 1.0 } = {}) {
  if (!gateResult) throw new Error("chooseRole() called with a null gate result");
  if (gateResult.decision === "abstain") {
    throw new Error("chooseRole() called with an Abstain gate decision");
  }
  if (gateResult.decision === "generalist") {
    return { role: "generalist", forced: false, reasoning: gateResult.reason };
  }

  const { eligibleRoles, scores, chosenRole } = gateResult;
  const nearDeadline = remainingTime <= THRESHOLDS.synthesiser.forced_trigger_seconds * 1000;
  if (nearDeadline && !synthesiserFired && eligibleRoles.includes("synthesiser")) {
    return {
      role: "synthesiser", forced: true,
      reasoning: `Forced synthesiser nudge near deadline; independently eligible from LLM detector (score=${scores.synthesiser.toFixed(3)})`,
    };
  }

  const winnerScore = chosenRole ? scores[chosenRole] : Math.max(...eligibleRoles.map((role) => scores[role]));
  if (chosenRole === lastRole) {
    for (const role of ROLE_PRIORITY) {
      if (role !== lastRole && eligibleRoles.includes(role)) {
        const margin = winnerScore - scores[role];
        if (margin <= THRESHOLDS.gate.margin * topTwoMarginFactor) {
          return { role, forced: false, reasoning: `${role} selected over repeated lastRole=${lastRole}` };
        }
      }
    }
  }

  if (chosenRole && eligibleRoles.includes(chosenRole)) {
    return { role: chosenRole, forced: false, reasoning: `${chosenRole} selected from LLM detector score=${scores[chosenRole].toFixed(3)}` };
  }
  for (const role of ROLE_PRIORITY) {
    if (eligibleRoles.includes(role)) return { role, forced: false, reasoning: `${role} selected by fixed tie-break priority` };
  }
  throw new Error("chooseRole(): specialist decision had no eligible role");
}
