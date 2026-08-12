import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import {
  REVIEW_QUIZZES,
  clearIncorrectReviewQuizAnswers,
  evaluateReviewQuiz,
  getReviewQuiz,
  getReviewQuizRemediation,
} from "../../client/src/stages/reviewQuizConfig.js";

const dirname = path.dirname(fileURLToPath(import.meta.url));
const callbacksSource = readFileSync(path.join(dirname, "callbacks.js"), "utf8");
const gameSource = readFileSync(path.join(dirname, "../../client/src/Game.jsx"), "utf8");
const reviewQuizSource = readFileSync(path.join(dirname, "../../client/src/stages/ReviewQuiz.jsx"), "utf8");
const introductionSource = readFileSync(path.join(dirname, "../../client/src/intro-exit/Introduction.jsx"), "utf8");
const userInterfaceSource = readFileSync(path.join(dirname, "../../client/src/intro-exit/UserInterface.jsx"), "utf8");
const tlxSource = readFileSync(path.join(dirname, "../../client/src/intro-exit/TLX.jsx"), "utf8");
const subjectiveSurveySource = readFileSync(path.join(dirname, "../../client/src/intro-exit/SubjectiveSurvey.jsx"), "utf8");
const appSource = readFileSync(path.join(dirname, "../../client/src/App.jsx"), "utf8");
const discussionSource = readFileSync(path.join(dirname, "../../client/src/stages/Discussion.jsx"), "utf8");
const treatmentsSource = readFileSync(path.join(dirname, "../../.empirica/treatments.yaml"), "utf8");
const hptConfig = JSON.parse(readFileSync(path.join(dirname, "HPTConfig.json"), "utf8"));

function correctAnswers(taskVersion) {
  return Object.fromEntries(
    getReviewQuiz(taskVersion).questions.map((question) => [question.id, question.correctAnswer]),
  );
}

test("Task A and Task B each define the five retained ReviewQuiz questions under canonical taskVersion", () => {
  assert.deepEqual(Object.keys(REVIEW_QUIZZES), ["A", "B"]);
  assert.equal(getReviewQuiz("A").questions.length, 5);
  assert.equal(getReviewQuiz("B").questions.length, 5);
  assert.doesNotMatch(JSON.stringify(REVIEW_QUIZZES), /sameInformation|Must all group members have exactly the same information/);
  assert.equal(getReviewQuiz("A").questions.find((question) => question.id === "discussionMinutes").correctAnswer, "10");
  assert.equal(getReviewQuiz("B").questions.find((question) => question.id === "discussionMinutes").correctAnswer, "10");
  assert.match(getReviewQuiz("A").scenario, /International Youth Games/);
  assert.doesNotMatch(JSON.stringify(getReviewQuiz("A")), /International Sports Federation/);
  assert.match(getReviewQuiz("B").scenario, /Global Innovation Summit/);
  assert.match(getReviewQuiz("B").scenario, /Global Innovation Summit/);
  assert.doesNotMatch(JSON.stringify(REVIEW_QUIZZES), /12 minutes|"12"/);
});

test("HPT briefings use the same canonical Task A/B identities as ReviewQuiz", () => {
  const participantFacingText = [
    hptConfig.tasks[0].generalInfo,
    hptConfig.tasks[1].generalInfo,
  ].join("\n");

  assert.doesNotMatch(participantFacingText, /International Sports Federation|Eldoron|Myloria|Cragnio|Academic Summit Campus|An academic organisation/);
  assert.match(hptConfig.tasks[0].generalInfo, /Task A: International Youth Games host city/);
  assert.match(hptConfig.tasks[0].generalInfo, /Do not use outside knowledge or assumptions about the cities/);
  assert.match(hptConfig.tasks[1].generalInfo, /Task B: Global Innovation Summit host campus/);
  assert.match(hptConfig.tasks[1].generalInfo, /Do not use outside knowledge or assumptions about the universities/);
  assert.doesNotMatch(
    JSON.stringify(hptConfig.tasks.flatMap((task) => task.playerConfig)),
    /Your Private Report|Only you can see|Share any information|different report|same information/i,
  );
});

test("each question is scored individually at runtime and any incorrect answer prevents passing", () => {
  const answers = correctAnswers("A");
  answers.outsideKnowledge = "yes";
  answers.objective = "option1";
  const evaluation = evaluateReviewQuiz("A", answers);

  assert.equal(evaluation.allCorrect, false);
  assert.equal(evaluation.questionCorrectness.outsideKnowledge, false);
  assert.equal(evaluation.questionCorrectness.objective, false);
  assert.equal(evaluation.questionCorrectness.alternativeCount, true);
  assert.deepEqual(evaluation.incorrectQuestionIds, ["outsideKnowledge", "objective"]);

  const correctEvaluation = evaluateReviewQuiz("A", correctAnswers("A"));
  assert.equal(correctEvaluation.allCorrect, true);
  assert.deepEqual(correctEvaluation.incorrectQuestionIds, []);
});

test("failed submission clearing removes only incorrect answers and preserves correct answers", () => {
  const answers = correctAnswers("B");
  answers.outsideKnowledge = "yes";
  answers.discussionMinutes = "12";
  const evaluation = evaluateReviewQuiz("B", answers);
  const cleared = clearIncorrectReviewQuizAnswers(answers, evaluation.incorrectQuestionIds);

  assert.equal(cleared.outsideKnowledge, undefined);
  assert.equal(cleared.discussionMinutes, undefined);
  assert.equal(cleared.alternativeCount, "3");
  assert.equal(cleared.mandatoryRequirements, "yes");
  assert.equal(cleared.objective, "option3");
  assert.equal(answers.outsideKnowledge, "yes", "the helper must not mutate the previous local state object");
});

test("all five questions map to canonical remediation, duplicate sources collapse, and tasks stay isolated", () => {
  for (const taskVersion of ["A", "B"]) {
    const quiz = getReviewQuiz(taskVersion);
    for (const question of quiz.questions) {
      const sections = getReviewQuizRemediation(taskVersion, [question.id]);
      assert.equal(sections.length, 1, `${taskVersion}.${question.id} must have one remediation source`);
      assert.ok(sections[0].content.length > 0);
    }
  }

  const combined = getReviewQuizRemediation("A", ["alternativeCount", "mandatoryRequirements", "objective"]);
  assert.deepEqual(combined.map((section) => section.key), ["taskOverview", "objective"]);
  assert.doesNotMatch(JSON.stringify(getReviewQuiz("A").remediation), /International Innovation Council|Global Innovation Summit/);
  assert.doesNotMatch(JSON.stringify(getReviewQuiz("B").remediation), /International Youth Sports Council|International Youth Games/);
  assert.match(getReviewQuizRemediation("A", ["outsideKnowledge"])[0].content, /Do not use outside knowledge/);
  assert.match(getReviewQuizRemediation("B", ["objective"])[0].content, /judge how the provided non-critical facts affect each campus's suitability and then select/);
});

test("taskVersion selection fails closed for every non-canonical value", () => {
  for (const invalidVersion of [undefined, null, "", "a", "C", 0, 1]) {
    assert.equal(getReviewQuiz(invalidVersion), null);
    assert.throws(() => evaluateReviewQuiz(invalidVersion, {}), /Unsupported ReviewQuiz taskVersion/);
    assert.throws(() => getReviewQuizRemediation(invalidVersion, []), /Unsupported ReviewQuiz taskVersion/);
  }
});

test("both Rounds implement the approved task lifecycle in order", () => {
  assert.equal([...callbacksSource.matchAll(/addReviewQuizStage\(round1\)/g)].length, 1);
  assert.equal([...callbacksSource.matchAll(/addReviewQuizStage\(round2\)/g)].length, 1);

  const round1Stages = callbacksSource.slice(callbacksSource.indexOf('round1.addStage({ name: "TaskInformation"'), callbacksSource.indexOf("const round2 = game.addRound("));
  const round2Stages = callbacksSource.slice(callbacksSource.indexOf('round2.addStage({ name: "TaskInformation"'), callbacksSource.indexOf("// MIGRATED from old 2nd (TEMP-BE-007"));
  for (const stages of [round1Stages, round2Stages]) {
    const orderedTokens = [
      'name: "TaskInformation"',
      'name: "Walkthrough"',
      "addReviewQuizStage(",
      'name: "IceBreakerStartCountdown"',
      'name: "Introduction"',
      'name: "IceBreakerEndCountdown"',
      'name: "InitialDecision"',
      'name: "Task"',
      'name: "FinalDecision"',
      'name: "IndividualAssessment"',
      'name: "TLX"',
      'name: "SubjectiveSurvey"',
    ];
    let previousIndex = -1;
    for (const token of orderedTokens) {
      const index = stages.indexOf(token);
      assert.ok(index > previousIndex, `${token} must occur in lifecycle order`);
      previousIndex = index;
    }
  }

  assert.equal([...callbacksSource.matchAll(/name: "Break"/g)].length, 1);
  assert.match(callbacksSource, /const BREAK_STAGE_SAFETY_DURATION_SECONDS = 24 \* 60 \* 60;/);
  assert.match(callbacksSource, /const TASK_INFORMATION_DURATION_SECONDS = 10 \* 60;/);
  assert.match(callbacksSource, /const WALKTHROUGH_DURATION_SECONDS = 10 \* 60;/);
  assert.match(callbacksSource, /const ICEBREAKER_TRANSITION_DURATION_SECONDS = 10;/);
  assert.match(callbacksSource, /const REVIEW_QUIZ_SAFETY_DURATION_SECONDS = 24 \* 60 \* 60;/);
  assert.doesNotMatch(callbacksSource, /heldStagePauseTransition|heldStageCompletionTransitions|breakProgressRequest/);
  assert.doesNotMatch(callbacksSource, /365 \* 24 \* 60 \* 60/);
  assert.match(callbacksSource, /const TLX_DURATION_SECONDS = 10 \* 60;/);
  assert.match(callbacksSource, /const SUBJECTIVE_SURVEY_DURATION_SECONDS = 10 \* 60;/);
  assert.match(callbacksSource, /const BREAK_DURATION_SECONDS = 300;/);
  assert.match(round1Stages, /name: "SubjectiveSurvey"[\s\S]*name: "Break",\s+duration: BREAK_STAGE_SAFETY_DURATION_SECONDS/);
  assert.doesNotMatch(round2Stages, /name: "Break"/);
  assert.ok(callbacksSource.indexOf('round1.addStage({ name: "Break"') < callbacksSource.indexOf('round2.addStage({ name: "TaskInformation"'));
});

test("client routes ReviewQuiz, guards double-submit, preserves drafts locally, and stores only pass completion", () => {
  assert.match(gameSource, /stageName == "ReviewQuiz"/);
  assert.match(gameSource, /<ReviewQuiz key=\{roundStageKey\}/);
  assert.match(reviewQuizSource, /round\?\.get\("taskVersion"\)/);
  assert.match(reviewQuizSource, /if \(evaluation\.allCorrect\)[\s\S]*player\.stage\.set\("submit", true\)/);
  assert.match(reviewQuizSource, /processingRef\.current/);
  assert.match(reviewQuizSource, /disabled=\{!isComplete \|\| isProcessing\}/);
  assert.match(reviewQuizSource, /clearIncorrectReviewQuizAnswers/);
  assert.match(reviewQuizSource, /Return to Review Quiz/);
  assert.match(reviewQuizSource, /usePersistentDraft/);
  assert.match(reviewQuizSource, /player\.round\.set\("reviewQuizPassed", true\)/);
  assert.doesNotMatch(reviewQuizSource, /reviewQuizAttempts|reviewQuizResult|attemptNumber|submittedAt|questionCorrectness/);
  assert.doesNotMatch(reviewQuizSource, /retryCount|maxRetries|maxAttempts/);
  assert.doesNotMatch(readFileSync(path.join(dirname, "../../client/src/stages/reviewQuizConfig.js"), "utf8"), /addReviewQuizAttempt|attemptCount|submittedAt|passedAt/);
});

test("global intro keeps only one-time global steps and round screens use round context", () => {
  assert.match(appSource, /return \[OverallInstructions, RecruitmentBootstrap\];/);
  assert.doesNotMatch(appSource, /return \[[^\]]*(Introduction|UserInterface|AttentionCheck)/);
  assert.match(introductionSource, /round\?\.get\("generalInfo"\)/);
  assert.match(introductionSource, /taskBackgroundOnly\(generalInfo\)/);
  assert.match(introductionSource, /<RenderMarkdown markdownText=\{taskBackground\}/);
  assert.match(introductionSource, /round\?\.get\("taskVersion"\)/);
  assert.doesNotMatch(introductionSource, /IntroContent/);
  assert.equal([...callbacksSource.matchAll(/name: "Walkthrough"/g)].length, 2);
  assert.doesNotMatch(userInterfaceSource, /facilitation\s*=/);
});

test("round questionnaires preserve payloads on player.round and leave the global exit", () => {
  assert.match(tlxSource, /player\.round\.set\("tlxSurvey"/);
  assert.match(subjectiveSurveySource, /player\.round\.set\("subjectiveSurvey"/);
  assert.match(tlxSource, /player\.stage\.set\("submit", true\)/);
  assert.match(subjectiveSurveySource, /player\.stage\.set\("submit", true\)/);
  assert.match(appSource, /return \[ExpFeedback, Debriefing\];/);
  assert.doesNotMatch(appSource, /return \[[^\]]*(TLX|SubjectiveSurvey)/);
});

test("stale async Discussion results are discarded after their originating stage or Round ends", () => {
  assert.match(callbacksSource, /game\.currentRound\?\.id !== originatingRoundId/);
  assert.match(callbacksSource, /game\.currentStage\?\.id !== originatingStageId/);
  assert.match(callbacksSource, /Discarded stale AI result after the originating Discussion stage ended/);
  assert.match(callbacksSource, /Discarded stale LLM detector result after the originating Discussion stage ended/);
});

test("Discussion remains 10 minutes and retains unanimous participant early-ready wiring", () => {
  assert.match(treatmentsSource, /gameDuration:\s+10/);
  assert.equal([...callbacksSource.matchAll(/name: "Task",\s+duration: gameDuration \* 60/g)].length, 2);
  assert.match(callbacksSource, /now \+ gameDuration \* 60 \* 1000/);
  assert.match(discussionSource, /player\.stage\.set\("submit", !isReady\)/);
  assert.match(discussionSource, /ReadyToDecidePanel|Ready to make the final decision/);
  assert.match(callbacksSource, /shouldEvaluateCheckpoint\(\{/);
});

test("existing HPT fact-bank shape and private-profile assignment remain intact", () => {
  assert.equal(hptConfig.tasks.length, 2);
  assert.deepEqual(hptConfig.tasks[0].decisionOptions.map((option) => option.label), ["Talwick", "Rovenna", "Meridia"]);
  assert.deepEqual(hptConfig.tasks[1].decisionOptions.map((option) => option.label), ["Norvale", "Halden", "Fenwick"]);
  for (const task of hptConfig.tasks) {
    assert.equal(task.playerConfig.length, 3);
    assert.deepEqual(task.playerConfig.map((profile) => profile.playerName), ["Green", "Blue", "Pink"]);
    assert.deepEqual(task.playerConfig.map((profile) => profile.hexCode), ["39BC21", "206EEF", "F90494"]);
    assert.deepEqual(task.playerConfig.map((profile) => (profile.playerContent.match(/\n- /g) || []).length), [7, 7, 7]);
  }
});
