import { personalPages, personalProgressKey } from "./personalFlow.mjs";
import { PRACTICE_PERSONAL_PAGES } from "./practice.mjs";
export function isTestGame(game) {
  return game?.get("testControlsEnabled") === true
    && game.get("treatment")?.testMode === true && game.get("treatmentName") === "test";
}
export function testPersonalState(player, round, stage) {
  const practice = round.get("isPractice") && stage.get("name") === "PracticeWelcome";
  const pages = practice ? PRACTICE_PERSONAL_PAGES : personalPages(stage.get("name"), round.get("taskIndex"), round.get("decisionFlowVersion"));
  const progress = practice ? { index: player.round.get("practicePageIndex") || 0 }
    : player.round.get(personalProgressKey(stage.get("name")));
  return { practice, pages, index: progress?.index ?? 0, version: player.round.get("testProgressVersion") || 0 };
}

const TEST_PAGE_LABELS = {
  TaskInformation: "Task information", ReviewQuiz: "Knowledge check", InitialDecision: "Initial decision",
  IndividualAssessment: "Individual assessment", TLX: "Workload questionnaire", SubjectiveSurvey: "Experience questionnaire",
  Break: "Shared break", FinalQuestions: "Final questions", ExpFeedback: "Study feedback", Debriefing: "Debriefing",
  PracticeWelcome: "Practice introduction", PracticeReading: "Practice task information",
  PracticeInitialChoice: "Practice initial choice", PracticeDiscussionTutorial: "Chat tutorial",
  PracticeDiscussion: "Practice discussion", PracticeComplete: "Practice complete",
  Preparation: "Preparation", Task: "Discussion", Discussion: "Discussion", FinalDecision: "Group final decision", Followup: "Follow-up questionnaires",
};
export function testPageLabel(page) {
  return TEST_PAGE_LABELS[page] ?? page ?? "Waiting for other participants";
}
export function testControlDestinations(round, stage, state) {
  const name = stage.get("name");
  const formalRound = `Round ${(round.get("taskIndex") ?? 0) + 1}`;
  const followup = round.get("decisionFlowVersion") === 2 ? "Workload questionnaire" : "Individual assessment";
  let nextStage;
  if (round.get("isPractice")) {
    nextStage = {
      PracticeWelcome: "Practice discussion", PracticeDiscussion: "Practice · Group final decision",
      FinalDecision: "Practice complete", PracticeComplete: "Round 1 · Task information",
    }[name];
  } else {
    nextStage = {
      Preparation: `${formalRound} · Discussion`, Task: `${formalRound} · Group final decision`,
      Discussion: `${formalRound} · Group final decision`, FinalDecision: `${formalRound} · ${followup}`,
      Followup: round.get("taskIndex") === 0 ? "Round 2 · Task information" : "Study complete",
    }[name];
  }
  nextStage ??= "Next stage";
  const afterPersonalFlow = `Waiting for other participants → ${nextStage}`;
  return {
    previous: state.index > 0 ? testPageLabel(state.pages[state.index - 1]) : null,
    skip_page: state.pages[state.index + 1] ? testPageLabel(state.pages[state.index + 1]) : afterPersonalFlow,
    next_stage: nextStage,
    skip_break: "Round 2 · Task information",
  };
}
