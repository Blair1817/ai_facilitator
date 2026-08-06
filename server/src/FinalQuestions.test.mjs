import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const dirname = path.dirname(fileURLToPath(import.meta.url));
const appSource = readFileSync(path.join(dirname, "../../client/src/App.jsx"), "utf8");
const finalQuestionsSource = readFileSync(
  path.join(dirname, "../../client/src/intro-exit/FinalQuestions.jsx"),
  "utf8",
);
const gameSource = readFileSync(path.join(dirname, "../../client/src/Game.jsx"), "utf8");
const callbacksSource = readFileSync(path.join(dirname, "callbacks.js"), "utf8");

test("FinalQuestions is the first global exit step and is not a round stage", () => {
  assert.match(appSource, /import \{ FinalQuestions \} from "\.\/intro-exit\/FinalQuestions"/);
  assert.match(
    appSource,
    /player\.get\("ended"\) == "game ended"[\s\S]*return \[FinalQuestions, ExpFeedback, Debriefing\];/,
  );
  assert.match(
    appSource,
    /player\.get\("ended"\) == "game terminated"[\s\S]*return \[ExpFeedback, Debriefing\];/,
  );
  assert.doesNotMatch(gameSource, /FinalQuestions/);
  assert.doesNotMatch(callbacksSource, /name: "FinalQuestions"/);
  assert.doesNotMatch(finalQuestionsSource, /player\.(round|stage)\.set/);
});

test("FinalQuestions contains the five required primary questions and two optional follow-ups", () => {
  const exactQuestions = [
    "Compared with the first task, did your group change how it approached the discussion in the second task?",
    "Did anything you experienced during the first task influence how you approached the second task?",
    "How different did the automated facilitators appear across the two tasks?",
    "Which automated facilitator did you prefer overall?",
    "Which facilitator better addressed what your group needed during the discussion?",
  ];
  for (const question of exactQuestions) {
    assert.ok(finalQuestionsSource.includes(question), `missing exact question: ${question}`);
  }

  assert.match(
    finalQuestionsSource,
    /discussionApproachChanged &&[\s\S]*firstTaskCarryover &&[\s\S]*facilitatorDifference !== null &&[\s\S]*preferredFacilitator &&[\s\S]*betterNeedsFacilitator/,
  );
  assert.match(finalQuestionsSource, /value === "yes" \|\| value === "not_sure"/);
  assert.match(finalQuestionsSource, /If yes or not sure, please briefly describe what changed \(optional\)\./);
  assert.match(finalQuestionsSource, /If yes or not sure, please briefly explain what carried over from the first task \(optional\)\./);

  const textareas = [...finalQuestionsSource.matchAll(/<textarea[\s\S]*?\/>/g)];
  assert.equal(textareas.length, 1, "the reusable optional description should define one textarea");
  assert.doesNotMatch(textareas[0][0], /\brequired\b/);
});

test("FinalQuestions uses the specified stable option values and a discrete numeric 1-7 slider", () => {
  for (const value of [
    "yes",
    "no",
    "not_sure",
    "first_task",
    "second_task",
    "no_preference",
    "equally_suitable",
  ]) {
    assert.match(finalQuestionsSource, new RegExp(`value: "${value}"`));
  }

  assert.match(finalQuestionsSource, /<Slider/);
  assert.match(finalQuestionsSource, /min=\{1\}/);
  assert.match(finalQuestionsSource, /max=\{7\}/);
  assert.match(finalQuestionsSource, /step=\{1\}/);
  assert.match(finalQuestionsSource, /setFacilitatorDifference\(Number\(newValue\)\)/);
  assert.match(finalQuestionsSource, /facilitatorDifference: Number\(facilitatorDifference\)/);
});

test("the final question retains its four intended options and excludes a human facilitator", () => {
  const needsOptions = finalQuestionsSource.match(/const NEEDS_OPTIONS = \[([\s\S]*?)\];/);
  assert.ok(needsOptions, "NEEDS_OPTIONS should still define the final question options");

  for (const option of [
    '{ value: "first_task", label: "The facilitator in the first task" }',
    '{ value: "second_task", label: "The facilitator in the second task" }',
    '{ value: "equally_suitable", label: "They were about equally suitable" }',
    '{ value: "not_sure", label: "Not sure" }',
  ]) {
    assert.ok(needsOptions[1].includes(option), `missing final-question option: ${option}`);
  }
  assert.doesNotMatch(needsOptions[1], /human facilitator/i);
});

test("FinalQuestions stores one participant-level payload before advancing independently", () => {
  assert.match(finalQuestionsSource, /submittingRef\.current/);
  assert.match(finalQuestionsSource, /player\.set\("finalQuestions", \{/);
  for (const key of [
    "discussionApproachChanged",
    "discussionApproachChangeDescription",
    "firstTaskCarryover",
    "firstTaskCarryoverDescription",
    "facilitatorDifference",
    "preferredFacilitator",
    "betterNeedsFacilitator",
  ]) {
    assert.match(finalQuestionsSource, new RegExp(`\\b${key}\\b`));
  }
  assert.ok(
    finalQuestionsSource.indexOf('player.set("finalQuestions"') < finalQuestionsSource.indexOf("next();"),
    "participant-level data must be written before advancing",
  );
  assert.doesNotMatch(finalQuestionsSource, /usePlayers|useRound|useStage|player\.stage\.set\("submit"/);
});
