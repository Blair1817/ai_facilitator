import { withMessageIds } from "./prompts/DynamicContext.mjs";
import { isPublicParticipantMessage } from "./CognitiveOperations.mjs";

/** Detector quotes establish the need, not a ceiling on summary coverage. */
export function completeSynthesisPlan(plan, { chat, optionLabels = [] }) {
  if (plan?.role !== "synthesiser") return plan;
  const sources = withMessageIds(chat).filter(isPublicParticipantMessage)
    .filter(m => typeof m.text === "string" && m.text.trim());
  const focused = plan.requiredReasoningAct === "DISCREPANCY_REPRESENTATION";
  return { ...plan, maxWords: null,
    target: { ...plan.target, optionLabels: focused ? plan.target.optionLabels : optionLabels,
      messageIds: sources.map(m => m.messageId) },
    evidenceIds: sources.map(m => m.messageId),
    evidence: sources.map(m => ({ messageId: m.messageId, span: m.text })),
    synthesisCoverage: { scope: focused ? "complete_target_discrepancy" : "all_public_task_information_this_round",
      sourceMessageIds: sources.map(m => m.messageId) },
  };
}

// A transport budget, not a visible-word target. Allow JSON, attribution and
// reasoning overhead; a provider-truncated result is never publishable.
export function synthesisOutputTokens(chat, configured = 1000) {
  const chars = withMessageIds(chat).filter(isPublicParticipantMessage).reduce((n, m) => n + String(m.text || "").length, 0);
  return Math.max(configured, 8192, Math.ceil(chars / 2) + 4096);
}

export const SYNTHESIS_COVERAGE_INSTRUCTION = `
## REQUIRED SYNTHESIS COVERAGE AUDIT
For INFORMATION_SYNTHESISER with INTERVENTION_PLAN.synthesisCoverage, return the
thirteen failure booleans PLUS synthesisCoverage. It is an array with exactly
one entry per synthesisCoverage.sourceMessageIds, never a sampled subset.
Each entry is {messageId, status, reason, mappings}. status is covered,
no_task_information, out_of_scope, or missing. mappings is an array of
{sourceQuote, summaryQuote}, each an exact nonempty substring of the source
message and CANDIDATE.message respectively. For covered, map ALL distinct task
facts, concerns, qualifications and relevant reasoning in that source, not just
one convenient fact. A multi-fact source needs all its distinct content covered;
faithful merging and deduplication are allowed, loss of meaning is not.
Use missing for any omitted or distorted relevant point, number, unit, scope,
uncertainty, correction, unresolved concern or either side of a discrepancy.
no_task_information is only for greetings, logistics or genuinely non-task text;
explain why, never use it to discard an inconvenient task point or preference.
out_of_scope is allowed ONLY for a focused discrepancy and must explain why the
message is unrelated to that specific discrepancy. Round-wide synthesis covers
ALL public task information about ALL alternatives; detector quotes, repeated
mentions, earlier summaries and word counts are no excuse to omit facts. A
superseded report must be represented as corrected, not as still valid; preserve
an unresolved disagreement. Set requiredReasoningActMissing true if anything is
missing. Inspect the full transcript even if the candidate cites every source.
Complete coverage comes first; concision means removing repetition and filler,
not facts. There is no Synthesiser word ceiling. The runtime verifies the ledger
IDs and exact quote mappings; your semantic judgement must check completeness.
`;

export function synthesisCoverageSchema() {
  return { type: "array", items: { type: "object", additionalProperties: false,
    properties: { messageId: { type: "string" }, status: { type: "string", enum: ["covered", "no_task_information", "out_of_scope", "missing"] },
      reason: { type: "string" }, mappings: { type: "array", items: { type: "object", additionalProperties: false,
        properties: { sourceQuote: { type: "string", minLength: 1 }, summaryQuote: { type: "string", minLength: 1 } },
        required: ["sourceQuote", "summaryQuote"] } } }, required: ["messageId", "status", "reason", "mappings"] } };
}

/** Source coverage is structural; the auditor must also assess every fact's
 * meaning. A fully cited message alone never proves complete factual coverage. */
export function checkSynthesisCoverage(ledger, { chat, candidate, plan }) {
  const ids = plan.synthesisCoverage.sourceMessageIds;
  const byId = new Map(withMessageIds(chat).filter(isPublicParticipantMessage).map(m => [m.messageId, m]));
  if (!Array.isArray(ledger) || ledger.some(e => !e || typeof e !== "object") || ledger.length !== ids.length || new Set(ledger.map(e => e.messageId)).size !== ids.length
    || ledger.some(e => !ids.includes(e.messageId))) return { passed: false, reason: "coverage_ledger_incomplete", missingIds: ids };
  const missingIds = [];
  for (const entry of ledger) {
    const source = byId.get(entry.messageId);
    const mappings = entry.mappings;
    const covered = entry.status === "covered" && source && Array.isArray(mappings) && mappings.length > 0
      && mappings.every(m => typeof m?.sourceQuote === "string" && m.sourceQuote.length > 0 && source.text.includes(m.sourceQuote)
        && typeof m.summaryQuote === "string" && m.summaryQuote.length > 0 && candidate.message.includes(m.summaryQuote))
      && candidate.groundingMessageIds.includes(entry.messageId);
    const excluded = ["no_task_information", "out_of_scope"].includes(entry.status) && typeof entry.reason === "string" && entry.reason.trim()
      && Array.isArray(mappings) && mappings.length === 0
      && (entry.status !== "out_of_scope" || plan.synthesisCoverage.scope === "complete_target_discrepancy");
    if (!covered && !excluded) missingIds.push(entry.messageId);
  }
  return { passed: !missingIds.length, reason: missingIds.length ? "coverage_incomplete_or_invalid" : "coverage_audited", missingIds };
}
