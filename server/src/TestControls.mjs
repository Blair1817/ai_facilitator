import { isTestGame, testPersonalState, testControlDestinations } from "../../shared/testMode.mjs";
import { allPersonalPagesDone, personalProgressKey } from "../../shared/personalFlow.mjs";
import { sharedBreakState, clearSharedBreakTimer, synchroniseSharedBreak } from "./PersonalFlow.mjs";
import { appendToAttribute } from "./AppendOnlyAttribute.mjs";

export function canPublishTestResult(game, origin) {
  return game.currentStage?.id === origin.stageId
    && game.currentRound?.id === origin.roundId
    && game.currentStage?.get("name") === "Task"
    && !game.currentStage.get("ended")
    && !game.get("ended")
    && !game.get("endedAt");
}

export function initializeTestControls(game) {
  game.set("testControlsEnabled", game.get("treatment")?.testMode === true && game.get("treatmentName") === "test",
    { protected: true, immutable: true });
}
const completionKeys = {
  ReviewQuiz: ["reviewQuizPassed"],
  TLX: ["tlxSurveySubmittedAt"],
  SubjectiveSurvey: ["subjectiveSurveySubmittedAt"],
  InitialDecision: ["initialDecisionReceivedAt", "initialDecisionAcceptedOnTime", "initialSubmittedAt", "initialCompletionDurationMs", "initialDecisionTimeoutReason"],
  IndividualAssessment: ["individualAssessmentSubmittedAt", "individualAssessmentCompletionDurationMs"],
  Break: ["breakWaitingArrivedAt", "sharedBreakReadyStatus", "sharedBreakReadyConfirmedAt", "sharedBreakReadyRequestId"],
};
export function handleTestControl(player, request, now = Date.now()) {
  const game = player.currentGame, round = game?.currentRound, stage = game?.currentStage;
  let destination;
  const result = (status, reason) => ({ requestId: request?.requestId, status, reason,
    ...(status === "accepted" && destination ? { destination } : {}) });
  if (!request || typeof request.requestId !== "string" || !request.requestId.length || request.requestId.length > 128)
    return result("rejected", "invalid_request");
  if (!isTestGame(game) || !game.players.some(p => p.id === player.id)) return result("rejected", "not_authorized");
  const receiptKey = `testControlReceipt.${player.id}.${request.requestId}`;
  if (game.get(receiptKey)) return game.get(receiptKey);
  const finish = (status, reason) => {
    const response = result(status, reason);
    game.set(receiptKey, response, { protected: true });
    appendToAttribute({ get: key => game.get(key), set: (key, value) => game.set(key, value, { protected: true }) }, "testControlEvents", { id: `${player.id}:${request.requestId}`, ...response, action: request.action,
      playerId: player.id, timestamp: now, roundId: round?.id, stageId: stage?.id });
    game.set("testControlLastResult", { id: `${player.id}:${request.requestId}`, ...response, action: request.action, timestamp: now }, { protected: true });
    return response;
  };
  if (!round || !stage || game.get("ended") || stage.get("ended")
    || request.gameId !== game.id || request.roundId !== round.id || request.stageId !== stage.id)
    return finish("rejected", "stale_stage");
  const state = testPersonalState(player, round, stage);
  if (request.version !== state.version || request.stageVersion !== (stage.get("testControlVersion") || 0))
    return finish("rejected", "stale_progress");
  destination = testControlDestinations(round, stage, state)[request.action];
  const name = stage.get("name");
  let reason = null;
  if (["previous", "skip_page"].includes(request.action)) {
    if (!state.pages.length || request.index !== state.index) return finish("rejected", "not_personal_page");
    if (request.action === "skip_page" && state.pages[state.index] === "Break" && !round.get("sharedBreakCompletedAt")) return finish("rejected", "use_shared_break_control");
    reason = movePersonalPage({ game, round, stage, player, state, targetIndex: state.index + (request.action === "previous" ? -1 : 1), now });
  } else if (request.action === "skip_break") {
    reason = skipSharedBreak({ game, round, stage, now });
  } else if (request.action === "next_stage") {
    if (name === "FinalDecision" && !round.get("finalDecisionConfirmed")) {
      round.set("officialGroupFinalChoice", null);
      round.set("finalDecisionOutcome", "test_skipped");
      round.set("finalDecisionTimedOut", false);
      round.set("finalDecisionFinalizedAt", now);
      round.set("finalDecisionAgreementStatus", "test_skipped");
    }
    if (round.get("isPractice") && name === "PracticeDiscussion") round.set("practiceDiscussionEnded", "test_skipped");
    stage.set("testSkippedAt", now, { protected: true });
    endStageNow({ game, round, stage });
  } else return finish("rejected", "unknown_action");
  if (reason) return finish("rejected", reason);
  stage.set("testControlVersion", (stage.get("testControlVersion") || 0) + 1, { protected: true });
  return finish("accepted", request.action);
}

// Shared flow mutations. Used by participant test controls (test games only)
// and by the researcher admin monitor (any game, admin credentials only).
// Each returns null on success or a rejection reason; callers validate
// identity, staleness and authorisation before calling.
export function movePersonalPage({ game, round, stage, player, state, targetIndex, now = Date.now() }) {
  if (!state.pages.length) return "not_personal_page";
  if (!Number.isInteger(targetIndex) || targetIndex < 0 || targetIndex > state.pages.length) return "page_boundary";
  if (targetIndex === state.index) return "page_boundary";
  if (targetIndex > state.index && !round.get("sharedBreakCompletedAt")
    && state.pages.slice(state.index, targetIndex).includes("Break")) return "use_shared_break_control";
  const name = stage.get("name");
  if (targetIndex < state.index) {
    player.stage.set("submit", false);
    for (const page of state.pages.slice(targetIndex)) {
      for (const key of completionKeys[page] || []) player.round.set(key, null);
      if (page === "Debriefing") player.set("personalStudyCompletedAt", null);
    }
  }
  player.round.set("testProgressVersion", state.version + 1, { protected: true });
  if (state.practice) {
    player.round.set("practicePageIndex", targetIndex);
    player.round.set("practicePageStartedAt", now);
    player.stage.set("practiceDone", targetIndex === state.pages.length);
    const progress = { ...(stage.get("practiceProgress") || {}), [player.id]: targetIndex === state.pages.length };
    stage.set("practiceProgress", progress);
    if (game.players.length === 3 && game.players.every(p => progress[p.id])) stage.set("ended", true);
  } else {
    player.round.set(personalProgressKey(name), { index: targetIndex, startedAt: now });
    if (allPersonalPagesDone(game.players, name, round.get("taskIndex"), round.get("decisionFlowVersion"))) stage.set("ended", true);
  }
  return null;
}

export function skipSharedBreak({ game, round, stage, now = Date.now() }) {
  const name = stage.get("name");
  const summary = sharedBreakState(game.players, name, round.get("taskIndex"));
  if (name !== "Followup" || round.get("taskIndex") !== 0 || !summary.allArrived
    || !Number.isFinite(round.get("sharedBreakDeadline")) || round.get("sharedBreakCompletedAt"))
    return "break_not_ready";
  round.set("sharedBreakCompletedAt", now);
  round.set("sharedBreakTestSkippedAt", now);
  clearSharedBreakTimer(round.id);
  for (const p of game.players) {
    const ps = testPersonalState(p, round, stage);
    p.round.set("testProgressVersion", ps.version + 1, { protected: true });
    p.round.set(personalProgressKey(name), { index: ps.index + 1, startedAt: now });
  }
  if (allPersonalPagesDone(game.players, name, 0, round.get("decisionFlowVersion"))) stage.set("ended", true);
  return null;
}

export function endStageNow({ game, round, stage }) {
  if (round.get("isPractice") && stage.get("name") === "PracticeComplete") game.set("practice_complete", true);
  stage.set("ended", true);
}

export function registerTestControls(Empirica) {
  Empirica.on("player", "testControlRequest", (_ctx, { player, testControlRequest }) => {
    player.set("testControlResult", handleTestControl(player, testControlRequest), { protected: true });
    const stage = player.currentGame?.currentStage;
    if (stage && !stage.get("ended")) synchroniseSharedBreak(stage, () => {}, Empirica);
    Empirica.flush();
  });
}
