import { verifySemanticTarget, semanticReferences } from "./AdaptiveEvidence.mjs";
import { GENERATION_ROLES, OPERATION_ROLE, isPublicParticipantMessage, verifiedParticipationTargets } from "./CognitiveOperations.mjs";
import { withMessageIds } from "./prompts/DynamicContext.mjs";
import { AUTOMATIC_MAX_WORDS, SYNTHESISER_MAX_WORDS } from "./prompts/PromptRuntime.mjs";

/** Input/source checks, not an independent proof of semantic correctness.
 * Public-target interpretations remain subject to semantic validation. */
export function preflightPlan(plan, { chat = [], taskGeneralContext = "", activeParticipantNames = [], contextScope = "complete_current_round", interventionHistory = [] } = {}) {
  const publicMessages = withMessageIds(chat).filter(isPublicParticipantMessage);
  const byId = new Map(publicMessages.map(m => [m.messageId, m]));
  const ids = plan?.evidenceIds || [];
  const publicText = [taskGeneralContext, ...publicMessages.map(m => m.text)].join("\n");
  const labels = [...(plan?.target?.optionLabels || []), ...(plan?.target?.criteria || [])];
  const target = plan?.target;
  const quotes = plan?.evidence || [];
  const sourceComplete = ids.length > 0 && ids.every(id => byId.has(id)) && (target?.messageIds || []).length > 0
    && target.messageIds.every(id => ids.includes(id))
    && target.messageIds.every(id => quotes.some(q => q.messageId === id && typeof q.span === "string" && q.span.length > 0 && byId.get(id)?.text?.includes(q.span)));
  let enough = sourceComplete;
  if (["EVIDENCE_CONSOLIDATION", "DISCREPANCY_REPRESENTATION", "CROSS_OPTION_COMPARISON"].includes(plan?.requiredReasoningAct)) enough &&= ids.length >= 2;
  if (plan?.requiredReasoningAct === "CROSS_OPTION_COMPARISON") enough &&= (target?.optionLabels?.length || 0) >= 2 && (target?.criteria?.length || 0) > 0;
  const participant = target?.participantName;
  // 2026-10-21: a participation target must be a roster participant who is
  // quiet under the deterministic QUIET_PARTICIPANT_RULE (a fully silent
  // participant still qualifies, as before).
  const participationValid = plan?.requiredReasoningAct !== "PARTICIPATION_ELICITATION" ||
    (contextScope === "complete_current_round" && activeParticipantNames.includes(participant)
      && verifiedParticipationTargets(publicMessages, activeParticipantNames).includes(participant));
  const targetVerified = !!target?.label && labels.every(label => typeof label === "string" && label.trim() && publicText.toLowerCase().includes(label.toLowerCase())) && participationValid;
  // Repetition uses delivered history only. Missing history never implies uptake.
  const semantic = plan?.semanticReview ? verifySemanticTarget(plan.semanticReview, { chat, references: semanticReferences(interventionHistory, plan.excludedTargets) }) : null;
  const repeated = !semantic && interventionHistory.some(h => h.signature === plan?.signature ||
    h.requiredReasoningAct === plan?.requiredReasoningAct && JSON.stringify([...(h.target?.messageIds || [])].sort()) === JSON.stringify([...(target?.messageIds || [])].sort()));
  const checks = {
    roleOperationMatch: !!plan && OPERATION_ROLE[plan.requiredReasoningAct] === plan.role && GENERATION_ROLES[plan.role] === plan.generationRole && plan.maxWords === (plan.role === "synthesiser" ? SYNTHESISER_MAX_WORDS : AUTOMATIC_MAX_WORDS),
    publicTargetVerified: targetVerified,
    evidenceCoverageVerified: enough,
    // Compiler targets never assert global absence: generation must qualify scope.
    scopePolicySatisfied: ["complete_current_round", "partial_recent_window", "unknown"].includes(contextScope) && participationValid,
    repetitionPolicySatisfied: target?.status !== "addressed" && plan?.historyStatus !== "addressed" && !repeated && semantic?.ok !== false,
  };
  const reasons = ["INPUT_INVALID", "TARGET_UNSUPPORTED", "EVIDENCE_INSUFFICIENT", "SCOPE_INSUFFICIENT", "TARGET_ALREADY_ADDRESSED"];
  const failureReasons = Object.values(checks).flatMap((ok, i) => ok ? [] : [reasons[i]]);
  return { planId: plan?.planId || "invalid", status: failureReasons.length ? "failed" : "passed", checks, contextScope,
    historyStatus: target?.status === "addressed" ? "addressed" : plan?.historyStatus || "history_unavailable", failureReasons };
}

export function isPassingPlanPreflight(result, expected) {
  const keys = ["roleOperationMatch", "publicTargetVerified", "evidenceCoverageVerified", "scopePolicySatisfied", "repetitionPolicySatisfied"];
  return result?.status === "passed" && result.planId === expected.planId
    && result.contextScope === expected.contextScope && result.historyStatus === expected.historyStatus
    && Array.isArray(result.failureReasons) && result.failureReasons.length === 0
    && result.checks && Object.keys(result.checks).length === keys.length && keys.every(key => result.checks[key] === true);
}
