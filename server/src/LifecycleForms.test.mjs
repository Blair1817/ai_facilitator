import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const dirname = path.dirname(fileURLToPath(import.meta.url));
const callbacksSource = readFileSync(path.join(dirname, "callbacks.js"), "utf8");
const appSource = readFileSync(path.join(dirname, "../../client/src/App.jsx"), "utf8");
const gameSource = readFileSync(path.join(dirname, "../../client/src/Game.jsx"), "utf8");
const initialDecisionSource = readFileSync(
  path.join(dirname, "../../client/src/stages/InitialDecision.jsx"),
  "utf8",
);
const timerSource = readFileSync(
  path.join(dirname, "../../client/src/components/Timer.jsx"),
  "utf8",
);
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
const personalFlowClient = readFileSync(
  path.join(dirname, "../../client/src/PersonalFlow.jsx"),
  "utf8",
);
const personalFlowServer = readFileSync(
  path.join(dirname, "PersonalFlow.mjs"),
  "utf8",
);
const personalFlowShared = readFileSync(
  path.join(dirname, "../../shared/personalFlow.mjs"),
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

test("one technical practice container wraps the shared Icebreaker and formal rounds contain none", () => {

  const practiceStages = callbacksSource.slice(
    callbacksSource.indexOf('addPracticeRound(game);'),
    callbacksSource.indexOf('const round1 = game.addRound({'),
  );

  const round1Stages = callbacksSource.slice(
    callbacksSource.indexOf('round1.addStage({ name: "TaskInformation"'),
    callbacksSource.indexOf("const round2 = game.addRound("),
  );
  const round2Stages = callbacksSource.slice(
    callbacksSource.indexOf('round2.addStage({ name: "TaskInformation"'),
    callbacksSource.indexOf("// MIGRATED from old 2nd (TEMP-BE-007"),
  );
  assert.match(practiceStages, /addPracticeRound\(game\)/);
  for (const stages of [round1Stages, round2Stages]) assert.doesNotMatch(stages, /Walkthrough|IceBreaker|PracticeIcebreaker|Introduction/);

  assert.match(callbacksSource, /const ICEBREAKER_TRANSITION_DURATION_SECONDS = 10;/);
  assert.equal((callbacksSource.match(/name: "IceBreakerStartCountdown"/g) ?? []).length, 0);
  assert.equal((callbacksSource.match(/name: "IceBreakerEndCountdown"/g) ?? []).length, 0);
  assert.match(gameSource, /stageName == "IceBreakerStartCountdown"/);
  assert.match(gameSource, /stageName == "IceBreakerEndCountdown"/);
  assert.match(reviewQuizSource, /player\.stage\.set\("submit", true\)/);
});

test("InitialDecision page allows 180 seconds, shows a countdown, and advances without waiting for others", () => {
  // The 180s budget moved from a dedicated stage into the Preparation
  // personal flow: the client derives the deadline from the server-owned
  // page cursor and auto-advances on expiry; the server re-checks it.
  assert.match(personalFlowClient, /page === "InitialDecision" \? 180000 : 300000/);
  assert.match(personalFlowClient, /if \(page === "InitialDecision" && now >= deadline\) onNext\(\)/);
  assert.match(personalFlowServer, /progress\.startedAt \+ 180000/);

  assert.match(initialDecisionSource, /import \{ Timer \} from "\.\.\/components\/Timer"/);
  assert.match(initialDecisionSource, /Time remaining:/);
  assert.match(initialDecisionSource, /<Timer deadline=\{deadline\} \/>/);
  assert.doesNotMatch(initialDecisionSource, /setInterval|setTimeout/);
  assert.match(timerSource, /useStageTimer\(\)/);
  assert.match(timerSource, /timer\?\.remaining/);

  for (const key of ["initialChoice", "initialConfidence", "initialDecision"]) {
    assert.match(initialDecisionSource, new RegExp(key));
  }
  // In the personal flow the page advances as soon as this participant is
  // done; the synchronous stage submit remains only as a defensive fallback.
  assert.match(initialDecisionSource, /if \(onNext\) onNext\(\); else player\.stage\.set\("submit", true\)/);
  assert.match(initialDecisionSource, /Your initial decision has been submitted\./);
});

test("R3-R7/R19: personal pages advance individually; only group activities gate on all participants", () => {
  assert.doesNotMatch(callbacksSource, /Empirica\.on\("TRANSITION_ADD"|heldStagePauseTransition|isServerHeldStage/);
  // Personal pages never submit the shared stage: a server-owned per-player
  // cursor advances each participant as soon as their own responses validate.
  assert.match(personalFlowServer, /Empirica\.on\("player", "personalPageRequest"/);
  assert.match(personalFlowServer, /request\.index !== progress\.index \|\| progress\.index >= pages\.length/);
  assert.match(personalFlowServer, /player\.round\.set\(key, \{ index, startedAt: now \}\)/);
  // Group synchronisation happens only at the group-activity entry: the
  // stage ends once every assigned participant has finished their pages.
  assert.match(personalFlowServer, /if \(allPersonalPagesDone\(game\.players, stageName, taskIndex\)\) stage\.set\("ended", true\)/);
  assert.match(personalFlowShared, /players\.every\(\(p\) => \(p\.round\.get\(personalProgressKey\(stageName\)\)\?\.index \?\? 0\) >= length\)/);
  // The ReviewQuiz page cannot be passed without passing the quiz.
  assert.match(personalFlowServer, /page === "ReviewQuiz" && player\.round\.get\("reviewQuizPassed"\) !== true/);
  // The Break page keeps its validated five-minute minimum before Round 2,
  // with a deliberate discreet corner-arrow skip that only ends the
  // participant's OWN break and is recorded for research.
  assert.match(personalFlowServer, /page === "Break" && now < progress\.startedAt \+ 300000/);
  assert.match(personalFlowServer, /if \(!request\.skipBreak\) return;/);
  assert.match(personalFlowServer, /player\.round\.set\("breakSkippedAt", now\)/);
  assert.match(personalFlowClient, /skipBreak: page === "Break" && skipBreak/);
  assert.match(personalFlowClient, /Skip the rest of the break/);
  assert.match(callbacksSource, /addPracticeRound\(game\)/);
  assert.equal((callbacksSource.match(/name: "Preparation", duration: 1e9/g) ?? []).length, 2);
  assert.doesNotMatch(callbacksSource, /name: "TaskInformation",\s+duration: TASK_INFORMATION_DURATION_SECONDS/);
  assert.doesNotMatch(callbacksSource, /name: "Break"/);
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
  assert.match(debriefingSource, /two versions of the AI facilitator, both shown as &ldquo;Facilitator\.&rdquo;/);
  assert.match(debriefingSource, /same name and appearance for both versions/);
  assert.match(debriefingSource, /jingnan\.zhang\.24@ucl\.ac\.uk/);
  assert.doesNotMatch(debriefingSource, /Withdrawal|withdrawal deadline|withdraw your data|request withdrawal/i);
  assert.doesNotMatch(debriefingSource, /const participantId =|participant ID/i);
  assert.match(debriefingSource, />Contact for this study</);
  assert.match(debriefingSource, />Academic supervisor</);
  assert.match(debriefingSource, /Echo Wan/);
  assert.match(debriefingSource, /href="mailto:e\.wan21@ic\.ac\.uk"/);
  assert.match(debriefingSource, /handleClick=\{handleFinish\}/);
  assert.match(debriefingSource, />\s*Finish study\s*</);
  assert.doesNotMatch(debriefingSource, /completionUrl|VITE_PROLIFIC_COMPLETION_URL|window\.location|Redirecting/);
  assert.doesNotMatch(`${noGamesSource}\n${gamesFullSource}`, /completion code|INSERT CODE HERE/i);
});
