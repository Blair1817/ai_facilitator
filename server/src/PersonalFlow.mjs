import {
  FORMAL_INITIAL_DECISION_SECONDS,
  SHARED_BREAK_SECONDS,
  allPersonalPagesDone,
  canAdvanceSharedBreak,
  canConfirmSharedBreak,
  personalPages,
  personalProgressKey,
} from "../../shared/personalFlow.mjs";

const sharedBreakDeadlineTimers = new Map();

function currentPersonalPage(player, stageName, taskIndex) {
  const progress = player.round.get(personalProgressKey(stageName));
  return progress ? personalPages(stageName, taskIndex)[progress.index] ?? null : null;
}

export function sharedBreakState(players, stageName, taskIndex) {
  const atBreak = players.filter((player) => currentPersonalPage(player, stageName, taskIndex) === "Break");
  const ready = players.filter((player) => player.round.get("sharedBreakReadyStatus") === "ready");
  return {
    arrivalCount: atBreak.length,
    requiredCount: players.length,
    allArrived: players.length === 3 && atBreak.length === players.length,
    readyCount: ready.length,
    allReady: players.length === 3 && ready.length === players.length,
  };
}

function clearSharedBreakTimer(roundId) {
  const existing = sharedBreakDeadlineTimers.get(roundId);
  if (existing) clearTimeout(existing);
  sharedBreakDeadlineTimers.delete(roundId);
}

function advanceSharedBreak(stage, mirrorResponse, now = Date.now()) {
  const round = stage.round;
  const game = stage.currentGame;
  const stageName = stage.get("name");
  const taskIndex = round.get("taskIndex");
  const summary = sharedBreakState(game.players, stageName, taskIndex);
  const deadline = round.get("sharedBreakDeadline");
  if (round.get("sharedBreakCompletedAt")
    || !summary.allArrived
    || !canAdvanceSharedBreak(deadline, summary.allReady, now)) return false;

  const key = personalProgressKey(stageName);
  const pages = personalPages(stageName, taskIndex);
  const breakIndex = pages.indexOf("Break");
  for (const player of game.players) {
    const progress = player.round.get(key);
    if (!progress || progress.index !== breakIndex) return false;
  }

  round.set("sharedBreakCompletedAt", now);
  for (const player of game.players) {
    mirrorResponse(player, round, "Break");
    player.round.set(key, { index: breakIndex + 1, startedAt: now });
  }
  clearSharedBreakTimer(round.id);
  if (allPersonalPagesDone(game.players, stageName, taskIndex)) stage.set("ended", true);
  return true;
}

function armSharedBreakDeadline(stage, mirrorResponse, Empirica) {
  const deadline = stage.round.get("sharedBreakDeadline");
  if (!Number.isFinite(deadline) || deadline <= Date.now() || stage.round.get("sharedBreakCompletedAt")) return;
  clearSharedBreakTimer(stage.round.id);
  const timeout = setTimeout(() => {
    advanceSharedBreak(stage, mirrorResponse);
    Empirica.flush();
  }, Math.max(0, deadline - Date.now()));
  timeout.unref?.();
  sharedBreakDeadlineTimers.set(stage.round.id, timeout);
}

export function synchroniseSharedBreak(stage, mirrorResponse, Empirica, now = Date.now()) {
  const round = stage?.round;
  const game = stage?.currentGame;
  const stageName = stage?.get("name");
  const taskIndex = round?.get("taskIndex");
  if (!round || !game || stageName !== "Followup" || taskIndex !== 0 || stage.get("ended")) return false;

  const key = personalProgressKey(stageName);
  const pages = personalPages(stageName, taskIndex);
  const breakIndex = pages.indexOf("Break");
  for (const player of game.players) {
    if (player.round.get(key)?.index === breakIndex && !player.round.get("breakWaitingArrivedAt")) {
      player.round.set("breakWaitingArrivedAt", now);
    }
  }

  let summary = sharedBreakState(game.players, stageName, taskIndex);
  round.set("sharedBreakArrivalCount", summary.arrivalCount);
  round.set("sharedBreakRequiredCount", summary.requiredCount);
  if (summary.allArrived && !Number.isFinite(round.get("sharedBreakDeadline"))) {
    round.set("sharedBreakStartedAt", now);
    round.set("sharedBreakDeadline", now + SHARED_BREAK_SECONDS * 1000);
    for (const player of game.players) {
      if (!player.round.get("sharedBreakReadyStatus")) {
        player.round.set("sharedBreakReadyStatus", "not_ready");
      }
    }
  }

  summary = sharedBreakState(game.players, stageName, taskIndex);
  round.set("sharedBreakReadyCount", summary.readyCount);
  round.set("sharedBreakAllReady", summary.allReady);
  const advanced = advanceSharedBreak(stage, mirrorResponse, now);
  if (!advanced && Number.isFinite(round.get("sharedBreakDeadline"))) {
    armSharedBreakDeadline(stage, mirrorResponse, Empirica);
  }
  return advanced;
}

export function handlePersonalFlowStageStart(stage) {
  if (!personalPages(stage.get("name"), stage.round.get("taskIndex")).length) return;
  const key = personalProgressKey(stage.get("name"));
  for (const player of stage.currentGame.players) {
    if (!player.round.get(key)) player.round.set(key, { index: 0, startedAt: Date.now() });
  }
}

export function registerPersonalFlow(Empirica, mirrorResponse) {
  Empirica.on("player", "personalPageRequest", (_ctx, { player, personalPageRequest: request }) => {
    const game = player.currentGame, stage = game?.currentStage, round = game?.currentRound;
    if (!request || !stage || stage.get("ended") || request.stageId !== stage.id || request.roundId !== round.id) return;
    const stageName = stage.get("name"), taskIndex = round.get("taskIndex");
    const pages = personalPages(stageName, taskIndex), key = personalProgressKey(stageName);
    const progress = player.round.get(key);
    if (!progress || request.index !== progress.index || progress.index >= pages.length) return;
    const page = pages[progress.index], now = Date.now();
    if (page === "ReviewQuiz" && player.round.get("reviewQuizPassed") !== true) return;
    if (page === "InitialDecision") {
      const response = player.round.get("initialDecision");
      const timedOut = now >= progress.startedAt + FORMAL_INITIAL_DECISION_SECONDS * 1000;
      if (!response && !timedOut) return;
      player.round.set("initialSubmittedAt", response?.submittedAt ?? null);
      player.round.set("initialCompletionDurationMs", now - progress.startedAt);
      player.round.set("initialDecisionTimeoutReason", response ? null : "stage_timeout");
    }
    if (page === "IndividualAssessment" && round.get("finalDecisionOutcome") !== "consensus_choice") {
      if (!player.round.get("finalPersonalChoice") || player.round.get("finalPersonalChoiceConfidence") == null || !player.round.get("finalPersonalChoiceRationale")?.trim()) return;
      player.round.set("individualAssessmentSubmittedAt", now);
      player.round.set("individualAssessmentCompletionDurationMs", now - progress.startedAt);
    }
    if (page === "TLX" && !player.round.get("tlxSurvey")) return;
    if (page === "SubjectiveSurvey" && !player.round.get("subjectiveSurvey")) return;
    if (page === "FinalQuestions" && !player.get("finalQuestions")) return;
    if (page === "ExpFeedback" && !player.get("expFeedback")) return;
    // Break completion is controlled only by the shared server deadline and
    // three readiness confirmations below. Legacy skipBreak requests cannot
    // advance the personal cursor.
    if (page === "Break") return;
    mirrorResponse(player, round, page);
    const index = progress.index + 1;
    player.round.set(key, { index, startedAt: now });
    if (page === "Debriefing") player.set("personalStudyCompletedAt", now);
    // Do not use native submit: Empirica ignores disconnected players there.
    // Group activities start only when all three assigned participants are ready.
    synchroniseSharedBreak(stage, mirrorResponse, Empirica, now);
    if (allPersonalPagesDone(game.players, stageName, taskIndex)) stage.set("ended", true);
    Empirica.flush();
  });

  Empirica.on("player", "sharedBreakRequest", (_ctx, { player, sharedBreakRequest: request }) => {
    const game = player.currentGame, stage = game?.currentStage, round = game?.currentRound;
    if (!request || !stage || stage.get("ended")
      || stage.get("name") !== "Followup" || round?.get("taskIndex") !== 0
      || request.stageId !== stage.id || request.roundId !== round.id) return;
    const key = personalProgressKey("Followup");
    const progress = player.round.get(key);
    const pages = personalPages("Followup", 0);
    if (!progress || request.index !== progress.index || pages[progress.index] !== "Break") return;

    const now = Date.now();
    synchroniseSharedBreak(stage, mirrorResponse, Empirica, now);
    if (request.action === "ready") {
      const deadline = round.get("sharedBreakDeadline");
      if (!canConfirmSharedBreak(deadline, now)) {
        player.round.set("sharedBreakReadyRejectedAt", now);
      } else if (player.round.get("sharedBreakReadyStatus") !== "ready") {
        player.round.set("sharedBreakReadyStatus", "ready");
        player.round.set("sharedBreakReadyConfirmedAt", now);
      }
    }
    synchroniseSharedBreak(stage, mirrorResponse, Empirica, now);
    Empirica.flush();
  });
}
