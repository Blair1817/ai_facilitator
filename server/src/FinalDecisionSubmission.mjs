import { validateDecisionResponse } from "../../shared/decisionSubmission.mjs";

// Only responses accepted by the server count toward the group outcome.
// Never use browser drafts, native submit flags, or connected-player counts.
export function independentDecisionResult(players, { timedOut = false } = {}) {
  const responses = players.map((player) => player.round.get("finalDecisionSubmission"));
  const complete = players.length === 3 && responses.every((response) => response?.submissionId);
  if (!complete && !timedOut) return null;
  if (!complete) return { officialChoice: "FAIL", outcome: "timeout_fail", timedOut: true };
  const choice = responses[0].choice;
  return responses.every((response) => response.choice === choice)
    ? { officialChoice: choice, outcome: "consensus_choice", timedOut: false }
    : { officialChoice: "FAIL", outcome: "mismatch_fail", timedOut: false };
}

export function finalizeIndependentDecision(stage, { timedOut = false, now = Date.now(), endStage = true } = {}) {
  const round = stage.round, game = stage.currentGame;
  if (round.get("finalDecisionConfirmed") || stage.get("testSkippedAt")) return false;
  const result = independentDecisionResult(game.players, { timedOut });
  if (!result) return false;
  round.set("officialGroupFinalChoice", result.officialChoice);
  round.set("finalDecisionOutcome", result.outcome);
  round.set("finalDecisionTimedOut", result.timedOut);
  round.set("finalDecisionFinalizedAt", now);
  round.set("finalDecisionAgreementStatus", "finalized");
  round.set("finalDecisionMatchedChoice", result.outcome === "consensus_choice" ? result.officialChoice : null);
  round.set("finalDecisionDraftChoices", game.players.flatMap((player) => {
    const response = player.round.get("finalDecisionSubmission");
    return response ? [{ participantId: player.id, choice: response.choice, confidence: response.confidence }] : [];
  }));
  round.set("finalDecisionConfirmed", true);
  for (const player of game.players) {
    const response = player.round.get("finalDecisionSubmission");
    if (response) {
      player.round.set("finalDecision", {
        ...response, officialGroupFinalChoice: result.officialChoice, finalDecisionOutcome: result.outcome,
      });
    } else if (result.timedOut) {
      player.round.set("groupFinalTimeoutReason", "stage_timeout");
    }
  }
  // Avoid individual native submits: Empirica may disregard disconnected players.
  if (endStage) stage.set("ended", true);
  return true;
}

export function acceptIndependentDecision(player, request, now = Date.now()) {
  const game = player.currentGame, round = game?.currentRound, stage = game?.currentStage;
  if (!round || !stage || round.get("decisionFlowVersion") !== 2
    || stage.get("name") !== "FinalDecision" || !game.players.some((participant) => participant.id === player.id)
    || request?.roundId !== round.id || request.stageId !== stage.id
    || typeof request.requestId !== "string" || !request.requestId || request.requestId.length > 128) return;
  const respond = (status, reason) => {
    player.round.set("finalDecisionSubmissionResult", { requestId: request.requestId, status, reason });
  };
  // Check the receipt before deadline/finalized checks, so a lost acknowledgement
  // remains recoverable and even a different request cannot overwrite an answer.
  if (player.round.get("finalDecisionSubmission")) {
    respond("accepted", "already_submitted");
    return;
  }
  if (stage.get("testSkippedAt")) {
    respond("rejected", "closed");
    return;
  }
  const deadline = round.get("finalDecisionDeadline");
  if (!Number.isFinite(deadline) || now >= deadline || round.get("finalDecisionConfirmed") || stage.get("ended")) {
    if (Number.isFinite(deadline) && now >= deadline) finalizeIndependentDecision(stage, { timedOut: true, now });
    respond("rejected", "closed");
    return;
  }
  const reviewed = validateDecisionResponse(request, round.get("decisionOptions"));
  if (!reviewed.valid) { respond("rejected", reviewed.reason); return; }
  const response = { ...reviewed.response, submissionId: request.requestId, submittedAt: now };
  player.round.set("groupFinalChoice", response.choice);
  player.round.set("groupChoiceConfidence", response.confidence);
  player.round.set("agreesWithGroupChoice", response.agreesWithGroupChoice);
  player.round.set("finalPersonalChoice", response.finalPersonalChoice);
  player.round.set("finalPersonalChoiceRationale", response.finalPersonalChoiceRationale);
  player.round.set("groupFinalSubmittedAt", now);
  player.round.set("groupFinalCompletionDurationMs", now - (round.get("FinalDecisionStartedAt") ?? now));
  player.round.set("groupFinalTimeoutReason", null);
  player.round.set("finalDecision", response);
  player.round.set("finalDecisionSubmission", response);
  respond("accepted", "submitted");
  finalizeIndependentDecision(stage, { now });
}
