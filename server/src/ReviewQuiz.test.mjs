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
const personalFlowClientSource = readFileSync(path.join(dirname, "../../client/src/PersonalFlow.jsx"), "utf8");
const tlxSource = readFileSync(path.join(dirname, "../../client/src/intro-exit/TLX.jsx"), "utf8");
const subjectiveSurveySource = readFileSync(path.join(dirname, "../../client/src/intro-exit/SubjectiveSurvey.jsx"), "utf8");
const appSource = readFileSync(path.join(dirname, "../../client/src/App.jsx"), "utf8");
const overallInstructionsSource = readFileSync(path.join(dirname, "../../client/src/intro-exit/OverallInstructions.jsx"), "utf8");
const discussionSource = readFileSync(path.join(dirname, "../../client/src/stages/Discussion.jsx"), "utf8");
const playerSpecificInfoSource = readFileSync(path.join(dirname, "../../client/src/components/PlayerSpecificInfo.jsx"), "utf8");
const practiceClientSource = readFileSync(path.join(dirname, "../../client/src/practice/PracticeOnboarding.jsx"), "utf8");
const practiceServerSource = readFileSync(path.join(dirname, "PracticeOnboarding.mjs"), "utf8");
const practiceSharedSource = readFileSync(path.join(dirname, "../../shared/practice.mjs"), "utf8");
const treatmentsSource = readFileSync(path.join(dirname, "../../.empirica/treatments.yaml"), "utf8");
const personalFlowShared = readFileSync(path.join(dirname, "../../shared/personalFlow.mjs"), "utf8");
const hptConfig = JSON.parse(readFileSync(path.join(dirname, "HPTConfig.json"), "utf8"));

const SHORT_DECISION_RULE = "None of the listed drawbacks would rule out an option as a host. Treat each strength and drawback as equally important, then choose the best host overall.";
const TASK_OBJECTIVES = {
  A: "Choose the best city to host the International Youth Games. Give equal weight to each listed strength and drawback. A drawback does not automatically rule out a city.",
  B: "Choose the best university campus to host the Global Innovation Summit. Give equal weight to each listed strength and drawback. A drawback does not automatically rule out a campus.",
};
const EVIDENCE_RULE = "Use only the facts provided, without outside knowledge or assumptions.";
const INFORMATION_DIFFERENCE_NOTICE = "Some information may be different from what other group members see.";

// Source transcription is researcher-only and is not loaded by the experiment.
const revisedMaterials = JSON.parse(readFileSync(path.join(dirname, "../test/fixtures/hidden-profile-valence-2026-10-25.json"), "utf8"));
const PROOFREAD_FACTS = Object.fromEntries(revisedMaterials.tasks.map(({ taskVersion, facts }) => [
  taskVersion,
  Object.fromEntries(["Common", "P1", "P2", "P3"].map((visibility, index) => [
    ["shared", "Green", "Blue", "Pink"][index],
    facts.filter((fact) => fact.visibility === visibility).map((fact) => fact.text),
  ])),
]));

function facts(markdown) {
  return markdown.split("\n").filter((line) => line.startsWith("- ")).map((line) => line.slice(2));
}

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
  assert.equal(getReviewQuiz("A").questions.find((question) => question.id === "discussionMinutes").correctAnswer, "15");
  assert.equal(getReviewQuiz("B").questions.find((question) => question.id === "discussionMinutes").correctAnswer, "15");
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
  assert.match(hptConfig.tasks[0].generalInfo, /Task A: Choose a host city/);
  assert.match(hptConfig.tasks[0].generalInfo, /Use only the facts provided, without outside knowledge or assumptions\./);
  assert.match(hptConfig.tasks[1].generalInfo, /Task B: Choose a host campus/);
  assert.match(hptConfig.tasks[1].generalInfo, /Use only the facts provided, without outside knowledge or assumptions\./);
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
  assert.equal(cleared.objective, "option4");
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
  assert.equal(getReviewQuizRemediation("A", ["outsideKnowledge"])[0].content, EVIDENCE_RULE);
  assert.equal(getReviewQuizRemediation("A", ["objective"])[0].content, TASK_OBJECTIVES.A);
  assert.equal(getReviewQuizRemediation("B", ["objective"])[0].content, TASK_OBJECTIVES.B);
});

test("taskVersion selection fails closed for every non-canonical value", () => {
  for (const invalidVersion of [undefined, null, "", "a", "C", 0, 1]) {
    assert.equal(getReviewQuiz(invalidVersion), null);
    assert.throws(() => evaluateReviewQuiz(invalidVersion, {}), /Unsupported ReviewQuiz taskVersion/);
    assert.throws(() => getReviewQuizRemediation(invalidVersion, []), /Unsupported ReviewQuiz taskVersion/);
  }
});

test("both Rounds implement the approved task lifecycle in order", () => {
  const round1Stages = callbacksSource.slice(
    callbacksSource.indexOf('round1.addStage({ name: "Preparation"'),
    callbacksSource.indexOf("const round2 = game.addRound("),
  );
  const round2Stages = callbacksSource.slice(
    callbacksSource.indexOf('round2.addStage({ name: "Preparation"'),
    callbacksSource.indexOf("// MIGRATED from old 2nd (TEMP-BE-007"),
  );
  for (const stages of [round1Stages, round2Stages]) {
    const orderedTokens = [
      'name: "Preparation"',
      'name: "Task"',
      'name: "FinalDecision"',
      'name: "Followup"',
    ];
    let previousIndex = -1;
    for (const token of orderedTokens) {
      const index = stages.indexOf(token);
      assert.ok(index > previousIndex, `${token} must occur in lifecycle order`);
      previousIndex = index;
    }
    assert.doesNotMatch(stages, /Walkthrough|IceBreaker|PracticeIcebreaker|Introduction/);
  }

  // The within-stage page lifecycle lives in the shared personal-flow config.
  assert.match(personalFlowShared, /export const PREPARATION_PAGES = \["TaskInformation", "ReviewQuiz", "InitialDecision"\]/);
  assert.match(personalFlowShared, /"IndividualAssessment"\]\), "TLX", "SubjectiveSurvey",/);
  assert.match(personalFlowShared, /taskIndex === 0 \? \["Break"\] : \["FinalQuestions", "ExpFeedback", "Debriefing"\]/);
  // Break is a Round 1 Followup page, not a stage.
  assert.doesNotMatch(callbacksSource, /name: "Break"/);
  assert.match(callbacksSource, /name: "Task",\s+duration: gameDuration \* 60/);
  assert.equal((callbacksSource.match(/name: "FinalDecision",\s+duration: GROUP_DECISION_SECONDS/g) ?? []).length, 2);
  assert.doesNotMatch(callbacksSource, /heldStagePauseTransition|heldStageCompletionTransitions|breakProgressRequest/);
  assert.doesNotMatch(callbacksSource, /365 \* 24 \* 60 \* 60/);
  assert.match(treatmentsSource, /gameDuration:\s+15/);
  assert.doesNotMatch(round2Stages, /name: "Break"/);
});

test("client routes ReviewQuiz, guards double-submit, preserves drafts locally, and stores only pass completion", () => {
  assert.match(gameSource, /\["Preparation", "Followup"\]\.includes\(stageName\)\) return <PersonalFlow/);
  assert.match(personalFlowClientSource, /import \{ ReviewQuiz \} from "\.\/stages\/ReviewQuiz"/);
  assert.match(personalFlowClientSource, /const components = \{ TaskInformation: Introduction, ReviewQuiz, InitialDecision/);
  assert.match(reviewQuizSource, /round\?\.get\("taskVersion"\)/);
  assert.match(reviewQuizSource, /if \(evaluation\.allCorrect\)[\s\S]*if \(onNext\) onNext\(\); else player\.stage\.set\("submit", true\)/);
  assert.match(reviewQuizSource, /processingRef\.current/);
  assert.match(reviewQuizSource, /disabled=\{!isComplete \|\| isProcessing\}/);
  assert.match(reviewQuizSource, /setIncorrectQuestionIds\(evaluation\.incorrectQuestionIds\)/);
  assert.doesNotMatch(reviewQuizSource, /clearIncorrectReviewQuizAnswers/);
  assert.match(reviewQuizSource, /Check answers again/);
  assert.match(reviewQuizSource, /View instructions/);
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
  assert.equal([...callbacksSource.matchAll(/name: "Walkthrough"/g)].length, 0);
  assert.match(callbacksSource, /addPracticeRound\(game, 2\)/);
  assert.doesNotMatch(gameSource, /Walkthrough|IceBreakerStartCountdown|IceBreakerEndCountdown|PracticeIcebreaker/);
  assert.match(personalFlowClientSource, /TaskInformation: Introduction, ReviewQuiz, InitialDecision/);
});

test("the four-part Task Instructions open before each formal Task Information page, not inside ReviewQuiz", () => {
  const instructionText = [
    "Task Instructions",
    "1. Read the task information",
    "Read the Task Information carefully. You will then complete a short Review Quiz to check your understanding of the task.",
    "2. Make an initial decision",
    "After the Review Quiz, choose the option you initially consider most suitable and rate your confidence from 0 to 100.",
    "3. Discuss with your group",
    "in a group of three for up to 15 minutes",
    "4. Record the final decision",
    "each group member will independently report the option they believe the group agreed on",
    "If you do not personally agree, you will also provide your own preferred option and briefly explain your reasons on the same page.",
  ];
  for (const text of instructionText) assert.match(introductionSource, new RegExp(text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  assert.match(introductionSource, /form: "taskInstructions"/);
  assert.match(introductionSource, /roundId: round\?\.id/);
  assert.match(introductionSource, /taskInstructionsRef\.current\.showModal\(\)/);
  assert.doesNotMatch(introductionSource, /taskIndex"\) === 0/);
  assert.match(introductionSource, /Continue to Task Information/);
  assert.equal((introductionSource.match(/<h2 className="text-lg font-semibold text-gray-900">/g) || []).length, 4);
  assert.ok(
    introductionSource.indexOf("</dialog>") < introductionSource.indexOf("<RenderMarkdown markdownText={taskBackground}"),
    "Task Information must remain on the page outside the Task Instructions dialog",
  );
  assert.doesNotMatch(reviewQuizSource, /Task Instructions|taskInstructionsRef|taskInstructionsSeen|Before you begin|Start questions/);
  assert.doesNotMatch(introductionSource, /Task Report|If all three group members report the same group choice|If the reported choices do not match|\bprivate\b/i);
});

test("active Overall Instructions disclose the optional 15-minute formal discussion before ReviewQuiz", () => {
  assert.match(overallInstructionsSource, /You will first complete a short Practice activity\./);
  assert.match(overallInstructionsSource, /discuss the options for up to 15 minutes/);
  assert.doesNotMatch(overallInstructionsSource, /3[- ]minute/i);

  for (const taskVersion of ["A", "B"]) {
    const quiz = getReviewQuiz(taskVersion);
    assert.equal(quiz.questions.find((question) => question.id === "discussionMinutes").correctAnswer, "15");
    assert.equal(quiz.remediation.discussionDuration.content, "The group discussion can last up to 15 minutes.");
  }

  assert.match(appSource, /return \[OverallInstructions, RecruitmentBootstrap\];/);
  assert.match(personalFlowShared, /export const PREPARATION_PAGES = \["TaskInformation", "ReviewQuiz", "InitialDecision"\]/);
  assert.match(practiceSharedSource, /discussionSeconds:\s*240/);
  assert.match(treatmentsSource, /gameDuration:\s+15/);
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
  assert.match(callbacksSource, /isCurrent: \(\) => canPublishFacilitatorResult\(game, logEntry\)/);
  assert.match(callbacksSource, /if \(!budget\.check\(\)\) return null/);
  assert.match(callbacksSource, /Discarded stale Validator result after the originating Discussion stage ended/);
  assert.match(callbacksSource, /Discarded stale repair Validator result after the originating Discussion stage ended/);
});

test("Discussion lasts 15 minutes and retains unanimous participant early-ready wiring", () => {
  assert.match(treatmentsSource, /gameDuration:\s+15/);
  assert.match(treatmentsSource, /phase1Duration:\s+5/);
  assert.equal([...callbacksSource.matchAll(/name: "Task",\s+duration: gameDuration \* 60/g)].length, 2);
  assert.match(callbacksSource, /now \+ gameDuration \* 60 \* 1000/);
  assert.match(discussionSource, /player\.stage\.set\("submit", !isReady\)/);
  assert.match(discussionSource, /ReadyToDecidePanel|Ready to make the final decision/);
  assert.match(callbacksSource, /shouldEvaluateCheckpoint\(\{/);
});

test("formal backgrounds use the approved short equal-importance rule without a scoring rule", () => {
  const expectedBackground = {
    A: `# Task A: Choose a host city

Your group will choose a city to host the International Youth Games. The three options are Talwick, Rovenna and Meridia.

The International Youth Sports Council holds the Games every four years. All three cities meet the essential requirements for venues, public safety, finance and legal compliance.

**How to decide**

${SHORT_DECISION_RULE}

${EVIDENCE_RULE}`,
    B: `# Task B: Choose a host campus

Your group will choose a university campus to host the Global Innovation Summit. The three options are Halden University, Fenwick University and Norvale University.

The International Innovation Council holds the Summit every four years. All three campuses meet the essential requirements for facilities, public safety, finance and legal compliance.

**How to decide**

${SHORT_DECISION_RULE}

${EVIDENCE_RULE}`,
  };

  for (const task of hptConfig.tasks) {
    const background = task.generalInfo.split(/\n(?=## )/)[0].trim();
    assert.equal(background, expectedBackground[task.taskVersion]);
    assert.equal((background.match(/\*\*How to decide\*\*/g) || []).length, 1);
    assert.doesNotMatch(background, /^## How to decide$/m);
    assert.doesNotMatch(background, /points system|positive-minus-negative|subtract .* drawback|scoring rule/i);
  }

  for (const version of ["A", "B"]) {
    assert.equal(getReviewQuiz(version).remediation.evidenceRule.content, EVIDENCE_RULE);
    assert.equal(getReviewQuiz(version).remediation.objective.content, TASK_OBJECTIVES[version]);
    assert.deepEqual(
      getReviewQuiz(version).questions.slice(0, 4).map(({ id, correctAnswer }) => ({ id, correctAnswer })),
      [
        { id: "outsideKnowledge", correctAnswer: "no" },
        { id: "alternativeCount", correctAnswer: "3" },
        { id: "mandatoryRequirements", correctAnswer: "yes" },
        { id: "discussionMinutes", correctAnswer: "15" },
      ],
    );
  }
  const objectiveA = getReviewQuiz("A").questions.find((question) => question.id === "objective");
  const objectiveB = getReviewQuiz("B").questions.find((question) => question.id === "objective");
  assert.equal(objectiveA.correctAnswer, "option2");
  assert.equal(objectiveB.correctAnswer, "option4");
  assert.match(objectiveA.options.find((option) => option.value === objectiveA.correctAnswer).label, /International Youth Games/);
  assert.match(objectiveB.options.find((option) => option.value === objectiveB.correctAnswer).label, /Global Innovation Summit/);
});

test("all proofread formal facts and the 9 plus 7 allocation match exactly", () => {
  assert.equal(hptConfig.tasks.length, 2);
  assert.deepEqual(hptConfig.tasks[0].decisionOptions.map((option) => option.label), ["Talwick", "Rovenna", "Meridia"]);
  assert.deepEqual(hptConfig.tasks[1].decisionOptions.map((option) => option.label), ["Norvale University", "Halden University", "Fenwick University"]);
  for (const task of hptConfig.tasks) {
    const expected = PROOFREAD_FACTS[task.taskVersion];
    assert.equal(task.playerConfig.length, 3);
    assert.deepEqual(task.playerConfig.map((profile) => profile.playerName), ["Green", "Blue", "Pink"]);
    assert.deepEqual(task.playerConfig.map((profile) => profile.hexCode), ["39BC21", "206EEF", "F90494"]);
    assert.deepEqual(task.generalInfo.match(/^## .+$/gm).map((heading) => heading.slice(3)), task.decisionOptions.map((option) => option.label));
    assert.deepEqual(facts(task.generalInfo), expected.shared);
    assert.equal(expected.shared.length, 9);
    for (const profile of task.playerConfig) {
      assert.deepEqual(profile.playerContent.match(/^## .+$/gm).map((heading) => heading.slice(3)), task.decisionOptions.map((option) => option.label));
      assert.deepEqual(facts(profile.playerContent), expected[profile.playerName]);
      assert.equal(expected[profile.playerName].length, 7);
      assert.equal(expected.shared.length + expected[profile.playerName].length, 16);
    }
  }
  assert.equal(hptConfig.tasks.flatMap((task) => facts(task.generalInfo)).length
    + hptConfig.tasks.flatMap((task) => task.playerConfig.flatMap((profile) => facts(profile.playerContent))).length, 60);
});

test("Practice and formal reports use the weak notice and merge facts without ownership labels", () => {
  assert.match(playerSpecificInfoSource, new RegExp(INFORMATION_DIFFERENCE_NOTICE.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  assert.match(playerSpecificInfoSource, /`\*\*\$\{INFORMATION_DIFFERENCE_NOTICE\}\*\*\\n\\n/);
  assert.match(playerSpecificInfoSource, /You may discuss the information in your report with your group\./);
  assert.match(playerSpecificInfoSource, /const combinedBody = \[section\.body, additionalFacts\]/);
  assert.match(playerSpecificInfoSource, /<RenderMarkdown markdownText=\{reportMarkdown\}/);
  assert.match(practiceClientSource, new RegExp(INFORMATION_DIFFERENCE_NOTICE.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  for (const source of [playerSpecificInfoSource, practiceClientSource, practiceServerSource]) {
    assert.doesNotMatch(source, /Your report contains some, but not all|Other group members have information that is not in your report/);
  }
  assert.doesNotMatch(playerSpecificInfoSource, /Shared facts|Facts everyone has|Unique facts|Only you|Your Additional Information/);
  assert.doesNotMatch(practiceServerSource, /You may not have exactly the same information/);
});
