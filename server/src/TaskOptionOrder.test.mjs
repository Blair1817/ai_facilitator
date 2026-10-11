import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { initialiseTaskOptionOrder, orderTaskSections } from "./TaskOptionOrder.mjs";
import { getReviewQuiz, getReviewQuizRemediation } from "../../client/src/stages/reviewQuizConfig.js";

const { tasks } = JSON.parse(readFileSync(new URL("./HPTConfig.json", import.meta.url)));
const scope = (attrs = {}) => ({ get: (key) => attrs[key], set: (key, value) => { attrs[key] = value; } });
const facts = (text) => text.split("\n").filter((line) => line.startsWith("- ")).sort();
const headings = (text) => [...text.matchAll(/^## (.+)$/gm)].map((m) => m[1]);
const permutations = [[0,1,2], [0,2,1], [1,0,2], [1,2,0], [2,0,1], [2,1,0]];

test("every permutation aligns group options, shared reports and all three private reports without changing facts or IDs", () => {
  for (const task of tasks) for (const permutation of permutations) {
    const original = JSON.stringify(task), round = scope();
    const options = initialiseTaskOptionOrder(round, task, (options) => permutation.map((i) => options[i]));
    const labels = options.map((option) => option.label);
    assert.deepEqual(headings(round.get("generalInfo")), labels);
    assert.deepEqual(facts(round.get("generalInfo")), facts(task.generalInfo));
    assert.ok(round.get("generalInfo").includes(`The three options are ${labels[0]}, ${labels[1]} and ${labels[2]}.`));
    for (const profile of task.playerConfig) {
      const report = orderTaskSections(profile.playerContent, options);
      assert.deepEqual(headings(report), labels);
      assert.deepEqual(facts(report), facts(profile.playerContent));
    }
    assert.equal(JSON.stringify(task), original);
    assert.deepEqual(options.map((o) => o.id), permutation.map((i) => task.decisionOptions[i].id));
  }
});

test("saved group order survives repeated initialisation and independent groups may receive different orders", () => {
  const task = tasks[0], first = scope(), second = scope();
  const options = initialiseTaskOptionOrder(first, task, (o) => [...o].reverse());
  assert.deepEqual(initialiseTaskOptionOrder(first, task, () => { throw Error("must not reshuffle"); }), options);
  initialiseTaskOptionOrder(second, task, (o) => [...o]);
  assert.notDeepEqual(first.get("taskOptionOrder"), second.get("taskOptionOrder"));
});

test("practice is excluded and invalid saved orders fail instead of changing option identity", () => {
  const practice = scope({ isPractice: true });
  assert.equal(initialiseTaskOptionOrder(practice, tasks[0], () => { throw Error("practice must not shuffle"); }), null);
  assert.equal(practice.get("taskOptionOrder"), undefined);
  assert.throws(() => initialiseTaskOptionOrder(scope({ taskOptionOrder: ["OPT1", "OPT1", "OPT3"] }), tasks[0]), /Invalid/);
});

test("ReviewQuiz scenario and remediation use the same group order and retain the original answers", () => {
  for (const task of tasks) {
    const options = [...task.decisionOptions].reverse(), labels = options.map((o) => o.label);
    const list = `${labels[0]}, ${labels[1]} and ${labels[2]}`;
    const quiz = getReviewQuiz(task.taskVersion, options);
    assert.ok(quiz.scenario.includes(list));
    assert.deepEqual(quiz.questions, getReviewQuiz(task.taskVersion).questions);
    const remediation = getReviewQuizRemediation(task.taskVersion, ["alternativeCount"], options);
    assert.ok(remediation[0].content.includes(list));
  }
});
