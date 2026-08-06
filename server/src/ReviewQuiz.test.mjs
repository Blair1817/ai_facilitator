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
import { generalInfo as globalIntroContent } from "../../client/src/intro-exit/IntroContent.js";

const dirname = path.dirname(fileURLToPath(import.meta.url));
const callbacksSource = readFileSync(path.join(dirname, "callbacks.js"), "utf8");
const gameSource = readFileSync(path.join(dirname, "../../client/src/Game.jsx"), "utf8");
const reviewQuizSource = readFileSync(path.join(dirname, "../../client/src/stages/ReviewQuiz.jsx"), "utf8");
const attentionCheckSource = readFileSync(path.join(dirname, "../../client/src/intro-exit/AttentionCheck.jsx"), "utf8");
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
  assert.match(getReviewQuiz("A").scenario, /International Youth Sports Council/);
  assert.doesNotMatch(JSON.stringify(getReviewQuiz("A")), /International Sports Federation/);
  assert.match(getReviewQuiz("B").scenario, /International Innovation Council/);
  assert.match(getReviewQuiz("B").scenario, /Global Innovation Summit/);
  assert.doesNotMatch(JSON.stringify(REVIEW_QUIZZES), /12 minutes|"12"/);
});

test("global Introduction and HPT briefings use the same canonical Task A/B identities as ReviewQuiz", () => {
  const participantFacingText = [
    globalIntroContent,
    hptConfig.tasks[0].generalInfo,
    hptConfig.tasks[1].generalInfo,
  ].join("\n");

  assert.doesNotMatch(participantFacingText, /International Sports Federation|Eldoron|Myloria|Cragnio|Academic Summit Campus|An academic organisation/);
  assert.match(globalIntroContent, /The order of the tasks may vary/);
  assert.match(globalIntroContent, /International Youth Sports Council/);
  assert.match(globalIntroContent, /International Innovation Council/);
  assert.match(hptConfig.tasks[0].generalInfo, /Task A: International Youth Games host city/);
  assert.match(hptConfig.tasks[0].generalInfo, /Do not use outside knowledge or assumptions about the cities/);
  assert.match(hptConfig.tasks[1].generalInfo, /Task B: Global Innovation Summit host campus/);
  assert.match(hptConfig.tasks[1].generalInfo, /Do not use outside knowledge or assumptions about the universities/);
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

test("ReviewQuiz is created exactly once per Round, after Introduction and before InitialDecision", () => {
  assert.equal([...callbacksSource.matchAll(/addReviewQuizStage\(round1\)/g)].length, 1);
  assert.equal([...callbacksSource.matchAll(/addReviewQuizStage\(round2\)/g)].length, 1);

  const round1Stages = callbacksSource.slice(callbacksSource.indexOf('round1.addStage({ name: "transitionToIntroduction"'), callbacksSource.indexOf("const round2 = game.addRound("));
  const round2Stages = callbacksSource.slice(callbacksSource.indexOf('round2.addStage({ name: "transitionToIntroduction"'), callbacksSource.indexOf("// MIGRATED from old 2nd (TEMP-BE-007"));
  for (const stages of [round1Stages, round2Stages]) {
    assert.ok(stages.indexOf('name: "Introduction"') < stages.indexOf("addReviewQuizStage("));
    assert.ok(stages.indexOf("addReviewQuizStage(") < stages.indexOf('name: "InitialDecision"'));
  }
});

test("client routes ReviewQuiz, keeps retries local, guards double-submit, and persists no ReviewQuiz data", () => {
  assert.match(gameSource, /stageName == "ReviewQuiz"/);
  assert.match(gameSource, /<ReviewQuiz key=\{roundStageKey\}/);
  assert.match(reviewQuizSource, /round\?\.get\("taskVersion"\)/);
  assert.match(reviewQuizSource, /if \(evaluation\.allCorrect\)[\s\S]*player\.stage\.set\("submit", true\)/);
  assert.match(reviewQuizSource, /processingRef\.current/);
  assert.match(reviewQuizSource, /disabled=\{!isComplete \|\| isProcessing\}/);
  assert.match(reviewQuizSource, /clearIncorrectReviewQuizAnswers/);
  assert.match(reviewQuizSource, /Return to Review Quiz/);
  assert.doesNotMatch(reviewQuizSource, /player\.round\.set|player\.set\(|round\.set\(|game\.set\(/);
  assert.doesNotMatch(reviewQuizSource, /attemptCount|attempts\s*[:=]|submittedAt|passedAt/);
  assert.doesNotMatch(reviewQuizSource, /retryCount|maxRetries|maxAttempts/);
  assert.doesNotMatch(readFileSync(path.join(dirname, "../../client/src/stages/reviewQuizConfig.js"), "utf8"), /addReviewQuizAttempt|attemptCount|submittedAt|passedAt/);
});

test("the old global quiz is removed while the one-time global captcha remains", () => {
  assert.match(appSource, /RecruitmentBootstrap, Introduction, UserInterface, AttentionCheck/);
  assert.match(attentionCheckSource, /Security Check/);
  assert.match(attentionCheckSource, /captchaMessage/);
  assert.doesNotMatch(attentionCheckSource, /<h\d[^>]*>Review Quiz|sports facilities|infrastructure grant|const \[question1|const \[question2/);
});

test("Discussion remains 10 minutes with unchanged timer/early-ready wiring", () => {
  assert.match(treatmentsSource, /gameDuration:\s+10/);
  assert.equal([...callbacksSource.matchAll(/name: "Task",\s+duration: gameDuration \* 60/g)].length, 2);
  assert.match(callbacksSource, /now \+ gameDuration \* 60 \* 1000/);
  assert.match(discussionSource, /player\.stage\.set\("submit", !isReady\)/);
  assert.match(callbacksSource, /if \(messagesSince < 6\) return;/);
});

test("existing HPT fact-bank shape and private-profile assignment remain intact", () => {
  assert.equal(hptConfig.tasks.length, 2);
  assert.deepEqual(hptConfig.tasks[0].decisionOptions.map((option) => option.label), ["Talwick", "Rovenna", "Meridia"]);
  assert.deepEqual(hptConfig.tasks[1].decisionOptions.map((option) => option.label), ["Norvale", "Halden", "Fenwick"]);
  for (const task of hptConfig.tasks) {
    assert.equal(task.playerConfig.length, 3);
    assert.deepEqual(task.playerConfig.map((profile) => profile.playerName), ["Red", "Pink", "Green"]);
    assert.deepEqual(task.playerConfig.map((profile) => (profile.playerContent.match(/\n- /g) || []).length), [7, 7, 7]);
  }
});
