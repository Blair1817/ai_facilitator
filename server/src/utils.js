/**
 * utils.js
 *
 * Pure functions for discussion state detection and role selection.
 * No Empirica or external dependencies -- safe to import in Jest/node:test
 * and (historically) the debug UI.
 *
 * 2026-08-07 rewrite (see server/src/prompts/PROMPT_MODULE_STATUS.md's
 * "Semantic Assessor layer reinstated" addendum for the decision record):
 * this file used to hold the ENTIRE role-selection pipeline in one function
 * (`selectRole()`, feature scores in, role out, no semantic layer, no
 * shared Act/Abstain gate independent of role identity). It is now only the
 * FEATURE-based and SCORING part of a longer pipeline; the semantic
 * judgment step lives in SemanticAssessor.js (LLM call) and
 * EvidenceChecker.js (deterministic verification of that LLM's output).
 * This file never calls an LLM and never does I/O -- it stays a pure
 * function library so it can keep being unit-tested without a network
 * connection or an API key.
 *
 * Pipeline this file participates in (see server/src/callbacks.js for the
 * orchestration and IMPLEMENTATION_LOGIC.md for the full walkthrough):
 *
 *   features (Python sidecar)
 *     -> getCandidateRoles()          [Step 4: loose, high-recall filter]
 *     -> (if non-empty) SemanticAssessor.js  [Step 5: LLM]
 *     -> EvidenceChecker.js           [Step 6: deterministic verification]
 *     -> evaluateGate()               [Step 7: hard gates + weighted score
 *                                       + threshold + top-two margin ->
 *                                       shared Act/Abstain, SAME for Static
 *                                       and Adaptive]
 *     -> chooseRole()                 [Adaptive only: which eligible role,
 *                                       given Act was already decided]
 *
 * This is the single source of truth for THRESHOLDS, ROLE_PRIORITY, and
 * all of the above functions. Any change to thresholds or role logic must
 * be made here only.
 *
 * KNOWN STALE REFERENCE: this file's old header claimed "debug_ui.html
 * imports from this file." That was never actually true -- debug_ui.html
 * has always had its own hand-copied, inline version of THRESHOLDS/
 * computeStateScores/selectRole (no <script type="module"> import exists
 * anywhere in that file; confirmed by reading it). That inline copy is now
 * STALE relative to this rewrite (it still has the removed "facilitator"
 * role, the old flat selectRole() signature, and no semantic layer at
 * all). debug_ui.html is a manual dev tool, not part of the live
 * experiment path (server/src/callbacks.js never loads it) and out of
 * scope for this task -- left untouched, but flagged here so nobody
 * mistakes its inline logic for a preview of this file's real behavior.
 */

// ── Role set ─────────────────────────────────────────────────────────────────
//
// "facilitator" (participation-balance / Gini-driven) has been REMOVED as a
// role, per the Brief's own stated design decision ("Facilitator role已从
// 设计中移除，只保留Expander、Challenger、Synthesiser") and confirmed by
// server/src/prompts/PROMPT_MODULE_STATUS.md: no prompt file, no
// generation.schema.json role enum entry ever existed for it. Before this
// rewrite, utils.js still computed a facilitator score/threshold/priority
// slot; if the Gini signal won, the Controller would pick "facilitator",
// promptLoader.js would come back `blocked` (no prompt file), and the
// checkpoint would silently burn an intervention opportunity as Silent --
// even when another real role (expander/challenger/synthesiser) also
// cleared its own threshold that same turn. That silent-loss path is gone
// now that facilitator no longer exists anywhere in this file.
export const ROLES = ["expander", "challenger", "synthesiser"];

// Fixed per Methods 3.2.3.2 / the Brief ("provisional order is Scrutiny,
// then Integration, then Expansion" = Challenger > Synthesiser > Expander).
// The old ROLE_PRIORITY was ["facilitator","challenger","expander","synthesiser"]
// -- besides the removed facilitator slot, expander was ranked ABOVE
// synthesiser, which directly contradicted this documented order.
export const ROLE_PRIORITY = ["challenger", "synthesiser", "expander"];

export const THRESHOLDS = {
  // Per-role feature-score weights and final eligibility thresholds.
  // Unchanged in shape from the pre-rewrite version (still placeholders
  // pending DetectorCalib calibration).
  expander: {
    novelty_weight:       0.6,
    redundancy_weight:    0.4,
    expander_threshold:   0.35,
    redundancy_threshold: 0.85,
  },
  challenger: {
    agreement_weight:     0.5,
    justification_weight: 0.5,
    threshold:             0.6,
  },
  synthesiser: {
    agreement_weight:       0.5,
    justification_weight:   0.5,
    threshold:               0.6,
    // Distinct from THRESHOLDS.gate.min_time_for_intervention_seconds --
    // see chooseRole()'s doc comment for how the two now interact.
    forced_trigger_seconds: 20,
  },

  // Step 4 Candidate Gate (getCandidateRoles): deliberately LOOSER than the
  // per-role thresholds above -- this stage optimises for recall (don't
  // miss a role that might need semantic assessment), not precision. A
  // role reaching candidate status only means "worth spending a Semantic
  // Assessor LLM call on," not "eligible." Placeholder values, same status
  // as everything else in this object.
  candidate: {
    expander_novelty_max:          0.5,
    expander_redundancy_min:       0.5,
    challenger_agreement_min:      0.4,
    synthesiser_agreement_min:     0.4,
    synthesiser_justification_min: 0.4,
  },

  // Step 7 Role-Scoring Controller combined-score weights, matching the
  // architecture doc's suggested formula:
  //   S(role) = hard_gate(role) x [
  //     alpha*feature_score(role) + beta*semantic_score(role)
  //     + gamma*persistence(role) + delta*stage_fit(role)
  //     - lambda*penalty(role)
  //   ]
  // `feature` and `semantic` are real, populated terms. `persistence` and
  // `penalty` are real, computable terms (see computePersistence /
  // computePenalty below) but weighted at 0 by default -- there is no
  // calibration data yet to justify a non-zero weight, and raising them is
  // a research decision, not something to guess at here. `stage_fit` is
  // weighted at 0 AND always evaluates to 0 regardless of weight, because
  // feature_server.py computes no "discussion stage" signal at all yet --
  // there is nothing to weight. See IMPLEMENTATION_LOGIC.md.
  weights: {
    feature:     0.6,
    semantic:    0.4,
    persistence: 0,
    stage_fit:   0,
    penalty:     0,
  },

  gate: {
    // Methods 3.2.2 lists "insufficient time remains for a meaningful
    // intervention-response cycle" as its own Abstain condition, separate
    // from "no need exceeds threshold." Placeholder value pending
    // calibration/pilot data -- deliberately distinct from
    // synthesiser.forced_trigger_seconds (20s): that window only re-picks
    // WHICH role Adaptive uses once the gate has already said Act (see
    // chooseRole()); this floor can make the gate say Abstain outright,
    // for both conditions, regardless of feature/semantic scores.
    min_time_for_intervention_seconds: 10,

    // Top-two margin (architecture doc section 7: "top-1与top-2差距低于
    // margin -> Generalist/Abstain"). If the best and second-best
    // hard-gated role scores are closer than this, evaluateGate() treats
    // the decision as too ambiguous and returns Abstain rather than
    // guessing. Placeholder value.
    //
    // NOTE: the architecture doc's own Table 6 leaves open whether a
    // margin failure (or "no role clearly eligible") should fall back to
    // Abstain or to a not-yet-built "Generalist" policy identical to
    // Static's fixed prompt -- that table's own footnote marks this as
    // undecided pending Pilot 2 data ("如果pilot2发现...就考虑不用abstain
    // ，而是触发一条常规消息？？？"). This rewrite takes the Abstain branch,
    // matching the Methods manuscript's stated frozen default and this
    // session's Plan B decision. Introducing a Generalist output later
    // only requires a new branch in callbacks.js after evaluateGate()
    // returns `act:false` for a margin/no-eligible-role reason -- nothing
    // here needs to change.
    margin: 0.05,
  },
};

// ── Gini (kept for parity with feature_server.py's compute_gini; no
// longer used by role scoring now that facilitator is removed, but still a
// legitimate, independently useful/testable utility) ──────────────────────

export function computeGini(values) {
  if (!values.length || values.reduce((a, b) => a + b, 0) === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const n = sorted.length;
  const weightedSum = sorted.reduce((acc, v, i) => acc + (i + 1) * v, 0);
  return (2 * weightedSum) / (n * sorted.reduce((a, b) => a + b, 0)) - (n + 1) / n;
}

// ── Step 4: Candidate Gate ──────────────────────────────────────────────────

/**
 * High-recall, feature-only pre-filter. Returns the subset of ROLES worth
 * spending a Semantic Assessor LLM call on this checkpoint. An empty
 * result means the checkpoint can be resolved as Abstain WITHOUT calling
 * the LLM at all (matches the Brief's Step 4: "如果候选角色为空 ->
 * Abstain，不调用LLM").
 */
export function getCandidateRoles(features) {
  const { novelty_score, redundancy_score, agreement_score, justification_score } = features;
  const c = THRESHOLDS.candidate;
  const candidates = [];

  if (novelty_score <= c.expander_novelty_max || redundancy_score >= c.expander_redundancy_min) {
    candidates.push("expander");
  }
  if (agreement_score >= c.challenger_agreement_min) {
    candidates.push("challenger");
  }
  if (agreement_score >= c.synthesiser_agreement_min && justification_score >= c.synthesiser_justification_min) {
    candidates.push("synthesiser");
  }
  return candidates;
}

// ── Feature scores (renamed from computeStateScores; facilitator/gini_score
// removed from the return value -- it is no longer a role score) ──────────

export function computeFeatureScores(features) {
  const { novelty_score, redundancy_score, agreement_score, justification_score } = features;
  return {
    expander:    THRESHOLDS.expander.novelty_weight * (1 - novelty_score) +
                 THRESHOLDS.expander.redundancy_weight * redundancy_score,
    challenger:  THRESHOLDS.challenger.agreement_weight * agreement_score +
                 THRESHOLDS.challenger.justification_weight * (1 - justification_score),
    synthesiser: THRESHOLDS.synthesiser.agreement_weight * agreement_score +
                 THRESHOLDS.synthesiser.justification_weight * justification_score,
  };
}

function roleThreshold(role) {
  if (role === "expander")    return THRESHOLDS.expander.expander_threshold;
  if (role === "challenger")  return THRESHOLDS.challenger.threshold;
  if (role === "synthesiser") return THRESHOLDS.synthesiser.threshold;
  throw new Error(`roleThreshold(): unknown role "${role}"`);
}

// Exported so callbacks.js (PolicyCompiler.compilePlan's `threshold`
// argument) doesn't need its own duplicate copy of this mapping.
export const getRoleThreshold = roleThreshold;

function isPresent(factor) {
  return !!factor && factor.status === "present";
}

function strengthOf(factor) {
  return factor && typeof factor.strength === "number" ? factor.strength : 0;
}

/**
 * Step 7 hard gates (architecture doc Table 6's "必要条件" column), one
 * per role. Deliberately reuses the Step 4 Candidate Gate's membership
 * test as the "discussion is narrow/stagnant" / "evidence sufficiency"
 * feature-side condition instead of inventing a second, separate set of
 * magic thresholds -- a role can only be hard-gated in if BOTH the raw
 * feature signal (Candidate Gate) and the checked semantic factor
 * (Evidence Checker) agree something is really there.
 */
function requiredSemanticFactorsPresent(role, checkedFactors) {
  if (role === "expander")    return isPresent(checkedFactors?.breadth_deficiency);
  if (role === "challenger")  return isPresent(checkedFactors?.group_preference) && isPresent(checkedFactors?.justification_deficiency);
  if (role === "synthesiser") return isPresent(checkedFactors?.integration_deficiency);
  return false;
}

function passesHardGate(role, checkedFactors, candidateRoles) {
  return candidateRoles.includes(role) && requiredSemanticFactorsPresent(role, checkedFactors);
}

function semanticScore(role, checkedFactors) {
  if (role === "expander")    return strengthOf(checkedFactors?.breadth_deficiency);
  if (role === "challenger")  return (strengthOf(checkedFactors?.group_preference) + strengthOf(checkedFactors?.justification_deficiency)) / 2;
  if (role === "synthesiser") return strengthOf(checkedFactors?.integration_deficiency);
  return 0;
}

const PERSISTENCE_FACTOR_KEY = {
  expander:    "breadth_deficiency",
  challenger:  "group_preference",
  synthesiser: "integration_deficiency",
};

/**
 * Real, computable "was this role's deficiency also present at the
 * previous checkpoint" signal -- but see THRESHOLDS.weights.persistence:
 * weighted at 0 by default, so this currently has no effect on scores. It
 * is implemented (not stubbed) so a future calibration pass can raise the
 * weight without also having to build the computation from scratch, and
 * so it is independently unit-testable now.
 */
export function computePersistence(role, checkedFactors, previousCheckedFactors) {
  if (!previousCheckedFactors) return 0;
  const key = PERSISTENCE_FACTOR_KEY[role];
  return isPresent(checkedFactors?.[key]) && isPresent(previousCheckedFactors?.[key]) ? 1 : 0;
}

/**
 * Reserved for "recently addressed" / role-repetition penalties beyond
 * what EvidenceChecker's self_correction discount already bakes into
 * checkedFactors' own strength values (Evidence Checker Rule 4). Weighted
 * at 0 by default -- see THRESHOLDS.weights.penalty.
 */
export function computePenalty(role, lastRole) {
  return role === lastRole ? 1 : 0;
}

/**
 * stage_fit(role): architecture doc's delta term (discussion-stage fit).
 * No underlying feature exists yet -- feature_server.py computes no
 * "discussion stage" signal. Always 0, regardless of
 * THRESHOLDS.weights.stage_fit, until such a feature is added; kept as an
 * explicit named function (not just omitted from the formula) so the
 * formula's shape matches the architecture doc's S(role) exactly and the
 * TODO is visible at the call site, not just in a comment.
 */
export function computeStageFit(_role) {
  return 0;
}

export function computeRoleScore(role, features, checkedFactors, { previousCheckedFactors = null, lastRole = null } = {}) {
  const featureScores = computeFeatureScores(features);
  const w = THRESHOLDS.weights;
  return (
    w.feature * featureScores[role] +
    w.semantic * semanticScore(role, checkedFactors) +
    w.persistence * computePersistence(role, checkedFactors, previousCheckedFactors) +
    w.stage_fit * computeStageFit(role) -
    w.penalty * computePenalty(role, lastRole)
  );
}

// ── Step 7: Role-Scoring Controller / shared Act-Abstain gate ──────────────

/**
 * THE shared gate. Computes the SAME Act/Abstain decision regardless of
 * `facilitation` condition -- callbacks.js calls this once per checkpoint
 * and applies its `act` result identically to Static and Adaptive. Never
 * takes a condition/role argument, on purpose: Static AI is not supposed
 * to know or care which role would have won, only whether a real need was
 * detected at all (Methods 3.2.2: "The same Act/Abstain decision is
 * applied in both conditions").
 *
 * @param {object} features - this checkpoint's 5 feature scores.
 * @param {object|null} checkedFactors - EvidenceChecker output, or null if
 *   the Candidate Gate returned no candidates (Semantic Assessor was never
 *   called this checkpoint).
 * @param {string[]} candidateRoles - getCandidateRoles(features) output.
 * @param {object} ctx - { remainingTime (ms), previousCheckedFactors,
 *   lastRole }.
 */
export function evaluateGate(features, checkedFactors, candidateRoles, ctx = {}) {
  const { remainingTime, previousCheckedFactors = null, lastRole = null } = ctx;

  if (remainingTime <= THRESHOLDS.gate.min_time_for_intervention_seconds * 1000) {
    return {
      act: false,
      reason: `Insufficient time remaining (${remainingTime}ms <= ${THRESHOLDS.gate.min_time_for_intervention_seconds}s floor) for a meaningful intervention-response cycle`,
      scores: {},
      eligibleRoles: [],
      hardGatedRoles: [],
    };
  }

  const hardGatedRoles = ROLES.filter((r) => passesHardGate(r, checkedFactors, candidateRoles));
  if (hardGatedRoles.length === 0) {
    return {
      act: false,
      reason: candidateRoles.length === 0
        ? "No role reached the Candidate Gate (feature-only pre-filter); Semantic Assessor was not called this checkpoint"
        : "No role's semantic factors were confirmed present by the Evidence Checker",
      scores: {},
      eligibleRoles: [],
      hardGatedRoles: [],
    };
  }

  const scores = {};
  for (const role of hardGatedRoles) {
    scores[role] = computeRoleScore(role, features, checkedFactors, { previousCheckedFactors, lastRole });
  }

  const eligibleRoles = hardGatedRoles.filter((r) => scores[r] >= roleThreshold(r));
  if (eligibleRoles.length === 0) {
    return {
      act: false,
      reason: "No hard-gated role's combined score reached its threshold",
      scores,
      eligibleRoles: [],
      hardGatedRoles,
    };
  }

  const ranked = [...eligibleRoles].sort((a, b) => scores[b] - scores[a]);
  if (ranked.length >= 2) {
    const margin = scores[ranked[0]] - scores[ranked[1]];
    if (margin < THRESHOLDS.gate.margin) {
      return {
        act: false,
        reason: `Top-two margin too small (${margin.toFixed(3)} < ${THRESHOLDS.gate.margin}) between "${ranked[0]}" and "${ranked[1]}"`,
        scores,
        eligibleRoles,
        hardGatedRoles,
      };
    }
  }

  return {
    act: true,
    reason: `Eligible: ${eligibleRoles.join(", ")}`,
    scores,
    eligibleRoles,
    hardGatedRoles,
  };
}

// ── Adaptive-only: which eligible role, given the gate already said Act ────

/**
 * Must only be called with a gateResult where `act === true` -- throws
 * otherwise, on purpose: this function must never be able to manufacture
 * an intervention out of an Abstain decision (that was exactly the bug in
 * the pre-rewrite selectRole()'s forced-synthesiser branch, which fired
 * BEFORE any threshold check and could override an Abstain).
 *
 * Forced-synthesiser nudge: reconciled with Methods 3.2.2's "insufficient
 * time -> Abstain" rule (see THRESHOLDS.gate.min_time_for_intervention_seconds
 * above). The old implementation could fire synthesiser unconditionally in
 * the last N seconds regardless of whether anything real was detected,
 * which directly contradicted that Abstain condition. Now: the nudge can
 * only ever change WHICH already-eligible role Adaptive uses (it requires
 * "synthesiser" to itself be in gateResult.eligibleRoles, i.e. synthesiser
 * already cleared its own hard gate + threshold this checkpoint) -- it can
 * never create an intervention when the gate returned Abstain, and it can
 * never promote a role that never cleared its own bar. This is a
 * deliberately conservative reading of "nudge the group toward synthesis
 * before time runs out"; a looser reading (force synthesiser whenever the
 * gate is Act for ANY reason, even if synthesiser itself never became
 * eligible) is possible but was not adopted here without an explicit
 * decision from the research team -- see IMPLEMENTATION_LOGIC.md.
 */
export function chooseRole(gateResult, { remainingTime, lastRole = null, synthesiserFired = false } = {}) {
  if (!gateResult || gateResult.act !== true) {
    throw new Error("chooseRole() called with a non-Act gate result -- Adaptive must never select a role when the shared gate returned Abstain");
  }

  const { eligibleRoles, scores } = gateResult;
  const nearDeadline = remainingTime <= THRESHOLDS.synthesiser.forced_trigger_seconds * 1000;

  if (nearDeadline && !synthesiserFired && eligibleRoles.includes("synthesiser")) {
    return {
      role: "synthesiser",
      forced: true,
      reasoning: `Forced synthesiser nudge: remainingTime<=${THRESHOLDS.synthesiser.forced_trigger_seconds}s, gate already Act, synthesiser independently eligible (score=${scores.synthesiser.toFixed(3)})`,
    };
  }

  for (const role of ROLE_PRIORITY) {
    if (eligibleRoles.includes(role) && role !== lastRole) {
      return { role, forced: false, reasoning: `${role} selected by priority: score=${scores[role].toFixed(3)}, eligible=[${eligibleRoles.join(", ")}]` };
    }
  }
  for (const role of ROLE_PRIORITY) {
    if (eligibleRoles.includes(role)) {
      return { role, forced: false, reasoning: `${role} selected (repeated lastRole=${lastRole}, no alternative eligible this checkpoint)` };
    }
  }

  // Unreachable: gateResult.act === true guarantees eligibleRoles is
  // non-empty and every member is one of ROLE_PRIORITY's three roles.
  throw new Error("chooseRole(): unreachable -- eligibleRoles non-empty but no entry matched ROLE_PRIORITY");
}
