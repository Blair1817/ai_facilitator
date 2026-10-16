import { COGNITIVE_NEEDS, GENERATION_ROLES, OPERATION_QUESTIONS } from "./CognitiveOperations.mjs";

const factorKeys = { expander: ["breadth_deficiency"], challenger: ["justification_deficiency", "unresolved_counterevidence", "claim_evidence_linkage"], synthesiser: ["integration_deficiency"] };
const dedupe = xs => [...new Set(xs)];

/** Compile a fixed-role operation from quote-verified public observations.
 * Legacy factors are replayable; new Assessor observations supply specific targets.
 * Neither compilation nor the Generator changes Controller role/thresholds. */
export function compilePlan(role, checkedFactors, { score, threshold, eligibleMessageIds = [], interventionHistory = [] } = {}) {
  if (!factorKeys[role]) throw new Error(`compilePlan(): unknown role "${role}"`);
  const factors = factorKeys[role].map(key => ({ key, factor: checkedFactors?.[key] })).filter(x => x.factor?.status === "present");
  const observations = (checkedFactors?.cognitiveTargets || []).filter(t => COGNITIVE_NEEDS[t.need]?.[0] === role);
  const observation = observations.find(t => t.status === "open") ?? observations[0];
  const factorIds = factors.flatMap(x => x.factor.message_ids || []);
  const relationIds = role === "synthesiser" ? (checkedFactors?.evidenceRelations || []).filter(r => r.attributed && !r.compared && !r.integrated).map(r => r.messageId) : [];
  const ids = dedupe(observation?.messageIds || [...factorIds, ...relationIds]).filter(id => eligibleMessageIds.includes(id));
  const fallbackActs = { expander: "CONCRETE_EVIDENCE_ELICITATION", challenger: factors[0]?.key === "unresolved_counterevidence" ? "COUNTEREVIDENCE_EXAMINATION" : factors[0]?.key === "claim_evidence_linkage" ? "CLAIM_EVIDENCE_LINKAGE" : "EVIDENCE_AUDIT", synthesiser: "EVIDENCE_CONSOLIDATION" };
  const act = observation ? COGNITIVE_NEEDS[observation.need][1] : fallbackActs[role];
  const target = {
    kind: observation?.need === "participation_gap" ? "participant" : role === "expander" ? "coverage" : role === "challenger" ? "claim" : "evidence_set",
    label: observation?.label || (factors[0]?.factor.span ? `Public contribution: ${factors[0].factor.span}` : "Public target unavailable"),
    messageIds: ids, optionLabels: observation?.optionLabels || [], criteria: observation?.criteria || [],
    ...(observation?.participantName ? { participantName: observation.participantName } : {}),
    status: observation?.status || "open",
  };
  const signature = JSON.stringify([act, [...ids].sort(), target.label]);
  const previous = interventionHistory.find(h => h.signature === signature);
  const planId = `${role}:${act}:${ids.join("-") || "no-evidence"}`;
  return {
    planId, role, generationRole: GENERATION_ROLES[role], target,
    requiredReasoningAct: act, answerableQuestionTemplate: OPERATION_QUESTIONS[act], evidenceIds: ids,
    evidence: observation?.evidence || factors.flatMap(x => x.factor.evidence || x.factor.message_ids.map(messageId => ({ messageId, span: x.factor.span }))),
    expectedUptake: role === "expander" ? "Relevant concrete information is shared publicly" : role === "challenger" ? "Participants examine the target reasoning" : "Participants use or clarify the represented public evidence",
    historyStatus: target.status === "addressed" ? "addressed" : previous ? "awaiting_response" : interventionHistory.length ? "not_previously_targeted" : "history_unavailable",
    signature, intensity: typeof score === "number" && score >= (threshold ?? 0.6) + (1 - (threshold ?? 0.6)) / 2 ? "high" : "medium",
    maxWords: 50, maxSentences: 3, gap: target.label,
    prohibitions: ["MUST_NOT_RECOMMEND_OR_RANK_OPTION", "MUST_NOT_REVEAL_PRIVATE_PROFILE_INFORMATION", "MUST_NOT_CLAIM_TO_KNOW_CORRECT_ANSWER", "MUST_NOT_EXCEED_THREE_SENTENCES"],
  };
}
