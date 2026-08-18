export const MESSAGE_TYPES = Object.freeze({
  HUMAN: "human",
  FACILITATOR: "facilitator",
  SYSTEM: "system",
  ICE_BREAKING_FACILITATOR: "ice_breaking_facilitator",
  TIMER_REMINDER: "timer_reminder",
});

export const BREAK_READY_WINDOW_MS = 45_000;
export const NO_GROUP_FINAL_DECISION = "NO_GROUP_FINAL_DECISION";

export function canConfirmBreak(scheduledEndAt, now) {
  return Number.isFinite(scheduledEndAt) && now >= scheduledEndAt - BREAK_READY_WINDOW_MS;
}

export function canFinalizeBreak(scheduledEndAt, now, allReady) {
  return Boolean(allReady) && Number.isFinite(scheduledEndAt) && now >= scheduledEndAt;
}

export function isFreshFinalDecisionDraftRequest(request, lastRequestedAt) {
  if (!request || typeof request !== "object" || Array.isArray(request)) return false;
  if (typeof request.requestId !== "string" || !request.requestId || request.requestId.length > 128) return false;
  const requestedAt = Number(request.requestedAt);
  if (!Number.isFinite(requestedAt)) return false;
  if (lastRequestedAt === null || lastRequestedAt === undefined) return true;
  const previous = Number(lastRequestedAt);
  return Number.isFinite(previous) && requestedAt > previous;
}

export function isCurrentFinalDecisionConfirmation(request, agreementRevision) {
  if (!request || typeof request !== "object" || Array.isArray(request)) return false;
  const requestedRevision = Number(request.agreementRevision);
  return Number.isSafeInteger(requestedRevision)
    && requestedRevision >= 0
    && requestedRevision === agreementRevision;
}

export function summarizeFinalDecisionDrafts(drafts, requiredParticipants = 3) {
  const choices = Array.isArray(drafts) ? drafts.map((draft) => draft?.choice || "") : [];
  if (choices.length !== requiredParticipants || choices.some((choice) => !choice)) {
    return { status: "not_agreed", matchedChoice: null };
  }
  const matchedChoice = choices[0];
  return choices.every((choice) => choice === matchedChoice)
    ? { status: "agreed", matchedChoice }
    : { status: "not_agreed", matchedChoice: null };
}

export function allFinalDecisionConfirmationsMatch(drafts, matchedChoice, requiredParticipants = 3) {
  return Boolean(matchedChoice)
    && Array.isArray(drafts)
    && drafts.length === requiredParticipants
    && drafts.every((draft) => draft?.confirmedChoice === matchedChoice);
}

export function classifyFinalDecision(matchedChoice, { timedOut = false } = {}) {
  if (timedOut) {
    return { officialChoice: "FAIL", outcome: "timeout_fail", timedOut: true };
  }
  if (matchedChoice === NO_GROUP_FINAL_DECISION) {
    return { officialChoice: "FAIL", outcome: "declared_fail", timedOut: false };
  }
  return { officialChoice: matchedChoice, outcome: "consensus_choice", timedOut: false };
}

export function normalizeMessageContent(message) {
  return message?.content ?? message?.text ?? "";
}

export function allocateSequencePosition(counters, transcriptKey) {
  if (!counters || typeof counters !== "object" || Array.isArray(counters)) {
    throw new TypeError("Message sequence counters must be an object");
  }
  const current = counters[transcriptKey] ?? 0;
  if (!Number.isSafeInteger(current) || current < 0) {
    throw new Error(`Invalid message sequence counter for ${transcriptKey}`);
  }
  counters[transcriptKey] = current + 1;
  return current;
}

export function buildCanonicalMessage({
  messageId,
  groupId,
  participantId,
  speakerId,
  roundIndex,
  stage,
  messageType,
  speakerType,
  timestamp,
  sequencePosition,
  content,
  sender,
}) {
  const canonicalSpeakerId = participantId ?? speakerId;
  if (typeof messageId !== "string" || !messageId) throw new Error("messageId is required");
  if (typeof groupId !== "string" || !groupId) throw new Error("groupId is required");
  if (typeof canonicalSpeakerId !== "string" || !canonicalSpeakerId) throw new Error("participantId or speakerId is required");
  if (!Number.isInteger(roundIndex) || roundIndex < 0) throw new Error("roundIndex must be a non-negative integer");
  if (typeof stage !== "string" || !stage) throw new Error("stage is required");
  if (typeof messageType !== "string" || !messageType) throw new Error("messageType is required");
  if (typeof speakerType !== "string" || !speakerType) throw new Error("speakerType is required");
  if (!Number.isFinite(timestamp)) throw new Error("timestamp must be server-authored");
  if (!Number.isSafeInteger(sequencePosition) || sequencePosition < 0) throw new Error("sequencePosition must be a non-negative integer");
  if (typeof content !== "string" || !content.trim()) throw new Error("content is required");
  if (!sender || typeof sender !== "object") throw new Error("sender is required for display compatibility");

  return {
    messageId,
    groupId,
    ...(participantId ? { participantId } : { speakerId }),
    roundIndex,
    stage,
    messageType,
    speakerType,
    timestamp,
    sequencePosition,
    content,
    text: content,
    ts: timestamp,
    sender,
  };
}

export function reviewHumanMessageRequest({
  request,
  playerId,
  currentRoundId,
  currentRoundIndex,
  currentStageId,
  currentStageName,
  deadline,
  now,
}) {
  if (!request || typeof request !== "object" || Array.isArray(request)) {
    return { accepted: false, reason: "invalid_request" };
  }
  if (typeof request.requestId !== "string" || !request.requestId || request.requestId.length > 128) {
    return { accepted: false, reason: "invalid_request_id" };
  }
  if (typeof request.content !== "string" || !request.content.trim() || request.content.trim().length > 1024) {
    return { accepted: false, reason: "invalid_content" };
  }
  if (request.roundId !== currentRoundId) return { accepted: false, reason: "stale_round" };
  if (request.stageId !== currentStageId) return { accepted: false, reason: "stale_stage" };

  const isDiscussion = currentStageName === "Task" || currentStageName === "Discussion";
  const isIceBreaker = currentStageName === "Introduction";
  if (!isDiscussion && !isIceBreaker) return { accepted: false, reason: "wrong_stage" };
  if (isDiscussion && (!Number.isFinite(deadline) || now >= deadline)) {
    return { accepted: false, reason: "discussion_closed" };
  }

  return {
    accepted: true,
    reason: "accepted",
    requestId: request.requestId,
    messageId: `${playerId}-${request.requestId}`,
    attribute: isDiscussion ? `chat_round_${currentRoundIndex}` : `intro_round_${currentRoundIndex}`,
    stage: isDiscussion ? "Discussion" : "IceBreaker",
    content: request.content.trim(),
  };
}
