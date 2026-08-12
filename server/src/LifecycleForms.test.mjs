import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const dirname = path.dirname(fileURLToPath(import.meta.url));
const callbacksSource = readFileSync(path.join(dirname, "callbacks.js"), "utf8");
const appSource = readFileSync(path.join(dirname, "../../client/src/App.jsx"), "utf8");
const gameSource = readFileSync(path.join(dirname, "../../client/src/Game.jsx"), "utf8");
const reviewQuizSource = readFileSync(
  path.join(dirname, "../../client/src/stages/ReviewQuiz.jsx"),
  "utf8",
);
const breakSource = readFileSync(
  path.join(dirname, "../../client/src/stages/Break.jsx"),
  "utf8",
);
const surveySource = readFileSync(
  path.join(dirname, "../../client/src/intro-exit/SubjectiveSurvey.jsx"),
  "utf8",
);
const overallInstructionsSource = readFileSync(
  path.join(dirname, "../../client/src/intro-exit/OverallInstructions.jsx"),
  "utf8",
);
const recruitmentBootstrapSource = readFileSync(
  path.join(dirname, "../../client/src/intro-exit/RecruitmentBootstrap.jsx"),
  "utf8",
);
const debriefingSource = readFileSync(
  path.join(dirname, "../../client/src/intro-exit/Debriefing.jsx"),
  "utf8",
);
const noGamesSource = readFileSync(
  path.join(dirname, "../../client/src/intro-exit/NoGames.jsx"),
  "utf8",
);
const gamesFullSource = readFileSync(
  path.join(dirname, "../../client/src/intro-exit/GamesFull.jsx"),
  "utf8",
);

test("R1-R2: both rounds wrap the IceBreaker in ten-second transition countdowns", () => {

  const round1Stages = callbacksSource.slice(
    callbacksSource.indexOf('round1.addStage({ name: "TaskInformation"'),
    callbacksSource.indexOf("const round2 = game.addRound("),
  );
  const round2Stages = callbacksSource.slice(
    callbacksSource.indexOf('round2.addStage({ name: "TaskInformation"'),
    callbacksSource.indexOf("// MIGRATED from old 2nd (TEMP-BE-007"),
  );
  for (const stages of [round1Stages, round2Stages]) {
    assert.match(
      stages,
      /addReviewQuizStage\([^)]+\);[\s\S]*name: "IceBreakerStartCountdown"[\s\S]*name: "Introduction"[\s\S]*name: "IceBreakerEndCountdown"[\s\S]*name: "InitialDecision"/,
    );
  }

  assert.match(callbacksSource, /const ICEBREAKER_TRANSITION_DURATION_SECONDS = 10;/);
  assert.match(gameSource, /stageName == "IceBreakerStartCountdown"/);
  assert.match(gameSource, /stageName == "IceBreakerEndCountdown"/);
  assert.match(reviewQuizSource, /player\.stage\.set\("submit", true\)/);
});

test("R3-R7/R19: participant pages use normal stage submission, including the validated Break gate", () => {
  assert.doesNotMatch(callbacksSource, /Empirica\.on\("TRANSITION_ADD"|heldStagePauseTransition|isServerHeldStage/);
  assert.match(callbacksSource, /updateBreakReadySummary/);
  assert.match(breakSource, /remaining === 0 && ready && allReady/);
  assert.match(breakSource, /player\.stage\.set\("submit", true\)/);
  assert.match(callbacksSource, /name: "TaskInformation",\s+duration: TASK_INFORMATION_DURATION_SECONDS/);
  assert.match(callbacksSource, /name: "Walkthrough",\s+duration: WALKTHROUGH_DURATION_SECONDS/);
  assert.match(callbacksSource, /name: "ReviewQuiz", duration: REVIEW_QUIZ_SAFETY_DURATION_SECONDS/);
  for (const key of [
    "taskInformationStartedAt", "taskInformationCompletedAt", "taskInformationCompletionDurationMs",
    "walkthroughStartedAt", "walkthroughCompletedAt", "walkthroughCompletionDurationMs",
    "reviewQuizStartedAt", "reviewQuizCompletedAt", "reviewQuizCompletionDurationMs",
    "finalQuestionsStartedAt", "finalQuestionsCompletedAt", "finalQuestionsCompletionDurationMs",
    "tlxSubmittedAt", "tlxCompletionDurationMs", "subjectiveSurveySubmittedAt",
    "subjectiveSurveyCompletionDurationMs",
  ]) assert.doesNotMatch(callbacksSource, new RegExp(key));
  assert.doesNotMatch(callbacksSource, /reviewQuiz(Attempt|Wrong|Correctness|Retry)/i);
});

test("SubjectiveSurvey requires every visible response without blocking hidden condition-specific questions", () => {
  assert.match(surveySource, /const facilitation = round\?\.get\("facilitation"\)/);
  assert.match(surveySource, /alwaysVisibleComplete = \[question1, question2, question3, question4, question5, question6\]/);
  assert.match(surveySource, /playerName != "Facilitator" \|\| String\(question7\)\.trim\(\)/);
  assert.match(
    surveySource,
    /facilitation == "none" \|\|[\s\S]*playerName == "Facilitator" \|\|[\s\S]*\[question8, question9, question10, question11, question12, question13, question14, question15\]/,
  );
  assert.doesNotMatch(surveySource, /facilitatorPreference|human facilitator/);
  assert.match(surveySource, /if \(submitting \|\| !isComplete\)/);
  assert.match(surveySource, /disabled=\{submitting \|\| !isComplete\}/);
  assert.match(surveySource, /Please answer every question shown above before continuing\./);
  assert.match(surveySource, /player\.round\.set\("subjectiveSurvey"/);
});

test("OverallInstructions is one global introStep before RecruitmentBootstrap and is not a round stage", () => {
  assert.match(appSource, /import \{ OverallInstructions \} from "\.\/intro-exit\/OverallInstructions"/);
  assert.match(appSource, /return \[OverallInstructions, RecruitmentBootstrap\];/);
  assert.match(overallInstructionsSource, /export function OverallInstructions\(\{ next \}\)/);
  assert.match(overallInstructionsSource, /Overall Instructions/);
  assert.match(overallInstructionsSource, /handleClick=\{next\}/);
  assert.match(overallInstructionsSource, />\s*Continue\s*</);
  assert.doesNotMatch(overallInstructionsSource, /player\.stage|useStage|useRound/);
  assert.doesNotMatch(callbacksSource, /name: "OverallInstructions"/);
  assert.doesNotMatch(gameSource, /OverallInstructions/);
});

test("Consent is completed outside Empirica and no Consent response is collected or stored in-app", () => {
  assert.match(appSource, /disableConsent/);
  assert.doesNotMatch(appSource, /import \{ Consent \}|consent=\{Consent\}/);
  assert.doesNotMatch(recruitmentBootstrapSource, /consent(Status|Timestamp|Version)|CONSENT_METADATA_KEY|localStorage/);
  assert.doesNotMatch(callbacksSource, /name: "Consent"/);
});

test("Debriefing is the final informational exit step and finishes without a code or redirect", () => {
  assert.match(appSource, /return \[FinalQuestions, ExpFeedback, Debriefing\];/);
  assert.match(appSource, /return \[ExpFeedback, Debriefing\];/);
  assert.doesNotMatch(appSource, /FinishedExitCode|finished=/);
  assert.match(debriefingSource, /Thank you for taking part/);
  assert.match(debriefingSource, /player\?\.id \|\| "Not available"/);
  assert.match(debriefingSource, /jingnan\.zhang\.24@ucl\.ac\.uk/);
  assert.match(debriefingSource, /\[withdrawal deadline\]/);
  assert.match(debriefingSource, /\[Supervisor name\], \[UCL email\]/);
  assert.match(debriefingSource, /handleClick=\{handleFinish\}/);
  assert.match(debriefingSource, />\s*Finish study\s*</);
  assert.doesNotMatch(debriefingSource, /completionUrl|VITE_PROLIFIC_COMPLETION_URL|window\.location|Redirecting/);
  assert.doesNotMatch(`${noGamesSource}\n${gamesFullSource}`, /completion code|INSERT CODE HERE/i);
});
