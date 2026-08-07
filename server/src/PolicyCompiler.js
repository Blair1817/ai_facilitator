/**
 * PolicyCompiler.js
 *
 * Architecture doc Step 8. Turns the Controller's selected role (Adaptive
 * only -- see utils.js's chooseRole()) plus the Evidence Checker's
 * verified factors (EvidenceChecker.js's checkEvidence() output) into a
 * discrete, bounded generation plan: role, intensity, maxSentences,
 * evidenceIds (which message IDs the Generator is allowed to cite),
 * gap (a plain-language description of the detected deficiency, built
 * only from verified spans -- never invented here), and prohibitions.
 *
 * Pure functions only -- no fetch, no Empirica import, no dotenv, no LLM
 * call. Same testability convention as utils.js/EvidenceChecker.js.
 *
 * Static AI does not go through this module at all: it always uses the
 * fixed general prompt when the shared gate says Act (see callbacks.js).
 * This module is Adaptive-only.
 */

// Which checked-factor key(s) each role's plan is built from.
const ROLE_FACTOR_KEYS = {
  expander: ["breadth_deficiency"],
  challenger: ["group_preference", "justification_deficiency"],
  synthesiser: ["integration_deficiency"],
};

// Plain-language gap labels, one per factor key. Deliberately generic and
// non-technical (no "strength", "threshold", or internal metric names) --
// this text can end up in RELEVANT_DISCUSSION_STATE, which base.md's HARD
// CONSTRAINTS forbid exposing internal reasoning/thresholds through, so the
// wording itself must already be safe to hand to the Generator.
const GAP_LABEL = {
  breadth_deficiency: "there is task-relevant information, an option, or a criterion the group has not yet covered",
  group_preference: "more than one participant has converged on the same preference",
  justification_deficiency: "that preference has not yet been backed by stated reasoning or evidence",
  integration_deficiency: "evidence has been shared but not yet organised or compared across options/criteria",
};

// Fixed, role-independent prohibitions (base.md's HARD CONSTRAINTS already
// enforce these at the Generator level; recording them on the plan too is
// for logging/auditability -- Methods 3.4.3's "system logs" requirement --
// not to re-teach the model something it is already told).
const FIXED_PROHIBITIONS = [
  "MUST_NOT_RECOMMEND_OR_RANK_OPTION",
  "MUST_NOT_REVEAL_PRIVATE_PROFILE_INFORMATION",
  "MUST_NOT_CLAIM_TO_KNOW_CORRECT_ANSWER",
  "MUST_NOT_EXCEED_TWO_SENTENCES",
];

function dedupe(arr) {
  return [...new Set(arr)];
}

/**
 * @param {"expander"|"challenger"|"synthesiser"} role
 * @param {object} checkedFactors - EvidenceChecker.js output.
 * @param {number} score - the role's score from evaluateGate()'s `scores`.
 * @param {number} threshold - the role's own eligibility threshold
 *   (utils.js's per-role THRESHOLDS.<role>.threshold /
 *   .expander_threshold), used only to classify intensity.
 * @param {string[]} eligibleMessageIds - this checkpoint's full set of
 *   citable participant message IDs (DynamicContext.mjs's
 *   eligibleMessageIds) -- evidenceIds is always intersected with this so
 *   a plan can never license citing an ID the Generator wouldn't otherwise
 *   be allowed to cite anyway.
 */
export function compilePlan(role, checkedFactors, { score, threshold, eligibleMessageIds = [] } = {}) {
  const factorKeys = ROLE_FACTOR_KEYS[role];
  if (!factorKeys) {
    throw new Error(`compilePlan(): unknown role "${role}"`);
  }

  const eligibleSet = new Set(eligibleMessageIds);
  const relevantFactors = factorKeys
    .map((key) => ({ key, factor: checkedFactors?.[key] }))
    .filter(({ factor }) => factor && factor.status === "present");

  const evidenceIds = dedupe(
    relevantFactors.flatMap(({ factor }) => factor.message_ids || [])
  ).filter((id) => eligibleSet.size === 0 || eligibleSet.has(id));

  const gap = relevantFactors.length
    ? relevantFactors
        .map(({ key, factor }) => `${GAP_LABEL[key]}${factor.span ? ` (e.g. "${factor.span}")` : ""}`)
        .join("; ")
    : "role selected on combined feature/semantic score; no single verified span available";

  // Intensity: placeholder classification, not calibrated. Halfway between
  // the role's own eligibility threshold and the maximum possible score
  // (1.0) -- a role that only just cleared its bar gets "medium", one that
  // cleared it comfortably gets "high". See IMPLEMENTATION_LOGIC.md.
  const midpoint = typeof threshold === "number" ? threshold + (1 - threshold) / 2 : 0.75;
  const intensity = typeof score === "number" && score >= midpoint ? "high" : "medium";

  return {
    role,
    intensity,
    maxSentences: 2,
    evidenceIds,
    gap,
    prohibitions: [...FIXED_PROHIBITIONS],
  };
}
