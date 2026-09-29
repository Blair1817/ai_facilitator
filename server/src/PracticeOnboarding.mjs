import { randomUUID } from "node:crypto";
import { appendToAttribute } from "./AppendOnlyAttribute.mjs";
import { PRACTICE, PRACTICE_CHAT, PRACTICE_STAGES, PRACTICE_PERSONAL_PAGES, practiceReadiness } from "../../shared/practice.mjs";

// Research metadata only: never stored on a participant-visible scope or sent to an LLM.
export const PRACTICE_RESEARCH_METADATA = { fullInformationOptimum: "GARDEN" };
const options = [
  { id: "MAPLE", label: "Maple Room" },
  { id: "RIVERSIDE", label: "Riverside Room" },
  { id: "GARDEN", label: "Garden Room" },
];
const generalInfo = "# Practice Round: Choose a Room for Your First Team Meeting\n\nYour group needs to choose one of three rooms for a 30-minute team meeting.\n\nAll three rooms meet the basic requirements for capacity, accessibility, and safety. However, they differ in other features that may affect the meeting.\n\nYou may not have exactly the same information as the other group members.\n\nUse only the information provided in this task.\n\n## Maple Room\n- Closest to the entrance\n- Bright natural light\n- Comfortable chairs\n\n## Riverside Room\n- Quiet\n- Large central table\n- Plenty of charging sockets\n\n## Garden Room\n- Good ventilation";
export const practiceReports = {
  Blue: "## Maple Room\n- Building work nearby may create noise during the meeting.\n\n## Garden Room\n- Has the most reliable Wi-Fi.",
  Orange: "## Riverside Room\n- The main display is currently unavailable.\n\n## Garden Room\n- Has a large working display.",
  Green: "## Maple Room\n- The furniture is fixed in rows, making group discussion less convenient.\n\n## Garden Room\n- The furniture can easily be arranged in a circle.",
};
// Preserve the study's established Green / Blue / Pink identities. Pink takes the Orange report.
export function practiceReportFor(name) { return practiceReports[name === "Pink" ? "Orange" : name]; }
export function logPractice(game, event, player = null, data = {}) {
  // Private choices stay on their owner's playerRound, like formal initial choices.
  const store = player && ["initial_choice", "initial_confidence"].includes(event) ? player.round : game;
  appendToAttribute(store, "practiceEvents", {
    id: randomUUID(), event, timestamp: Date.now(), phase: "practice",
    exclude_from_primary_analysis: true, group_id: game.id,
    speaker_id: player?.id ?? null, speaker_colour: player?.get("name") ?? null, ...data,
  });
}
export function addPracticeRound(game) {
  if (!PRACTICE.enabled) return;
  const round = game.addRound({
    name: "Practice Round", isPractice: true, phase: "practice",
    exclude_from_primary_analysis: true, practice_mode: true, ai_intervention_enabled: false,
    practiceConfig: PRACTICE,
  });
  for (const name of PRACTICE_STAGES) {
    // Empirica 1.12 requires an integer duration (5..1e9). Its maximum is a
    // framework sentinel for untimed teaching steps (~31 years), not a reading deadline.
    round.addStage({ name, duration: name === "PracticeDiscussion" ? PRACTICE.discussionSeconds : 1e9 });
  }
}
export function initialisePractice(round) {
  round.set("generalInfo", generalInfo);
  round.set("decisionOptions", options);
  for (const player of round.currentGame.players) {
    const report = practiceReportFor(player.get("name"));
    if (!report) throw new Error("Practice requires an assigned study colour");
    player.round.set("playerContent", report);
  }
}
export function registerPractice(Empirica, appendMessage) {
  const finishDiscussion = (stage, now = Date.now()) => {
    const round = stage.round;
    if (stage.get("name") !== "PracticeDiscussion" || !stage.isCurrent() || round.get("practiceDiscussionEnded")) return;
    const game = stage.currentGame;
    const timedOut = now >= round.get("practiceDeadline");
    const eligible = practiceReadiness({
      startedAt: round.get("practiceDiscussionStartedAt"), now,
      counts: round.get("practiceMessageCounts") || {}, participantIds: game.players.map((p) => p.id),
    });
    const ready = round.get("practiceReady") || {};
    if (!timedOut && !(eligible && game.players.every((p) => ready[p.id]))) return;
    round.set("practiceDiscussionEnded", timedOut ? "timeout" : "early");
    logPractice(game, timedOut ? "discussion_timeout" : "discussion_ended_early");
    stage.set("ended", true);
    Empirica.flush();
  };
  Empirica.onStageStart(({ stage }) => {
    const round = stage.round;
    if (!round.get("isPractice")) return;
    const game = stage.currentGame;
    const name = stage.get("name");
    round.set("practiceState", name);
    if (!stage.get("practiceStartedAt")) stage.set("practiceStartedAt", Date.now());
    if (name === "PracticeWelcome" && !round.get("practiceStarted")) {
      round.set("practiceStarted", true);
      logPractice(game, "practice_started");
    }
    if (name === "PracticeDiscussion") {
      if (!round.get("practiceDiscussionStartedAt")) {
        const now = Date.now();
        round.set("practiceDiscussionStartedAt", now);
        round.set("practiceDeadline", now + PRACTICE.discussionSeconds * 1000);
        round.set("practiceMessageCounts", {});
        round.set("practiceTotalMessages", 0);
        round.set("practiceReady", {});
        logPractice(game, "discussion_started");
      }
      if (!round.get("practiceWelcomeSent")) {
        round.set("practiceWelcomeSent", true);
        appendMessage(game, PRACTICE_CHAT, {
          messageId: `practice-welcome-${round.id}`, groupId: game.id, speakerId: "ai",
          roundIndex: round.get("index"), stage: "PracticeDiscussion",
          messageType: "onboarding", speakerType: "facilitator_fixed", timestamp: Date.now(),
          phase: "practice", source: "facilitator_fixed", exclude_from_primary_analysis: true,
          content: "Welcome! Start by saying hello, introducing your colour, and sharing which room currently looks best to you and why.",
          sender: { id: "ai", name: "Facilitator", avatar: "https://api.dicebear.com/9.x/initials/svg?backgroundColor=000000&seed=F" },
        });
      }
      const timeout = setTimeout(() => finishDiscussion(stage), Math.max(0, round.get("practiceDeadline") - Date.now()));
      timeout.unref?.();
    }
  });
  Empirica.on("player", "practiceRequest", (_ctx, { player, practiceRequest: request }) => {
    const game = player.currentGame, round = game?.currentRound, stage = game?.currentStage;
    if (!round?.get("isPractice") || !stage || stage.get("ended") || !request
      || request.stageId !== stage.id || request.roundId !== round.id) return;
    const personalPreparation = stage.get("name") === "PracticeWelcome";
    const pageIndex = player.round.get("practicePageIndex") || 0;
    const name = personalPreparation ? PRACTICE_PERSONAL_PAGES[pageIndex] : stage.get("name");
    if (personalPreparation && request.page !== name) return;
    const action = request.action;
    const now = Date.now();
    if (action === "deadline") { finishDiscussion(stage, now); return; }
    if (action === "ready" && name === "PracticeDiscussion") {
      finishDiscussion(stage, now);
      if (round.get("practiceDiscussionEnded")) return;
      if (!practiceReadiness({ startedAt: round.get("practiceDiscussionStartedAt"), now,
        counts: round.get("practiceMessageCounts") || {}, participantIds: game.players.map((p) => p.id) })) return;
      const ready = { ...(round.get("practiceReady") || {}) };
      if (ready[player.id] === Boolean(request.ready)) return;
      ready[player.id] = Boolean(request.ready);
      round.set("practiceReady", ready);
      logPractice(game, request.ready ? "ready_to_decide" : "ready_cancelled", player);
      finishDiscussion(stage, now);
    } else if (["timer_opened", "timer_hidden", "timer_forced_visible"].includes(action) && name === "PracticeDiscussion") {
      const forced = now >= round.get("practiceDeadline") - PRACTICE.forceTimerSeconds * 1000;
      if (action === "timer_hidden" && forced) return;
      if (action === "timer_forced_visible" && (!forced || player.round.get("practiceTimerForced"))) return;
      if (action === "timer_forced_visible") player.round.set("practiceTimerForced", true);
      player.round.set("practiceTimerVisible", action !== "timer_hidden");
      logPractice(game, action, player);
    } else if (action === "continue" && ["PracticeWelcome", "PracticeReading", "PracticeInitialChoice", "PracticeDiscussionTutorial", "PracticeComplete"].includes(name)) {
      if (player.stage.get("practiceDone")) return;
      if (name === "PracticeInitialChoice") {
        if (!options.some((o) => o.id === request.choice) || !Number.isFinite(request.confidence)
          || request.confidence < 0 || request.confidence > 100) return;
        player.round.set("initialDecision", { choice: request.choice, confidence: request.confidence, submittedAt: now, phase: "practice", exclude_from_primary_analysis: true });
        logPractice(game, "initial_choice", player, { choice: request.choice });
        logPractice(game, "initial_confidence", player, { confidence: request.confidence });
      }
      if (name === "PracticeReading") logPractice(game, "reading_ready", player);
      if (personalPreparation) {
        player.round.set("practicePageIndex", pageIndex + 1);
        player.round.set("practicePageStartedAt", now);
        if (pageIndex + 1 < PRACTICE_PERSONAL_PAGES.length) { Empirica.flush(); return; }
      }
      player.stage.set("practiceDone", true);
      if (name === "PracticeComplete") {
        player.round.set("practiceComplete", true);
        logPractice(game, "practice_completed", player);
      }
      const progress = { ...(stage.get("practiceProgress") || {}), [player.id]: true };
      stage.set("practiceProgress", progress);
      if (game.players.length === 3 && game.players.every((p) => progress[p.id])) {
        if (name === "PracticeComplete") game.set("practice_complete", true);
        stage.set("ended", true);
      }
    }
    Empirica.flush();
  });
  return { finishDiscussion };
}

// Handled before the formal human-message / LLM paths. No formal state is touched.
export function handlePracticeMessage(player, request, appendMessage) {
  const game = player.currentGame, round = game.currentRound, stage = game.currentStage;
  const key = `practiceMessageResult.${player.id}.${request?.requestId}`;
  if (game.get(key)) { player.set("humanMessageRequestResult", game.get(key)); return; }
  const now = Date.now();
  const accepted = stage.get("name") === "PracticeDiscussion" && !stage.get("ended")
    && !round.get("practiceDiscussionEnded") && request?.roundId === round.id && request?.stageId === stage.id
    && typeof request.requestId === "string" && request.requestId.length > 0 && request.requestId.length <= 128
    && typeof request.content === "string" && request.content.trim().length > 0 && request.content.trim().length <= 1024
    && Number.isFinite(round.get("practiceDeadline")) && now < round.get("practiceDeadline");
  const result = { requestId: request?.requestId, status: accepted ? "accepted" : "rejected" };
  if (accepted) {
    const text = request.content.trim();
    const counts = { ...(round.get("practiceMessageCounts") || {}) };
    counts[player.id] = (counts[player.id] || 0) + 1;
    round.set("practiceMessageCounts", counts);
    round.set("practiceTotalMessages", Object.values(counts).reduce((sum, count) => sum + count, 0));
    game.set(key, result);
    appendMessage(game, PRACTICE_CHAT, {
      messageId: `${player.id}-${request.requestId}`, groupId: game.id, participantId: player.id,
      roundIndex: round.get("index"), stage: "PracticeDiscussion", messageType: "human", speakerType: "human",
      timestamp: now, content: text, phase: "practice", source: "participant",
      speaker_colour: player.get("name"), exclude_from_primary_analysis: true,
      sender: { id: player.id, name: player.get("name"), hexCode: player.get("hexCode"),
        avatar: `https://api.dicebear.com/8.x/identicon/svg?rowColor=${player.get("hexCode")}` },
    });
    logPractice(game, "message_sent", player, { message_id: `${player.id}-${request.requestId}` });
    if (game.players.some((p) => p.id !== player.id && text.includes(`@[${p.get("name")}]`))) {
      player.round.set("practiceMentionUsed", true);
      logPractice(game, "mention_used", player);
    }
  }
  player.set("humanMessageRequestResult", result);
}
