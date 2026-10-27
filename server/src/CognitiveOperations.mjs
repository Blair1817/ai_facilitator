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
  EVIDENCE_AUDIT: "Ask exactly one question: for a public option preference, ask for the strongest point anyone has already seen for the other established options; for an unsupported claim without a choice preference, ask what points participants have already seen, if any, support that specific claim. Do not infer a preference or ask for proof of an ordinary reported task fact.",
  ASSUMPTION_CLARIFICATION: "What would need to hold for this public reasoning step to follow?",
  COUNTEREVIDENCE_EXAMINATION: "How does this publicly reported concern affect the reasoning behind the claim?",
  CLAIM_EVIDENCE_LINKAGE: "How does this public fact support the stated conclusion?",
  EVIDENCE_CONSOLIDATION: "Provide a grounded organisation of the cited contributions, then ask one answerable weighing question.",
  CROSS_OPTION_COMPARISON: "Represent the reported information under the established criteria, preserving source units and scope, then ask one weighing question.",
  DISCREPANCY_REPRESENTATION: "Represent each public report with its source and scope without resolving the difference, then ask one clarification question.",
});
export function isPublicParticipantMessage(message) {
  return message?.sender?.id !== "ai" && message?.sender?.id !== "system"
    && !["system", "facilitator", "timer_reminder"].includes(message?.speakerType)
    && !["system", "facilitator", "icebreaker", "timer_reminder"].includes(message?.messageType);
}

// ── Categorical need detector (2026-10-21) ──────────────────────────────────
// The Adaptive detector returns exactly ONE of these four states. Each
// non-NONE state maps to one existing Specialist role; NONE (and any need
// that fails deterministic evidence checking) routes to the Static policy.
export const NEED_CATEGORIES = Object.freeze({
  ELICIT: "expander",
  SCRUTINIZE: "challenger",
  INTEGRATE: "synthesiser",
  NONE: null,
});

// Deterministic participation rule (no LLM). A roster participant is "quiet"
// when (a) they have posted nothing while someone else has posted, or
// (b) the others average at least `minOthersMean` messages and this person
// has posted fewer than `maxShareOfOthersMean` of that average.
export const QUIET_PARTICIPANT_RULE = Object.freeze({ maxShareOfOthersMean: 0.5, minOthersMean: 2 });

/** Public participant message count per roster name (roster names only). */
export function countPublicMessagesByName(chat, rosterNames = []) {
  const counts = Object.fromEntries(
    (Array.isArray(rosterNames) ? rosterNames : [])
      .filter((name) => typeof name === "string" && name.trim())
      .map((name) => [name, 0]),
  );
  for (const message of Array.isArray(chat) ? chat : []) {
    if (!isPublicParticipantMessage(message)) continue;
    const name = message?.sender?.name;
    if (typeof name === "string" && Object.prototype.hasOwnProperty.call(counts, name)) counts[name] += 1;
  }
  return counts;
}

/** Names that satisfy QUIET_PARTICIPANT_RULE, in roster order. */
export function quietParticipants(counts, rule = QUIET_PARTICIPANT_RULE) {
  const entries = Object.entries(counts || {});
  if (entries.length < 2) return [];
  return entries.filter(([name, count]) => {
    const others = entries.filter(([other]) => other !== name).map(([, c]) => c);
    const othersTotal = others.reduce((sum, c) => sum + c, 0);
    const othersMean = othersTotal / others.length;
    if (count === 0 && othersTotal > 0) return true;
    return othersMean >= rule.minOthersMean && count < rule.maxShareOfOthersMean * othersMean;
  }).map(([name]) => name);
}

// ── Participation targets and option coverage (2026-10-26) ─────────────────
// Silence hard rule: a roster participant with no public message among the
// last SILENCE_WINDOW public participant messages (two 6-message checkpoint
// intervals). Evaluated only when at least SILENCE_WINDOW messages exist.
export const SILENCE_WINDOW = 12;
// Per participant and round: at most this many participation invitations, and
// none within SILENCE_WINDOW human messages of the previous invitation.
export const PARTICIPATION_INVITE_CAP = 2;

/** Roster names with zero messages among the last `window` public participant messages. */
export function silentInWindow(chat, rosterNames = [], window = SILENCE_WINDOW) {
  const messages = (Array.isArray(chat) ? chat : []).filter(isPublicParticipantMessage);
  if (messages.length < window) return [];
  const recent = new Set(messages.slice(-window).map((m) => m?.sender?.name));
  return (Array.isArray(rosterNames) ? rosterNames : []).filter((name) => typeof name === "string" && name.trim() && !recent.has(name));
}

/** Code-verified participation targets: quiet overall OR silent in the recent window. */
export function verifiedParticipationTargets(chat, rosterNames = []) {
  const quiet = quietParticipants(countPublicMessagesByName(chat, rosterNames));
  return [...new Set([...quiet, ...silentInWindow(chat, rosterNames)])];
}

/** Number of public participant messages mentioning each option label (case-insensitive). */
export function countOptionMentions(chat, optionLabels = []) {
  const messages = (Array.isArray(chat) ? chat : []).filter(isPublicParticipantMessage);
  return Object.fromEntries((Array.isArray(optionLabels) ? optionLabels : [])
    .filter((label) => typeof label === "string" && label.trim())
    .map((label) => [label, messages.filter((m) => String(m?.text ?? m?.content ?? "").toLowerCase().includes(label.toLowerCase())).length]));
}
