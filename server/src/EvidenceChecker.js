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
 *   Rule 3: when self_correction is present, the other factors' strengths
 *           are discounted proportionally (participants already doing the
 *           work an intervention would ask for reduces confidence that an
 *           intervention is still needed).
 *
 * Pure functions only -- no fetch, no Empirica import, no dotenv. Safe to
 * unit test directly, same convention as GeneratorContract.mjs/
 * DynamicContext.mjs/utils.js.
 */

import { COGNITIVE_NEEDS, NEED_CATEGORIES, isPublicParticipantMessage, countPublicMessagesByName, quietParticipants, verifiedParticipationTargets } from "./CognitiveOperations.mjs";
import { withMessageIds } from "./prompts/DynamicContext.mjs";

// v2 design (Phase 4): expanded to the 8 factors listed in the
// architecture doc §2 节点 6 ("覆盖: breadth deficiency; group
// preference/closure; justification deficiency; integration/comparison
// deficiency; unresolved counterevidence; claim–evidence/option/
// criterion linkage; self-correction; reasoning uptake"). The 3 new
// factors (unresolved_counterevidence, claim_evidence_linkage,
// reasoning_uptake) are validated by the same 4 rules as the original
// 5, and routed to the role that most naturally consumes them in the
// Controller (see FACTOR_ROLE below).
export const FACTOR_KEYS = [
  "breadth_deficiency",
  "group_preference",
  "justification_deficiency",
  "integration_deficiency",
  "unresolved_counterevidence",
  "claim_evidence_linkage",
  "self_correction",
  "reasoning_uptake",
];

// Deficiency factors discounted when the detector also finds that the group
// is already self-correcting. self_correction and reasoning_uptake are global
// signals and are not themselves reduced by this rule.
const DEFICIENCY_FACTOR_KEYS = [
  "breadth_deficiency", "group_preference", "justification_deficiency",
  "integration_deficiency", "unresolved_counterevidence", "claim_evidence_linkage",
];

const EMPTY_FACTOR = Object.freeze({ status: "absent", strength: 0, message_ids: [], span: "" });

function asFactor(raw) {
  if (!raw || typeof raw !== "object") return { ...EMPTY_FACTOR };
  return {
    status: raw.status === "present" || raw.status === "uncertain" ? raw.status : "absent",
    strength: typeof raw.strength === "number" ? raw.strength : 0,
    message_ids: Array.isArray(raw.message_ids) ? raw.message_ids : [],
    span: typeof raw.span === "string" ? raw.span : "",
    ...(Array.isArray(raw.evidence) ? { evidence: raw.evidence } : {}),
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

  if (Array.isArray(factor.evidence)) {
    const ids = new Set(factor.message_ids);
    const quotes = factor.evidence;
    if (!ids.size || !quotes.length || quotes.some(q => !ids.has(q.messageId) || !q.span || !messageById.get(q.messageId)?.text?.includes(q.span))
      || [...ids].some(id => !quotes.some(q => q.messageId === id))) return downgrade(factor, "INVALID_PER_MESSAGE_EVIDENCE");
    if (key === "group_preference" && new Set([...ids].map(id => messageById.get(id)?.sender?.id)).size < 2)
      return downgrade(factor, "GROUP_PREFERENCE_SINGLE_PARTICIPANT_ONLY");
    if (key === "integration_deficiency" && (ids.size < 3 || new Set([...ids].map(id => messageById.get(id)?.sender?.id)).size < 2))
      return downgrade(factor, "INSUFFICIENT_DISTRIBUTED_EVIDENCE");
    return { ...factor, span: quotes[0].span };
  }
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
 * Rule 3: self_correction present discounts the other (deficiency) factors
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
  for (const key of DEFICIENCY_FACTOR_KEYS) {
    const factor = result[key];
    if (factor.status !== "present") continue;
    result[key] = { ...factor, strength: factor.strength * discountFactor, selfCorrectionDiscounted: true };
  }
  return result;
}

/**
 * Delibra spec §3 Node 3 (2026-08-11): per-evidence-relations tracking.
 * The Assessor's `evidenceRelations` field is an array of
 * `{messageId, mentioned, attributed, evaluated, compared, countered,
 * integrated}` records, one per participant message whose evidence is
 * in a non-trivial state. This function validates that:
 *   (a) each `messageId` exists in the chat (catches typos / fabricated
 *       IDs / off-by-one — same defensive rule as Rule 2 above);
 *   (b) the 6 booleans are all actually booleans (catches the LLM
 *       dropping a field or returning a string);
 *   (c) there are no duplicate `messageId` entries (one row per
 *       participant message — duplicates would inflate state);
 *   (d) every message the Assessor named has a 6-boolean vector (not
 *       a partial one) — partial records would make "no uptake" /
 *       "surface uptake" / "reasoning uptake" classification
 *       unreliable downstream.
 *
 * Returns the cleaned, validated array. Drops records that fail any
 * check rather than throwing — the Assessor's main 8-factor output
 * is independent and can still be useful even if the relations
 * tracking is partial.
 */
function checkEvidenceRelations(rawRelations, messageById) {
  if (!Array.isArray(rawRelations)) return [];
  const seenMessageIds = new Set();
  const out = [];
  for (const rel of rawRelations) {
    if (!rel || typeof rel !== "object") continue;
    const id = rel.messageId;
    if (typeof id !== "string" || !messageById.has(id)) continue;     // (a)
    if (seenMessageIds.has(id)) continue;                              // (c)
    const booleans = ["mentioned", "attributed", "evaluated", "compared", "countered", "integrated"];
    const validated = { messageId: id };
    let allPresent = true;
    for (const b of booleans) {
      if (typeof rel[b] !== "boolean") { allPresent = false; break; } // (b) and (d)
      validated[b] = rel[b];
    }
    if (!allPresent) continue;
    seenMessageIds.add(id);
    out.push(validated);
  }
  return out;
}

/**
 * Main entry point. `rawFactors` is SemanticAssessor.js's output (already
 * schema-validated by that module). `chat` is the same raw Empirica chat
 * array the Assessor saw (message IDs are re-derived here with the same
 * withMessageIds() scheme, not trusted from the LLM).
 *
 * 2026-08-11: also returns `evidenceRelations` (the cleaned, validated
 * per-evidence-relations array) on the result, alongside the 8 checked
 * factors. The Controller can use it to drive role decisions (e.g.
 * "any message is mentioned but not compared" → Synthesiser). Existing
 * callers that only read `result[<factorKey>]` are unaffected.
 */
export function checkEvidence(rawFactors, { chat } = {}) {
  const chatWithIds = withMessageIds(chat || []);
  const messageById = new Map(chatWithIds.filter(isPublicParticipantMessage).map((m) => [m.messageId, m]));

  let checked = {};
  for (const key of FACTOR_KEYS) {
    checked[key] = verifySpanAndParticipants(key, asFactor(rawFactors?.[key]), messageById);
  }

  checked = applySelfCorrectionDiscount(checked);

  checked.cognitiveTargets = (Array.isArray(rawFactors?.cognitiveTargets) ? rawFactors.cognitiveTargets : []).filter(target => {
    const definition = COGNITIVE_NEEDS[target?.need];
    if (!definition || checked[definition[2]]?.status !== "present") return false;
    const ids = new Set(target.messageIds || []);
    const evidence = target.evidence || [];
    return ids.size > 0 && evidence.length > 0 && [...ids].every(id => messageById.has(id) && evidence.some(q => q.messageId === id))
      && evidence.every(q => ids.has(q.messageId) && typeof q.span === "string" && q.span.length > 0 && messageById.get(q.messageId)?.text?.includes(q.span));
  });
  checked.evidenceRelations = checkEvidenceRelations(rawFactors?.evidenceRelations, messageById);

  return checked;
}


// ── Categorical need detector check (2026-10-21) ───────────────────────────
//
// Live Adaptive path. Deterministically verifies the categorical detector
// output (SemanticAssessor.js with the categorical assessor.md) and returns:
//   { need, role, operation, target, downgradedReason, rawNeed,
//     participationCounts, quietParticipants, checkedFactors }
// Any failed rule downgrades the result to need "NONE" (role null), which
// the gate routes to the Static policy. `checkedFactors` is a compatibility
// view in the shape PolicyCompiler.compilePlan() already consumes, so the
// plan/preflight/Generator/Validator path is unchanged.
//
// Rules:
//   N1  need must be one of NEED_CATEGORIES and the operation must belong
//       to that need's role.
//   N2  every cited messageId is a real public participant message; every
//       cited message has a quote; every quote is an exact substring of its
//       own message.
//   N3  SCRUTINIZE and INTEGRATE cite at least two distinct participants;
//       fragmented_evidence additionally cites at least three messages.
//   N4  participation_gap names a roster participant who is quiet under the
//       deterministic QUIET_PARTICIPANT_RULE.
export function checkNeedAssessment(raw, { chat, activeParticipantNames = [], scheduling = null } = {}) {
  const chatWithIds = withMessageIds(chat || []);
  const publicMessages = chatWithIds.filter(isPublicParticipantMessage);
  const messageById = new Map(publicMessages.map((m) => [m.messageId, m]));
  const participationCounts = countPublicMessagesByName(publicMessages, activeParticipantNames);
  const quiet = quietParticipants(participationCounts);
  const base = { rawNeed: raw?.need ?? null, participationCounts, quietParticipants: quiet, scheduling };
  const none = (downgradedReason) => ({
    ...base, need: "NONE", role: null, operation: null, target: null, downgradedReason, checkedFactors: null,
  });

  // N1
  if (!raw || typeof raw !== "object" || !Object.prototype.hasOwnProperty.call(NEED_CATEGORIES, raw.need)) {
    return none("INVALID_NEED");
  }
  // A deliberate pause must survive NONE -> Static fallback routing. The
  // assessor judges whether summarising is still underway; code verifies the
  // cited participant text, never infers that state from audit prose/keywords.
  if (raw.defer != null) {
    if (raw.need !== "NONE" || raw.operation !== null || raw.target !== null
      || raw.defer.reason !== "participant_summary_in_progress") return none("INVALID_DEFERRAL");
    const evidence = raw.defer.evidence;
    if (!Array.isArray(evidence) || !evidence.length
      || evidence.some(q => typeof q?.span !== "string" || !q.span.trim()
        || !messageById.get(q.messageId)?.text?.includes(q.span))) return none("INVALID_DEFERRAL_EVIDENCE");
    return { ...none(null), defer: {
      reason: raw.defer.reason,
      evidence: evidence.map(q => ({ messageId: q.messageId, span: q.span })),
    } };
  }
  if (raw.need === "NONE") return none(null);
  const role = NEED_CATEGORIES[raw.need];
  const definition = COGNITIVE_NEEDS[raw.operation];
  if (!definition || definition[0] !== role) return none("OPERATION_NEED_MISMATCH");

  // N2
  const target = raw.target;
  if (!target || typeof target !== "object") return none("MISSING_TARGET");
  const ids = [...new Set(Array.isArray(target.messageIds) ? target.messageIds : [])];
  const evidence = Array.isArray(target.evidence) ? target.evidence : [];
  const quotesValid = ids.length > 0 && evidence.length > 0
    && ids.every((id) => messageById.has(id) && evidence.some((q) => q?.messageId === id))
    && evidence.every((q) => ids.includes(q?.messageId) && typeof q.span === "string" && q.span.length > 0
      && typeof messageById.get(q.messageId)?.text === "string" && messageById.get(q.messageId).text.includes(q.span));
  if (!quotesValid) return none("INVALID_EVIDENCE");

  // N3
  const authors = new Set(ids.map((id) => messageById.get(id)?.sender?.id ?? messageById.get(id)?.sender?.name));
  if ((role === "challenger" || role === "synthesiser") && authors.size < 2) return none("INSUFFICIENT_DISTINCT_PARTICIPANTS");
  if (raw.operation === "fragmented_evidence" && ids.length < 3) return none("INSUFFICIENT_DISTRIBUTED_EVIDENCE");

  // N4
  if (raw.operation === "participation_gap") {
    const name = target.participantName;
    // 2026-10-26: quiet overall OR silent across the recent window (code-verified).
    if (typeof name !== "string" || !activeParticipantNames.includes(name)
      || !verifiedParticipationTargets(publicMessages, activeParticipantNames).includes(name)) {
      return none("PARTICIPANT_NOT_VERIFIED_QUIET");
    }
  }

  const checkedTarget = {
    need: raw.operation,
    label: String(target.label || ""),
    messageIds: ids,
    evidence: evidence.map((q) => ({ messageId: q.messageId, span: q.span })),
    optionLabels: Array.isArray(target.optionLabels) ? target.optionLabels : [],
    criteria: Array.isArray(target.criteria) ? target.criteria : [],
    ...(raw.operation === "participation_gap" ? { participantName: target.participantName } : {}),
    status: "open",
  };
  const factorKey = definition[2];
  const checkedFactors = {
    [factorKey]: { status: "present", strength: 1, message_ids: ids, span: checkedTarget.evidence[0].span, evidence: checkedTarget.evidence },
    cognitiveTargets: [checkedTarget],
    evidenceRelations: [],
  };
  return { ...base, need: raw.need, role, operation: raw.operation, target: checkedTarget, downgradedReason: null, checkedFactors };
}
