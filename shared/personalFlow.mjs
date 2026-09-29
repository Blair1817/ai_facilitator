export const PREPARATION_PAGES = ["TaskInformation", "ReviewQuiz", "InitialDecision"];
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
