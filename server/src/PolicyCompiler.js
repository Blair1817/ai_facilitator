/**
 * PolicyCompiler.js
 *
 * Architecture doc Step 8. Turns the Controller's selected role (Adaptive
 * only -- see utils.js's chooseRole()) plus the Evidence Checker's
 * verified factors (EvidenceChecker.js's checkEvidence() output) into a
 * discrete, bounded generation plan: role, target, gap, required reasoning
 * act, answerable question, intensity, maxSentences, evidenceIds (which
 * message IDs the Generator is allowed to cite), gap (a plain-language
 * description of the detected deficiency, built only from verified spans
 * -- never invented here), and prohibitions.
 *
 * Pure functions only -- no fetch, no Empirica import, no dotenv, no LLM
 * call. Same testability convention as utils.js/EvidenceChecker.js.
 *
 * Static AI does not go through this module at all: it always uses the
 * fixed general prompt when the shared gate says Act (see callbacks.js).
 * This module is Adaptive-only.
 *
 * The 3 spec §11 fields (target, requiredReasoningAct, answerableQuestion)
 * were added 2026-08-11 to close the gap that audit-phase1.md's spec
 * review found. The Validator's `requiredReasoningActMissing` and
 * `unanswerable` booleans verify these fields are actually executed.
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
  breadth_deficiency: "there is task-relevant factual information, an option, a criterion, or an evidence area the group has not yet covered sufficiently",
  group_preference: "more than one participant has converged on the same preference",
  justification_deficiency: "that preference has not yet been backed by stated reasoning or evidence",
  integration_deficiency: "evidence has been shared but not yet organised or compared across options/criteria",
};

// Per-role required reasoning act (Delibra spec §11's
// "required reasoning act"). The Validator's `requiredReasoningActMissing`
// boolean checks that the Generator actually performed the act listed here.
// These are fixed role constants -- not derived from factors -- because each
// role's job is structurally what it is, not a function of what the
// discussion happens to be missing.
const REQUIRED_REASONING_ACT = Object.freeze({
  expander: "invite_missing_task_relevant_information_or_consideration",
  challenger: "ask_for_evidence_or_justification",
  synthesiser: "request_specific_comparison_or_tradeoff",
});

// Per-role answerable-question template (Delibra spec §11's
// "问题是否可回答" / unanswerable check). Used to seed the Generator's
// question pattern; the Generator still writes the actual wording but
// must produce a question that fits the template's intent (verifiable
// from the public record, points at a specific addressable target).
const ANSWERABLE_QUESTION_TEMPLATE = Object.freeze({
  expander: "What additional task-relevant facts, options, criteria, or evidence should the group consider?",
  challenger: "What evidence or reasoning supports [the stated preference]?",
  synthesiser: "How do [option A] and [option B] compare on [specific criterion]?",
});

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
 * Derive the `target` field of the plan from the role's factors. `target`
 * is the specific message-id, option, or claim the Generator should point
 * at. Per Delibra spec §11 ("target"), each role has a different
 * target-extraction rule:
 *   - expander: the first missing option/criterion (no message_id, since
 *     the target is something that is MISSING; the target label is the
 *     factor's `span` or, if absent, a generic placeholder)
 *   - challenger: the message_id of the participant who stated the
 *     preference being challenged (the group_preference factor's first
 *     message_id is the "ownership" message of the convergence)
 *   - synthesiser: the first message_id cited by the integration_deficiency
 *     factor (the spot of fragmented evidence to organise)
 *
 * Returns either {kind: "message", messageId: "m0"} or
 *         {kind: "missing_label", label: "..."}.
 * Returns null if the role's factors have no usable target (e.g.
 * score-only selection with no verified span).
 */
function deriveTarget(role, relevantFactors) {
  if (relevantFactors.length === 0) return null;

  if (role === "expander") {
    // The "target" of an expander is something MISSING -- no message_id.
    // Use the first factor's span as a placeholder label (if present).
    const f = relevantFactors[0].factor;
    return {
      kind: "missing_label",
      label: f.span ? `under-covered information area evidenced by: "${f.span}"` : "missing task-relevant information, option, criterion, or evidence area",
    };
  }

  if (role === "challenger") {
    // The target is the message that OWNED the stated preference.
    // group_preference factor carries the message_ids where the
    // convergence was expressed; take the first one.
    const prefFactor = relevantFactors.find(({ key }) => key === "group_preference")?.factor;
    const id = prefFactor?.message_ids?.[0];
    if (!id) return null;
    return { kind: "message", messageId: id };
  }

  if (role === "synthesiser") {
    // The target is the first message_id of the fragmented evidence to
    // organise.
    const intFactor = relevantFactors.find(({ key }) => key === "integration_deficiency")?.factor;
    const id = intFactor?.message_ids?.[0];
    if (!id) return null;
    return { kind: "message", messageId: id };
  }

  return null;
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

  const factorEvidenceIds = dedupe(
    relevantFactors.flatMap(({ factor }) => factor.message_ids || [])
  );

  // A synthesis intervention must be allowed to cite at least the public
  // evidence items it is being asked to compare. One factor can carry only
  // one exact span, so EvidenceChecker may retain a single factor message ID
  // even when the detector's validated evidenceRelations correctly identify
  // several attributed-but-not-compared messages. Include those relation IDs
  // for Synthesiser plans; they are still intersected with public eligible IDs.
  const relationEvidenceIds = role === "synthesiser"
    ? (checkedFactors?.evidenceRelations || [])
        .filter((relation) => relation.attributed && !relation.compared && !relation.integrated)
        .map((relation) => relation.messageId)
    : [];
  const evidenceIds = dedupe([...factorEvidenceIds, ...relationEvidenceIds])
    .filter((id) => eligibleSet.size === 0 || eligibleSet.has(id));

  const gap = relevantFactors.length
    ? relevantFactors
        .map(({ key, factor }) => `${GAP_LABEL[key]}${factor.span ? ` (e.g. "${factor.span}")` : ""}`)
        .join("; ")
    : "role selected from checked LLM detector scores; no single verified span available";

  // Intensity: placeholder classification, not calibrated. Halfway between
  // the role's own eligibility threshold and the maximum possible score
  // (1.0) -- a role that only just cleared its bar gets "medium", one that
  // cleared it comfortably gets "high". See IMPLEMENTATION_LOGIC.md.
  const midpoint = typeof threshold === "number" ? threshold + (1 - threshold) / 2 : 0.75;
  const intensity = typeof score === "number" && score >= midpoint ? "high" : "medium";

  return {
    role,
    target: deriveTarget(role, relevantFactors),
    requiredReasoningAct: REQUIRED_REASONING_ACT[role],
    answerableQuestionTemplate: ANSWERABLE_QUESTION_TEMPLATE[role],
    intensity,
    maxSentences: 2,
    evidenceIds,
    gap,
    prohibitions: [...FIXED_PROHIBITIONS],
  };
}
