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
const transitionSource = readFileSync(
  path.join(dirname, "../../client/src/components/StageTransition.jsx"),
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

test("both rounds contain a server-timed 10-second transition before the existing IceBreaker stage", () => {
  assert.match(callbacksSource, /const TRANSITION_TO_ICEBREAKER_DURATION_SECONDS = 10;/);
  assert.equal([...callbacksSource.matchAll(/name: "TransitionToIceBreaker"/g)].length, 2);

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
      /addReviewQuizStage\([^)]+\);[\s\S]*name: "TransitionToIceBreaker",\s+duration: TRANSITION_TO_ICEBREAKER_DURATION_SECONDS[\s\S]*name: "Introduction"/,
    );
  }

  assert.match(gameSource, /stageName == "TransitionToIceBreaker"/);
  assert.match(gameSource, /<StageTransition/);
  assert.match(gameSource, /Discussion Preparation/);
  assert.match(transitionSource, /<Timer \/>/);
  assert.doesNotMatch(transitionSource, /Button|setTimeout|Continue|Skip/);
  assert.match(reviewQuizSource, /player\.stage\.set\("submit", true\)/);
});

test("SubjectiveSurvey requires every visible response without blocking hidden condition-specific questions", () => {
  assert.match(surveySource, /const facilitation = round\?\.get\("facilitation"\)/);
  assert.match(surveySource, /alwaysVisibleComplete = \[question1, question2, question3, question4, question5, question6\]/);
  assert.match(surveySource, /playerName != "Facilitator" \|\| String\(question7\)\.trim\(\)/);
  assert.match(
    surveySource,
    /facilitation == "none" \|\|[\s\S]*playerName == "Facilitator" \|\|[\s\S]*\[question8, question9, question10, question11, question12\]/,
  );
  assert.match(surveySource, /playerName == "Facilitator" \|\| String\(question13\)\.trim\(\)/);
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
