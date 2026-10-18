import { DECISION_NUDGE } from "../../shared/decisionSubmission.mjs";
import { isTestGame } from "../../shared/testMode.mjs";
import { DISCUSSION_OPENING_MESSAGE } from "../../shared/discussionOpening.mjs";
import { randomUUID } from "node:crypto";
import { appendToAttribute } from "./AppendOnlyAttribute.mjs";
import { FACILITATOR_ROLES, MESSAGE_TYPES } from "./ExperimentPolicies.mjs";
import { PRACTICE, PRACTICE_CHAT, PRACTICE_STAGES, PRACTICE_PERSONAL_PAGES, practiceReadiness } from "../../shared/practice.mjs";

// Research metadata only: never stored on a participant-visible scope or sent to an LLM.
export const PRACTICE_RESEARCH_METADATA = { fullInformationOptimum: "GARDEN" };
export const PRACTICE_SILENCE_NUDGE_DELAY_MS = 90_000;
const PRACTICE_SILENCE_NUDGE_OPENING =
  "Whenever you’re ready, feel free to jump in — sharing what you each know about the options is a good place to start.";
const PRACTICE_SILENCE_NUDGE_LULL =
  "No rush — feel free to keep sharing your thoughts whenever you’re ready.";
const practiceSilenceWatchdogTimers = new Map();
const options = [
  { id: "MAPLE", label: "Maple Room" },
  { id: "RIVERSIDE", label: "Riverside Room" },
  { id: "GARDEN", label: "Garden Room" },
];
const generalInfo = "# Practice Round: Choose a Room for Your First Team Meeting\n\nYour group needs to choose one of three rooms for a 30-minute team meeting.\n\nAll three rooms meet the basic requirements for capacity, accessibility, and safety. However, they differ in other features that may affect the meeting.\n\nUse only the information provided in this task.\n\n## Maple Room\n- Closest to the entrance\n- Bright natural light\n- Comfortable chairs\n\n## Riverside Room\n- Quiet\n- Large central table\n- Plenty of charging sockets\n\n## Garden Room\n- Good ventilation";
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
export function addPracticeRound(game, decisionFlowVersion = 1) {
  if (!PRACTICE.enabled) return;
  const round = game.addRound({
    name: "Practice Round", isPractice: true, phase: "practice",
    exclude_from_primary_analysis: true, practice_mode: true, ai_intervention_enabled: false,
    practiceConfig: PRACTICE, decisionFlowVersion,
  });
  for (const name of PRACTICE_STAGES) {
    // Empirica 1.12 requires an integer duration (5..1e9). Its maximum is a
    // framework sentinel for untimed teaching steps (~31 years), not a reading deadline.
    const duration = name === "PracticeDiscussion"
      ? PRACTICE.discussionSeconds
      : name === "FinalDecision"
        ? PRACTICE.finalDecisionSeconds
        : 1e9;
    round.addStage({ name, duration });
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
function finishPracticeDiscussion(stage, Empirica, now = Date.now()) {
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
  clearPracticeSilenceWatchdog(stage);
  round.set("practiceDiscussionEnded", timedOut ? "timeout" : "early");
  logPractice(game, timedOut ? "discussion_timeout" : "discussion_ended_early");
  stage.set("ended", true);
  Empirica.flush();
}

function practiceSilenceTimerKey(stage) {
  return `${stage.currentGame.id}:${stage.round.id}:${stage.id}`;
}

function clearPracticeSilenceWatchdog(stage) {
  const key = practiceSilenceTimerKey(stage);
  const timer = practiceSilenceWatchdogTimers.get(key);
  if (timer) clearTimeout(timer);
  practiceSilenceWatchdogTimers.delete(key);
}

export function deliverPracticeSilenceNudge(stage, appendMessage, Empirica, now = Date.now()) {
  const round = stage?.round;
  const deadline = round?.get("practiceDeadline");
  const lastHumanMessageAt = round?.get("practiceLastHumanMessageAt");
  const activityVersion = round?.get("practiceSilenceActivityVersion") ?? 0;
  if (!round?.get("isPractice")
    || stage.get("name") !== "PracticeDiscussion"
    || !stage.isCurrent()
    || stage.get("ended")
    || round.get("practiceDiscussionEnded")
    || !Number.isFinite(deadline)
    || now >= deadline
    || !Number.isFinite(lastHumanMessageAt)
    || now < lastHumanMessageAt + PRACTICE_SILENCE_NUDGE_DELAY_MS
    || round.get("practiceSilenceNudgeActivityVersion") === activityVersion) return false;

  const hasTalked = (round.get("practiceTotalMessages") || 0) > 0;
  const kind = hasTalked ? "lull" : "opening";
  const messageId = `practice-silence-${kind}-${round.id}-${activityVersion}`;
  // Claim this exact silence episode before appending, so reconnects and
  // competing callbacks cannot publish the same deterministic nudge twice.
  round.set("practiceSilenceNudgeActivityVersion", activityVersion);
  appendMessage(stage.currentGame, PRACTICE_CHAT, {
    messageId,
    groupId: stage.currentGame.id,
    speakerId: "ai",
    roundIndex: round.get("index"),
    stage: "PracticeDiscussion",
    messageType: MESSAGE_TYPES.FACILITATOR,
    speakerType: "facilitator_fixed",
    timestamp: now,
    phase: "practice",
    source: "facilitator_fixed",
    exclude_from_primary_analysis: true,
    role: FACILITATOR_ROLES.FIXED_MESSAGE,
    facilitatorOrigin: "DETERMINISTIC_FIXED",
    facilitatorTrigger: "PRACTICE_SILENCE_NUDGE",
    content: hasTalked ? PRACTICE_SILENCE_NUDGE_LULL : PRACTICE_SILENCE_NUDGE_OPENING,
    sender: { id: "ai", name: "Facilitator", avatar: "https://api.dicebear.com/9.x/initials/svg?backgroundColor=000000&seed=F" },
  });
  logPractice(stage.currentGame, "discussion_silence_nudge", null, { message_id: messageId, kind });
  Empirica?.flush?.();
  return true;
}

function armPracticeSilenceWatchdog(stage, appendMessage, Empirica) {
  clearPracticeSilenceWatchdog(stage);
  const round = stage?.round;
  const lastHumanMessageAt = round?.get("practiceLastHumanMessageAt");
  if (!round?.get("isPractice")
    || stage.get("name") !== "PracticeDiscussion"
    || !stage.isCurrent()
    || stage.get("ended")
    || round.get("practiceDiscussionEnded")
    || !Number.isFinite(lastHumanMessageAt)) return;
  const timer = setTimeout(
    () => {
      practiceSilenceWatchdogTimers.delete(practiceSilenceTimerKey(stage));
      deliverPracticeSilenceNudge(stage, appendMessage, Empirica);
    },
    Math.max(0, lastHumanMessageAt + PRACTICE_SILENCE_NUDGE_DELAY_MS - Date.now()),
  );
  timer.unref?.();
  practiceSilenceWatchdogTimers.set(practiceSilenceTimerKey(stage), timer);
}

export function deliverPracticeDiscussionReminder(stage, appendMessage, Empirica, now = Date.now()) {
  const round = stage?.round;
  const deadline = round?.get("practiceDeadline");
  if (!round?.get("isPractice")
    || stage.get("name") !== "PracticeDiscussion"
    || !stage.isCurrent()
    || stage.get("ended")
    || round.get("practiceDiscussionEnded")
    || round.get("practiceMinuteReminderSentAt")
    || !Number.isFinite(deadline)
    || now < deadline - PRACTICE.discussionReminderSeconds * 1000
    || now >= deadline - PRACTICE.forceTimerSeconds * 1000
    || now >= deadline) return false;

  const messageId = `practice-timer-${PRACTICE.discussionReminderSeconds}-${round.id}`;
  // Persist the delivery guard before appending so concurrent reconnect and
  // scheduled callbacks cannot publish the same reminder twice.
  round.set("practiceMinuteReminderSentAt", now);
  round.set("practiceMinuteReminderMessageId", messageId);
  appendMessage(stage.currentGame, PRACTICE_CHAT, {
    messageId,
    groupId: stage.currentGame.id,
    speakerId: `system-${MESSAGE_TYPES.TIMER_REMINDER}`,
    roundIndex: round.get("index"),
    stage: "PracticeDiscussion",
    messageType: MESSAGE_TYPES.TIMER_REMINDER,
    speakerType: MESSAGE_TYPES.TIMER_REMINDER,
    timestamp: now,
    phase: "practice",
    source: "server_timer",
    exclude_from_primary_analysis: true,
    content: `One minute remains in the discussion. ${DECISION_NUDGE}`,
    sender: { id: `system-${MESSAGE_TYPES.TIMER_REMINDER}`, name: "Timer", hexCode: "4B5563", avatar: "⏱️" },
  });
  logPractice(stage.currentGame, "discussion_one_minute_reminder", null, { message_id: messageId });
  Empirica?.flush?.();
  return true;
}

export function handlePracticeStageStart(stage, appendMessage, Empirica) {
  const round = stage.round;
  if (!round.get("isPractice") || stage.get("practiceStageStartHandled")) return;
  stage.set("practiceStageStartHandled", true);
  const game = stage.currentGame;
  const name = stage.get("name");
  round.set("practiceState", name);
  if (!stage.get("practiceStartedAt")) stage.set("practiceStartedAt", Date.now());
  if (name === "PracticeWelcome" && !round.get("practiceStarted")) {
    round.set("practiceStarted", true);
    logPractice(game, "practice_started");
  }
  // Fixed, deterministic orientation message. This never calls the LLM;
  // only an explicit participant @[Facilitator] mention enters the API path.
  if (name === "PracticeWelcome" && !round.get("practiceWelcomeGreetSent")) {
    round.set("practiceWelcomeGreetSent", true);
    const colours = game.players.map((p) => p.get("name")).join(", ");
    appendMessage(game, PRACTICE_CHAT, {
      messageId: `practice-greet-${round.id}`, groupId: game.id, speakerId: "ai",
      roundIndex: round.get("index"), stage: "PracticeWelcome",
      messageType: "onboarding", speakerType: "facilitator_fixed", timestamp: Date.now(),
      phase: "practice", source: "facilitator_fixed", exclude_from_primary_analysis: true,
      role: FACILITATOR_ROLES.FIXED_MESSAGE,
      facilitatorOrigin: "DETERMINISTIC_FIXED",
      facilitatorTrigger: "PRACTICE_ICEBREAKER_OPENING",
      content: `Welcome, ${colours}! You are now in the same online group. While everyone gets ready, say hello and tell the others something about yourself, for example, what you study or a place you would like to visit.`,
      sender: { id: "ai", name: "Facilitator", avatar: "https://api.dicebear.com/9.x/initials/svg?backgroundColor=000000&seed=F" },
    });
  }
  if (name === "PracticeDiscussion") {
    if (!round.get("practiceDiscussionStartedAt")) {
      const now = Date.now();
      round.set("practiceDiscussionStartedAt", now);
      round.set("practiceDeadline", now + PRACTICE.discussionSeconds * 1000);
      round.set("practiceMessageCounts", {});
      round.set("practiceTotalMessages", 0);
      round.set("practiceReady", {});
      round.set("practiceLastHumanMessageAt", now);
      round.set("practiceSilenceActivityVersion", 0);
      round.set("practiceSilenceNudgeActivityVersion", null);
      logPractice(game, "discussion_started");
    }
    // Fixed, deterministic discussion opening. It is not an automatic LLM
    // intervention and does not enter the Assessor/Controller pipeline.
    if (!round.get("practiceWelcomeSent")) {
      round.set("practiceWelcomeSent", true);
      appendMessage(game, PRACTICE_CHAT, {
        messageId: `practice-welcome-${round.id}`, groupId: game.id, speakerId: "ai",
        roundIndex: round.get("index"), stage: "PracticeDiscussion",
        messageType: "onboarding", speakerType: "facilitator_fixed", timestamp: Date.now(),
        phase: "practice", source: "facilitator_fixed", exclude_from_primary_analysis: true,
        role: FACILITATOR_ROLES.FIXED_MESSAGE,
        facilitatorOrigin: "DETERMINISTIC_FIXED",
        facilitatorTrigger: "PRACTICE_DISCUSSION_OPENING",
        content: DISCUSSION_OPENING_MESSAGE,
        sender: { id: "ai", name: "Facilitator", avatar: "https://api.dicebear.com/9.x/initials/svg?backgroundColor=000000&seed=F" },
      });
    }
    armPracticeSilenceWatchdog(stage, appendMessage, Empirica);
    const reminderAt = round.get("practiceDeadline") - PRACTICE.discussionReminderSeconds * 1000;
    const reminder = setTimeout(
      () => deliverPracticeDiscussionReminder(stage, appendMessage, Empirica),
      Math.max(0, reminderAt - Date.now()),
    );
    reminder.unref?.();
    const timeout = setTimeout(() => finishPracticeDiscussion(stage, Empirica), Math.max(0, round.get("practiceDeadline") - Date.now()));
    timeout.unref?.();
  }
}

export function registerPractice(Empirica, appendMessage) {
  Empirica.on("player", "practiceRequest", (_ctx, { player, practiceRequest: request }) => {
    const game = player.currentGame, round = game?.currentRound, stage = game?.currentStage;
    if (!round?.get("isPractice") || !stage || stage.get("ended") || !request
      || request.stageId !== stage.id || request.roundId !== round.id) return;
    if (isTestGame(game) && (request.version ?? 0) !== (player.round.get("testProgressVersion") || 0)) return;
    const personalPreparation = stage.get("name") === "PracticeWelcome";
    const pageIndex = player.round.get("practicePageIndex") || 0;
    const name = personalPreparation ? PRACTICE_PERSONAL_PAGES[pageIndex] : stage.get("name");
    if (personalPreparation && request.page !== name) return;
    const action = request.action;
    const now = Date.now();
    if (action === "deadline") { finishPracticeDiscussion(stage, Empirica, now); return; }
    if (action === "reminder_due" && name === "PracticeDiscussion") {
      deliverPracticeDiscussionReminder(stage, appendMessage, Empirica, now);
      return;
    }
    if (action === "ready" && name === "PracticeDiscussion") {
      finishPracticeDiscussion(stage, Empirica, now);
      if (round.get("practiceDiscussionEnded")) return;
      if (!practiceReadiness({ startedAt: round.get("practiceDiscussionStartedAt"), now,
        counts: round.get("practiceMessageCounts") || {}, participantIds: game.players.map((p) => p.id) })) return;
      const ready = { ...(round.get("practiceReady") || {}) };
      if (ready[player.id] === Boolean(request.ready)) return;
      ready[player.id] = Boolean(request.ready);
      round.set("practiceReady", ready);
      logPractice(game, request.ready ? "ready_to_decide" : "ready_cancelled", player);
      finishPracticeDiscussion(stage, Empirica, now);
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
}

// Handled before the formal human-message / LLM paths. No formal state is touched.
export function handlePracticeMessage(player, request, appendMessage, Empirica) {
  const game = player.currentGame, round = game.currentRound, stage = game.currentStage;
  const key = `practiceMessageResult.${player.id}.${request?.requestId}`;
  if (game.get(key)) {
    const priorResult = game.get(key);
    player.set("humanMessageRequestResult", priorResult);
    return priorResult;
  }
  const now = Date.now();
  // Welcome icebreaker chat: only while the sender is still ON the Welcome
  // page (pageIndex 0). Advancing to Reading/InitialChoice/Tutorial locks it,
  // even though the shared stage is still PracticeWelcome.
  const welcomeChat = stage.get("name") === "PracticeWelcome" && !stage.get("ended")
    && !round.get("practiceWelcomeEnded")
    && (player.round.get("practicePageIndex") || 0) === 0;
  const accepted = (welcomeChat
    || (stage.get("name") === "PracticeDiscussion" && !stage.get("ended")
      && !round.get("practiceDiscussionEnded")))
    && request?.roundId === round.id && request?.stageId === stage.id
    && typeof request.requestId === "string" && request.requestId.length > 0 && request.requestId.length <= 128
    && typeof request.content === "string" && request.content.trim().length > 0 && request.content.trim().length <= 1024
    && (welcomeChat || (Number.isFinite(round.get("practiceDeadline")) && now < round.get("practiceDeadline")));
  const text = accepted ? request.content.trim() : null;
  const messageId = accepted ? `${player.id}-${request.requestId}` : null;
  const messageStage = welcomeChat ? "PracticeWelcome" : "PracticeDiscussion";
  const result = {
    requestId: request?.requestId,
    status: accepted ? "accepted" : "rejected",
    ...(accepted ? { content: text, messageId, stage: messageStage } : {}),
  };
  if (accepted) {
    if (welcomeChat) {
      const counts = { ...(round.get("practiceWelcomeMessageCounts") || {}) };
      counts[player.id] = (counts[player.id] || 0) + 1;
      round.set("practiceWelcomeMessageCounts", counts);
    } else {
      const counts = { ...(round.get("practiceMessageCounts") || {}) };
      counts[player.id] = (counts[player.id] || 0) + 1;
      round.set("practiceMessageCounts", counts);
      round.set("practiceTotalMessages", Object.values(counts).reduce((sum, count) => sum + count, 0));
      round.set("practiceLastHumanMessageAt", now);
      round.set("practiceSilenceActivityVersion", (round.get("practiceSilenceActivityVersion") || 0) + 1);
    }
    game.set(key, result);
    appendMessage(game, PRACTICE_CHAT, {
      messageId, groupId: game.id, participantId: player.id,
      roundIndex: round.get("index"), stage: messageStage,
      messageType: "human", speakerType: "human",
      timestamp: now, content: text, phase: "practice", source: "participant",
      speaker_colour: player.get("name"), exclude_from_primary_analysis: true,
      sender: { id: player.id, name: player.get("name"), hexCode: player.get("hexCode"),
        avatar: `https://api.dicebear.com/8.x/identicon/svg?rowColor=${player.get("hexCode")}` },
    });
    logPractice(game, "message_sent", player, { message_id: messageId });
    if (!welcomeChat) armPracticeSilenceWatchdog(stage, appendMessage, Empirica);
    if (game.players.some((p) => p.id !== player.id && text.includes(`@[${p.get("name")}]`))) {
      player.round.set("practiceMentionUsed", true);
      logPractice(game, "mention_used", player);
    }
  }
  player.set("humanMessageRequestResult", result);
  return result;
}
