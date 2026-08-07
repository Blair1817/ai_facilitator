/**
 * EvidenceChecker.js
 *
 * Architecture doc Step 6. Deterministic verification of SemanticAssessor.js's
 * (Step 5) raw LLM output -- NO LLM call in this file. Implements the 4
 * rules from the Implementation Brief:
 *
 *   Rule 1: group_preference only counts as "present" if it was expressed
 *           by more than one participant -- a single strongly-worded
 *           opinion is not a group preference.
 *   Rule 2: every span the Assessor returned must actually occur, verbatim,
 *           in a message it cited via message_ids -- a fabricated or
 *           paraphrased span invalidates that factor.
 *   Rule 3: when the Assessor's judgement conflicts sharply with the
 *           feature-only signal for the same role (i.e. the role never
 *           even cleared the loose Candidate Gate bar), the factor's
 *           strength is discounted rather than trusted outright.
 *   Rule 4: when self_correction is present, the other factors' strengths
 *           are discounted proportionally (participants already doing the
 *           work an intervention would ask for reduces confidence that an
 *           intervention is still needed).
 *
 * Pure functions only -- no fetch, no Empirica import, no dotenv. Safe to
 * unit test directly, same convention as GeneratorContract.mjs/
 * DynamicContext.mjs/utils.js.
 */

import { withMessageIds } from "./prompts/DynamicContext.mjs";
import { getCandidateRoles } from "./utils.js";

export const FACTOR_KEYS = [
  "breadth_deficiency",
  "group_preference",
  "justification_deficiency",
  "integration_deficiency",
  "self_correction",
];

// Which Candidate-Gate role (utils.js getCandidateRoles' output) each
// factor is tied to, for Rule 3's feature-conflict check. self_correction
// has no associated role -- it is a global signal, exempt from Rule 3.
const FACTOR_ROLE = {
  breadth_deficiency: "expander",
  group_preference: "challenger",
  justification_deficiency: "challenger",
  integration_deficiency: "synthesiser",
};

const EMPTY_FACTOR = Object.freeze({ status: "absent", strength: 0, message_ids: [], span: "" });

function asFactor(raw) {
  if (!raw || typeof raw !== "object") return { ...EMPTY_FACTOR };
  return {
    status: raw.status === "present" || raw.status === "uncertain" ? raw.status : "absent",
    strength: typeof raw.strength === "number" ? raw.strength : 0,
    message_ids: Array.isArray(raw.message_ids) ? raw.message_ids : [],
    span: typeof raw.span === "string" ? raw.span : "",
  };
}

function downgrade(factor, reason) {
  return { status: "uncertain", strength: 0, message_ids: [], span: "", downgradedReason: reason };
}

/**
 * Rule 2: span must be an exact substring of at least one cited message's
 * actual text. Rule 1: for group_preference specifically, the cited
 * message_ids (after Rule 2 has already thrown out any that don't
 * genuinely support the span) must come from more than one distinct
 * sender, or the factor is downgraded regardless of what the Assessor
 * claimed.
 */
function verifySpanAndParticipants(key, factor, messageById) {
  if (factor.status !== "present") return factor;

  if (!factor.span || factor.message_ids.length === 0) {
    return downgrade(factor, "MISSING_SPAN_OR_MESSAGE_IDS");
  }

  const supportingMessages = factor.message_ids
    .map((id) => messageById.get(id))
    .filter((m) => m && typeof m.text === "string" && m.text.includes(factor.span));

  if (supportingMessages.length === 0) {
    return downgrade(factor, "SPAN_NOT_FOUND_IN_CITED_MESSAGES");
  }

  // Rule 1: group_preference requires convergence across people, not one
  // person's message cited twice.
  if (key === "group_preference") {
    const distinctSenders = new Set(supportingMessages.map((m) => m.sender?.id));
    if (distinctSenders.size < 2) {
      return downgrade(factor, "GROUP_PREFERENCE_SINGLE_PARTICIPANT_ONLY");
    }
  }

  // Keep only the message_ids that actually held up under verification --
  // a factor's evidence list should never contain an unverified ID even if
  // the overall status survives.
  return { ...factor, message_ids: supportingMessages.map((m) => m.messageId) };
}

/**
 * Rule 3: if the feature-only Candidate Gate never even flagged this
 * factor's role as a candidate (i.e. the raw feature scores gave no
 * support at all), an LLM claim of "present" is in real conflict with the
 * cheap, high-recall signal that is supposed to catch most true cases --
 * halve the strength rather than either ignoring the conflict or
 * discarding the LLM's judgement outright.
 */
function applyFeatureConflictDiscount(checked, features) {
  if (!features) return checked;
  const candidateRoles = getCandidateRoles(features);

  const result = { ...checked };
  for (const key of Object.keys(FACTOR_ROLE)) {
    const factor = result[key];
    if (factor.status !== "present") continue;
    const role = FACTOR_ROLE[key];
    if (!candidateRoles.includes(role)) {
      result[key] = {
        ...factor,
        strength: factor.strength * 0.5,
        conflictDiscount: "FEATURE_CANDIDATE_GATE_DID_NOT_FLAG_THIS_ROLE",
      };
    }
  }
  return result;
}

/**
 * Rule 4: self_correction present discounts the other (deficiency) factors
 * proportionally to its own strength. self_correction itself is never
 * discounted by this rule.
 */
function applySelfCorrectionDiscount(checked) {
  const selfCorrection = checked.self_correction;
  if (!selfCorrection || selfCorrection.status !== "present" || selfCorrection.strength <= 0) {
    return checked;
  }
  const discountFactor = 1 - 0.5 * selfCorrection.strength; // strength in [0,1] -> multiplier in [0.5,1]
  const result = { ...checked };
  for (const key of Object.keys(FACTOR_ROLE)) {
    const factor = result[key];
    if (factor.status !== "present") continue;
    result[key] = { ...factor, strength: factor.strength * discountFactor, selfCorrectionDiscounted: true };
  }
  return result;
}

/**
 * Main entry point. `rawFactors` is SemanticAssessor.js's output (already
 * schema-validated by that module). `chat` is the same raw Empirica chat
 * array the Assessor saw (message IDs are re-derived here with the same
 * withMessageIds() scheme, not trusted from the LLM). `features` is this
 * checkpoint's feature-score object (for Rule 3).
 */
export function checkEvidence(rawFactors, { chat, features } = {}) {
  const chatWithIds = withMessageIds(chat || []);
  const messageById = new Map(chatWithIds.map((m) => [m.messageId, m]));

  let checked = {};
  for (const key of FACTOR_KEYS) {
    checked[key] = verifySpanAndParticipants(key, asFactor(rawFactors?.[key]), messageById);
  }

  checked = applyFeatureConflictDiscount(checked, features);
  checked = applySelfCorrectionDiscount(checked);

  return checked;
}
