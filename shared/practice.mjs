// Shared mechanics only. Task reports and researcher-only metadata live on the server.
export const PRACTICE = Object.freeze({
  enabled: true,
  readingReminderSeconds: 60,
  discussionSeconds: 240,
  earlyFinishSeconds: 120,
  messagesPerParticipant: 1,
  totalMessages: 6,
  forceTimerSeconds: 30,
});
export const PRACTICE_CHAT = "practice_chat";
export const PRACTICE_PERSONAL_PAGES = ["PracticeWelcome", "PracticeReading", "PracticeInitialChoice", "PracticeDiscussionTutorial"];
export const PRACTICE_STAGES = [
  "PracticeWelcome", "PracticeDiscussion", "FinalDecision", "PracticeComplete",
];
export function practiceReadiness({ startedAt, now, counts, participantIds, config = PRACTICE }) {
  return Number.isFinite(startedAt)
    && now >= startedAt + config.earlyFinishSeconds * 1000
    && participantIds.length === 3
    && participantIds.every((id) => (counts[id] || 0) >= config.messagesPerParticipant)
    && participantIds.reduce((total, id) => total + (counts[id] || 0), 0) >= config.totalMessages;
}
