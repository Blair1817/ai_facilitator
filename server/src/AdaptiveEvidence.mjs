import { withMessageIds } from "./prompts/DynamicContext.mjs";
import { isPublicParticipantMessage } from "./CognitiveOperations.mjs";
import { checkNeedAssessment } from "./EvidenceChecker.js";

const key = s => String(s ?? "").trim().toLowerCase().replace(/\s+/g, " ");
const publicChat = chat => withMessageIds(chat).filter(isPublicParticipantMessage);
const quoteValid = (q, byId) => typeof q?.span === "string" && q.span.trim().length > 0
  && byId.get(q.messageId)?.text?.includes(q.span);

/** Model interprets current intent in context. Code checks the entire roster,
 * current message boundaries, quote ownership, option and distinct people.
 * No lexical vote detection and no inference from an unrepresented person. */
export function verifyEarlyCloseout(raw, { chat, roster, optionLabels }) {
  const messages = publicChat(chat), byId = new Map(messages.map(m => [m.messageId, m]));
  const no = reason => ({ active: false, reason, evidence: [], supporters: [] });
  if (roster.length !== 3 || new Set(roster).size !== 3) return no("requires_three_person_roster");
  if (!raw || raw.participants?.length !== 3 || new Set(raw.participants.map(p => p.participantName)).size !== 3) return no("closeout_not_fully_assessed");
  for (const p of raw.participants) {
    const latest = messages.filter(m => m.sender?.name === p.participantName).at(-1);
    if (!roster.includes(p.participantName) || (latest?.messageId ?? null) !== p.reviewedThroughMessageId) return no("stale_participant_review");
    if (!Array.isArray(p.evidence) || p.evidence.some(q => !quoteValid(q, byId) || byId.get(q.messageId).sender.name !== p.participantName)) return no("invalid_intent_evidence");
    if (p.stance !== "uncommitted" && !p.evidence.length) return no("missing_intent_evidence");
    if (!latest && p.stance !== "uncommitted") return no("silence_is_not_agreement");
  }
  if (raw.participants.some(p => ["object", "continue"].includes(p.stance))) return no("public_objection_or_continue");
  const proposal = raw.proposal;
  if (!proposal?.active || !optionLabels.some(x => key(x) === key(proposal.optionLabel))
    || !proposal.evidence?.length || proposal.evidence.some(q => !quoteValid(q, byId))
    || !proposal.evidence.some(q => key(q.span).includes(key(proposal.optionLabel)))) return no("no_current_grounded_proposal");
  const supporters = raw.participants.filter(p => p.stance === "ready" && key(p.optionLabel) === key(proposal.optionLabel));
  if (supporters.length < 2) return no("fewer_than_two_ready_for_same_option");
  // An unresolved competing closeout proposal is not agreement.
  if (raw.participants.some(p => p.stance === "ready" && key(p.optionLabel) !== key(proposal.optionLabel))) return no("competing_closeout_proposals");
  return { active: true, optionLabel: proposal.optionLabel, supporters: supporters.map(p => p.participantName),
    evidence: [...proposal.evidence, ...supporters.flatMap(p => p.evidence)],
    signature: JSON.stringify([key(proposal.optionLabel), supporters.map(p => p.participantName).sort(), proposal.evidence]),
    reason: "two_public_ready_positions_not_unanimity" };
}

export function semanticReferences(history = [], excluded = []) {
  return [...history.map((h, i) => ({ ...h, id: h.planId ?? `history:${i}`, semanticKey: h.semanticKey ?? h.target?.label })), ...excluded];
}

/** Semantic equivalence is assessed with full targets and delivered text, not
 * message IDs or an option blacklist. Exact matches also fail closed in code.
 * Every claimed reopening needs later, quoted public material; silence cannot
 * reopen a target. The Generator Validator independently checks repetition. */
export function verifySemanticTarget(review, { chat, references = [] }) {
  if (!references.length && !review) return { ok: true, evaluated: false };
  if (!review?.key || !Array.isArray(review.matches)) return { ok: false, reason: "semantic_review_missing" };
  if (review.matches.length !== references.length || new Set(review.matches.map(m => m.id)).size !== references.length) return { ok: false, reason: "semantic_review_incomplete" };
  const all = withMessageIds(chat), messages = all.filter(isPublicParticipantMessage), byId = new Map(messages.map(m => [m.messageId, m]));
  for (const ref of references) {
    const match = review.matches.find(m => m.id === ref.id);
    if (!match || !["different", "unchanged", "material_change"].includes(match.relation)) return { ok: false, reason: "semantic_match_missing" };
    const afterBoundary = q => quoteValid(q, byId) && all.findIndex(m => m.messageId === q.messageId) >= (ref.publicMessageBoundary ?? all.length);
    if (![match.responseEvidence, match.newEvidence].every(Array.isArray)
      || [...match.responseEvidence, ...match.newEvidence].some(q => !afterBoundary(q))) return { ok: false, reason: "invalid_target_update_evidence" };
    const sameKey = key(review.key) === key(ref.semanticKey);
    if (match.relation === "unchanged" || (sameKey && match.relation !== "material_change")) return { ok: false, reason: "semantic_target_already_asked", repeatedTarget: ref, review };
    if (match.relation === "material_change" && (!match.newEvidence.length || match.newEvidence.some(q => (ref.evidence || ref.target?.evidence || []).some(old => key(old.span) === key(q.span))))) return { ok: false, reason: "no_material_new_evidence", repeatedTarget: ref, review };
  }
  return { ok: true, evaluated: true, review };
}

// 2026-10-26: the detector judges ELICIT / SCRUTINIZE / INTEGRATE
// independently. Each reported candidate is verified on its own; the runtime
// then draws uniformly among roles present in the verified pool (and uniformly
// within a role). There is no priority between needs.
export const CANDIDATE_KEYS = Object.freeze({ elicit: "ELICIT", scrutinize: "SCRUTINIZE", integrate: "INTEGRATE" });
export const MAX_CONSECUTIVE_SAME_ROLE = 2;

/** Split independent detector output into per-need candidates for checkNeedAssessment(). */
export function candidateRaws(raw) {
  const candidates = raw?.candidates || {};
  return Object.entries(CANDIDATE_KEYS).filter(([key]) => candidates[key]).map(([key, need]) => ({
    need, operation: candidates[key].operation, target: candidates[key].target, rationale: candidates[key].rationale,
    ...(candidates[key].semanticReview ? { semanticReview: candidates[key].semanticReview } : {}),
  }));
}

const summarise = c => ({ need: c.need, operation: c.operation, role: c.role, label: c.target?.label ?? null,
  participantName: c.target?.participantName ?? null, source: c.source ?? "detector" });

/** Uniform draw: first a role among roles present, then a candidate within that role.
 * A role that already filled the last MAX_CONSECUTIVE_SAME_ROLE turns is skipped
 * when another role is available. Returns the exact selection probability. */
export function drawCandidate(pool, { random = Math.random, recentRoles = [] } = {}) {
  if (!pool?.length) return null;
  let roles = [...new Set(pool.map(c => c.role))];
  const last = recentRoles.slice(-MAX_CONSECUTIVE_SAME_ROLE);
  if (last.length === MAX_CONSECUTIVE_SAME_ROLE && last.every(r => r === last[0]) && roles.some(r => r !== last[0])) {
    roles = roles.filter(r => r !== last[0]);
  }
  const pick = list => list[Math.min(list.length - 1, Math.floor(random() * list.length))];
  const role = pick(roles);
  const within = pool.filter(c => c.role === role);
  const picked = pick(within);
  return { picked, probability: 1 / (roles.length * within.length), eligibleRoles: roles,
    remaining: pool.filter(c => c !== picked) };
}

export function selectAdaptiveAssessment(raw, { chat, roster, optionLabels = [], remainingTimeMs, triggerSource = "message", history = [], excluded = [], validateIntegration = null, extraCandidates = [], random = Math.random, recentRoles = [] }) {
  const early = verifyEarlyCloseout(raw?.closeout, { chat, roster, optionLabels });
  const stage = remainingTimeMs <= 180_000 ? "closeout_assessment" : early.active ? "early_closeout" : "ordinary";
  const scheduling = { stage, remainingTimeMs, triggerSource };
  const references = semanticReferences(history, excluded);
  const check = candidate => {
    if (!candidate) return null;
    const checked = checkNeedAssessment(candidate, { chat, activeParticipantNames: roster, scheduling });
    if (!checked.role) return checked;
    if (candidate.need === "INTEGRATE" && ["already_covered", "insufficient_material", "no_open_integration", "participant_summary_in_progress"].includes(raw?.integrationStatus)) {
      return { ...checked, need: "NONE", role: null, checkedFactors: null, downgradedReason: `integration_${raw.integrationStatus}` };
    }
    const semantic = verifySemanticTarget(candidate.semanticReview, { chat, references });
    if (!semantic.ok) return { ...checked, need: "NONE", role: null, checkedFactors: null, downgradedReason: semantic.reason, semantic };
    // An integration candidate must qualify as an executable plan.
    if (checked.role === "synthesiser" && validateIntegration) {
      const preflight = validateIntegration(checked, candidate.semanticReview);
      if (preflight.status !== "passed") return { ...checked, need: "NONE", role: null, checkedFactors: null,
        downgradedReason: preflight.failureReasons.join(","), integrationPreflight: preflight };
    }
    return { ...checked, semanticReview: candidate.semanticReview, semantic };
  };
  // A verified explicit participant summary always pauses the checkpoint.
  if (raw?.defer != null) {
    const deferred = checkNeedAssessment({ need: "NONE", operation: null, target: null, defer: raw.defer },
      { chat, activeParticipantNames: roster, scheduling });
    return { ...deferred, early, scheduling, selection: { mode: "deferred", pool: [], rejected: [] } };
  }
  const verified = [], rejected = [];
  for (const candidate of candidateRaws(raw)) {
    const result = check(candidate);
    if (result?.role) verified.push(result);
    else rejected.push({ need: candidate.need, operation: candidate.operation, reason: result?.downgradedReason ?? "unverified" });
  }
  const integration = verified.find(c => c.role === "synthesiser");
  // Scheduler-triggered closeout checks keep their existing integration-only scope.
  const closeoutOnly = triggerSource !== "message" && excluded.length === 0;
  const mayGenerate = triggerSource !== "early_closeout_probe" || early.active;
  const pool = closeoutOnly ? (mayGenerate && integration ? [integration] : []) : [...verified, ...extraCandidates];
  const draw = drawCandidate(pool, { random, recentRoles });
  // With no verified candidate, keep the rejection reasons so the gate records
  // evidence_check_failed (not no_need) when the detector did report needs.
  const selected = draw?.picked ?? { need: "NONE", role: null, checkedFactors: null,
    ...(rejected.length && !closeoutOnly ? { rawNeed: rejected.map(r => r.need).join(","), downgradedReason: rejected.map(r => r.reason).join(",") } : {}) };
  return { ...selected, early, scheduling,
    selection: { mode: closeoutOnly ? "closeout" : "randomized", pool: pool.map(summarise), rejected,
      probability: draw?.probability ?? null, eligibleRoles: draw?.eligibleRoles ?? [],
      remaining: draw?.remaining ?? [], recentRoles: recentRoles.slice(-MAX_CONSECUTIVE_SAME_ROLE) },
    integrationObservation: { evaluated: Boolean(raw?.candidates), qualified: Boolean(integration),
      reason: rejected.find(r => r.need === "INTEGRATE")?.reason ?? raw?.integrationStatus ?? null },
  };
}

/** Redraw once from the remaining verified pool after a repetition rejection. */
export function redrawAdaptiveSelection(previous, { random = Math.random, recentRoles = [] } = {}) {
  const pool = previous?.selection?.remaining || [];
  const draw = drawCandidate(pool, { random, recentRoles });
  const selected = draw?.picked ?? { need: "NONE", role: null, checkedFactors: null };
  return { ...selected, early: previous?.early, scheduling: previous?.scheduling,
    selection: { ...previous?.selection, mode: "redraw", probability: draw?.probability ?? null,
      eligibleRoles: draw?.eligibleRoles ?? [], remaining: draw?.remaining ?? [] } };
}
