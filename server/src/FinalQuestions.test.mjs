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

test("FinalQuestions retains only the three approved primary questions and one optional follow-up", () => {
  const exactQuestions = [
    "Did anything you experienced during the first task influence how you approached the second task?",
    "How different did the automated facilitators appear across the two tasks?",
    "Which automated facilitator did you prefer overall?",
  ];
  for (const question of exactQuestions) {
    assert.ok(finalQuestionsSource.includes(question), `missing exact question: ${question}`);
  }

  assert.match(
    finalQuestionsSource,
    /firstTaskCarryover &&[\s\S]*facilitatorDifference !== null &&[\s\S]*preferredFacilitator/,
  );
  assert.match(finalQuestionsSource, /value === "yes" \|\| value === "not_sure"/);
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

test("obsolete final questions and their payload keys are absent", () => {
  assert.doesNotMatch(finalQuestionsSource, /NEEDS_OPTIONS|betterNeedsFacilitator|discussionApproachChanged|discussionApproachChangeDescription/);
});

test("FinalQuestions stores one participant-level payload and advances after storage acknowledgement", () => {
  assert.match(finalQuestionsSource, /submittingRef\.current/);
  assert.match(finalQuestionsSource, /player\.set\("finalQuestions", \{/);
  for (const key of [
    "firstTaskCarryover",
    "firstTaskCarryoverDescription",
    "facilitatorDifference",
    "preferredFacilitator",
  ]) {
    assert.match(finalQuestionsSource, new RegExp(`\\b${key}\\b`));
  }
  assert.match(finalQuestionsSource, /storedSubmission\?\.submissionId !== pendingSubmissionId/);
  assert.match(finalQuestionsSource, /player\.set\("finalQuestions", \{[\s\S]*submissionId/);
  assert.match(finalQuestionsSource, /clearDraftKeys\([\s\S]*next\(\);/);
  assert.doesNotMatch(finalQuestionsSource, /finalQuestionsCompletion(Request|Ack)|completionRequestRef|completionAck/);
  assert.doesNotMatch(finalQuestionsSource, /usePlayers|useRound|useStage|player\.stage\.set\("submit"/);
});
