export const PREPARATION_PAGES = ["TaskInformation", "ReviewQuiz", "InitialDecision"];
export const FORMAL_INITIAL_DECISION_SECONDS = 300;
export const GROUP_DECISION_SECONDS = 90;
export const SHARED_BREAK_SECONDS = 300;
export const SHARED_BREAK_READY_WINDOW_SECONDS = 30;

export function personalPages(stageName, taskIndex) {
  if (stageName === "Preparation") return PREPARATION_PAGES;
  if (stageName === "Followup") return ["IndividualAssessment", "TLX", "SubjectiveSurvey",
    ...(taskIndex === 0 ? ["Break"] : ["FinalQuestions", "ExpFeedback", "Debriefing"])];
  return [];
}
export function personalProgressKey(stageName) { return `personalProgress_${stageName}`; }
export function allPersonalPagesDone(players, stageName, taskIndex) {
  const length = personalPages(stageName, taskIndex).length;
  return length > 0 && players.length === 3
    && players.every((p) => (p.round.get(personalProgressKey(stageName))?.index ?? 0) >= length);
}

export function canConfirmSharedBreak(deadline, now) {
  return Number.isFinite(deadline)
    && Number.isFinite(now)
    && now >= deadline - SHARED_BREAK_READY_WINDOW_SECONDS * 1000;
}

export function canAdvanceSharedBreak(deadline, allReady, now) {
  return Boolean(allReady)
    && Number.isFinite(deadline)
    && Number.isFinite(now)
    && now >= deadline;
}
