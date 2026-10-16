// Public, observable needs -> fixed cognitive operations. No lexical scoring.
export const COGNITIVE_NEEDS = Object.freeze({
  coverage_gap: ["expander", "COVERAGE_GAP_ELICITATION", "breadth_deficiency"],
  vague_information: ["expander", "CONCRETE_EVIDENCE_ELICITATION", "breadth_deficiency"],
  participation_gap: ["expander", "PARTICIPATION_ELICITATION", "breadth_deficiency"],
  unsupported_claim: ["challenger", "EVIDENCE_AUDIT", "justification_deficiency"],
  unclear_assumption: ["challenger", "ASSUMPTION_CLARIFICATION", "justification_deficiency"],
  unresolved_concern: ["challenger", "COUNTEREVIDENCE_EXAMINATION", "unresolved_counterevidence"],
  unclear_link: ["challenger", "CLAIM_EVIDENCE_LINKAGE", "claim_evidence_linkage"],
  fragmented_evidence: ["synthesiser", "EVIDENCE_CONSOLIDATION", "integration_deficiency"],
  cross_option_evidence: ["synthesiser", "CROSS_OPTION_COMPARISON", "integration_deficiency"],
  public_discrepancy: ["synthesiser", "DISCREPANCY_REPRESENTATION", "integration_deficiency"],
});
export const GENERATION_ROLES = Object.freeze({ expander: "INFORMATION_EXPANDER", challenger: "EVIDENCE_CHALLENGER", synthesiser: "INFORMATION_SYNTHESISER" });
export const OPERATION_ROLE = Object.freeze(Object.fromEntries(Object.values(COGNITIVE_NEEDS).map(([role, act]) => [act, role])));
export const OPERATION_QUESTIONS = Object.freeze({
  COVERAGE_GAP_ELICITATION: "What further task information can participants contribute about this publicly established topic?",
  CONCRETE_EVIDENCE_ELICITATION: "What concrete task facts can participants share about this public topic?",
  PARTICIPATION_ELICITATION: "Is there relevant task information you would like to share?",
  EVIDENCE_AUDIT: "Which task facts support this public claim?",
  ASSUMPTION_CLARIFICATION: "What would need to hold for this public reasoning step to follow?",
  COUNTEREVIDENCE_EXAMINATION: "How does this publicly reported concern affect the reasoning behind the claim?",
  CLAIM_EVIDENCE_LINKAGE: "How does this public fact support the stated conclusion?",
  EVIDENCE_CONSOLIDATION: "Provide a grounded organisation of the cited contributions; a question is optional.",
  CROSS_OPTION_COMPARISON: "Represent the reported information under the established criteria, preserving source units and scope.",
  DISCREPANCY_REPRESENTATION: "Represent each public report with its source and scope, without resolving the difference.",
});
export function isPublicParticipantMessage(message) {
  return message?.sender?.id !== "ai" && message?.sender?.id !== "system"
    && !["system", "facilitator", "timer_reminder"].includes(message?.speakerType)
    && !["system", "facilitator", "icebreaker", "timer_reminder"].includes(message?.messageType);
}
