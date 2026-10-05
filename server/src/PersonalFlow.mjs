import { personalPages, personalProgressKey, allPersonalPagesDone } from "../../shared/personalFlow.mjs";

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
      const timedOut = now >= progress.startedAt + 180000;
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
    if (page === "Break" && now < progress.startedAt + 300000) {
      // Hidden corner-arrow skip: the participant explicitly chose to end
      // their OWN break early. Recorded for research. This does not affect
      // other participants' breaks nor the group-entry gate.
      if (!request.skipBreak) return;
      player.round.set("breakSkippedAt", now);
      player.round.set("breakSkipAfterMs", now - progress.startedAt);
    }
    mirrorResponse(player, round, page);
    const index = progress.index + 1;
    player.round.set(key, { index, startedAt: now });
    if (page === "Debriefing") player.set("personalStudyCompletedAt", now);
    // Do not use native submit: Empirica ignores disconnected players there.
    // Group activities start only when all three assigned participants are ready.
    if (allPersonalPagesDone(game.players, stageName, taskIndex)) stage.set("ended", true);
    Empirica.flush();
  });
}
