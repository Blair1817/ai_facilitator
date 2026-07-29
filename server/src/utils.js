/**
 * utils.js
 *
 * Pure functions for discussion state detection and role selection.
 * No Empirica or external dependencies — safe to import in Jest tests
 * and the debug UI.
 *
 * This is the single source of truth for:
 *   - THRESHOLDS: all role trigger thresholds and weights (placeholders
 *                 until DetectorCalib produces final_thresholds.json)
 *   - ROLE_PRIORITY: priority order when multiple roles are eligible
 *   - computeGini(): Gini coefficient of a value distribution
 *   - computeStateScores(): weighted score for each role given feature scores
 *   - selectRole(): selects the intervention role based on scores,
 *                   priority rules, cooldown state, and remaining time
 *
 * Both callbacks.js and debug_ui.html import from this file.
 * Any change to thresholds or role logic must be made here only.
 *
 * Feature computation (Gini, Semantic Novelty, Redundancy, Agreement,
 * Justification) is handled by feature_server.py, not this file.
 */

export const THRESHOLDS = {
  expander: {
    novelty_weight:       0.6, 
    redundancy_weight:    0.4,  
    expander_threshold:   0.35,
    redundancy_threshold: 0.85,
  },
  challenger: {
    agreement_weight:     0.5,
    justification_weight: 0.5,
    threshold:            0.6,
  },
  synthesiser: {
    agreement_weight:       0.5,
    justification_weight:   0.5,
    threshold:              0.6,
    forced_trigger_seconds: 20,
  },
  facilitator: {
    gini_threshold: 0.5,
  },
};

export const ROLE_PRIORITY = ["facilitator", "challenger", "expander", "synthesiser"];

export function computeGini(values) {
  if (!values.length || values.reduce((a, b) => a + b, 0) === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const n = sorted.length;
  const weightedSum = sorted.reduce((acc, v, i) => acc + (i + 1) * v, 0);
  return (2 * weightedSum) / (n * sorted.reduce((a, b) => a + b, 0)) - (n + 1) / n;
}

export function computeStateScores(features) {
  const {
    gini_score,
    novelty_score,
    redundancy_score,
    agreement_score,
    justification_score,
  } = features;

  return {
    expander:    THRESHOLDS.expander.novelty_weight * (1 - novelty_score) +
                 THRESHOLDS.expander.redundancy_weight * redundancy_score,
    challenger:  THRESHOLDS.challenger.agreement_weight * agreement_score +
                 THRESHOLDS.challenger.justification_weight * (1 - justification_score),
    synthesiser: THRESHOLDS.synthesiser.agreement_weight * agreement_score +
                 THRESHOLDS.synthesiser.justification_weight * justification_score,
    facilitator: gini_score,
  };
}

export function selectRole(features, remainingTime, lastRole, synthesiserFired) {
  // Forced synthesiser in last N seconds
  if (
    remainingTime <= THRESHOLDS.synthesiser.forced_trigger_seconds * 1000 &&
    !synthesiserFired
  ) {
    return { role: "synthesiser", forced: true, scores: null, eligibleRoles: ["synthesiser"],
         reasoning: `Forced: remainingTime <= ${THRESHOLDS.synthesiser.forced_trigger_seconds}s` };
  }

  const scores = computeStateScores(features);
  const eligible = {};

  if (scores.expander    >= THRESHOLDS.expander.expander_threshold)    eligible.expander    = scores.expander;
  if (scores.challenger  >= THRESHOLDS.challenger.threshold)           eligible.challenger  = scores.challenger;
  if (scores.synthesiser >= THRESHOLDS.synthesiser.threshold)          eligible.synthesiser = scores.synthesiser;
  if (scores.facilitator >= THRESHOLDS.facilitator.gini_threshold)     eligible.facilitator = scores.facilitator;

  if (Object.keys(eligible).length === 0) {
    return { role: "silent", forced: false, scores, eligibleRoles: [],
         reasoning: "No role exceeded threshold" };
  }

  // Apply priority, skip lastRole
  for (const role of ROLE_PRIORITY) {
    if (eligible[role] && role !== lastRole) {
      return { role, forced: false, scores, eligibleRoles: Object.keys(eligible),
         reasoning: `${role} selected: score=${scores[role].toFixed(3)} >= threshold. eligible=[${Object.keys(eligible).join(", ")}]` };
    }
  }

  // All eligible are lastRole — pick anyway
  for (const role of ROLE_PRIORITY) {
    if (eligible[role]) {
      return { role, forced: false, scores, eligibleRoles: Object.keys(eligible),
         reasoning: `${role} selected (repeated lastRole=${lastRole}, no alternative). eligible=[${Object.keys(eligible).join(", ")}]` };
    }
  }

  return { role: "silent", forced: false, scores, eligibleRoles: [],
         reasoning: "Fallback silent" };
}