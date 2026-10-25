import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const read = (path) => JSON.parse(readFileSync(new URL(path, import.meta.url), "utf8"));
const { tasks } = read("./HPTConfig.json");
// Researcher-only source transcription; never load this answer key at runtime.
const source = read("../test/fixtures/hidden-profile-valence-2026-10-25.json");
const bullets = (text) => text.split("\n").filter((line) => line.startsWith("- ")).map((line) => line.slice(2));
const score = (facts, role) => facts.filter((fact) => fact.role === role).reduce((sum, fact) => sum + fact.valence, 0);

for (const task of tasks) {
  const { facts } = source.tasks.find((entry) => entry.taskVersion === task.taskVersion);
  test(`Task ${task.taskVersion} exposes exactly the revised shared and private facts to the intended profiles`, () => {
    assert.equal(facts.length, 30);
    assert.equal(new Set(facts.map((fact) => fact.id)).size, 30);
    assert.equal(new Set(facts.map((fact) => fact.text)).size, 30);
    const shared = facts.filter((fact) => fact.visibility === "Common");
    assert.equal(shared.length, 9);
    assert.deepEqual(bullets(task.generalInfo).sort(), shared.map((fact) => fact.text).sort());
    assert.equal(task.playerConfig.length, 3);
    for (const [index, profile] of task.playerConfig.entries()) {
      const privateFacts = facts.filter((fact) => fact.visibility === `P${index + 1}`);
      assert.equal(privateFacts.length, 7);
      assert.deepEqual(bullets(profile.playerContent).sort(), privateFacts.map((fact) => fact.text).sort());
      for (const fact of facts) {
        assert.equal(fact.profiles.includes(index + 1), fact.visibility === "Common" || fact.visibility === `P${index + 1}`);
      }
    }
    // Check option association as well as report membership.
    for (const report of [task.generalInfo, ...task.playerConfig.map((profile) => profile.playerContent)]) {
      for (const section of report.split(/^## /m).slice(1)) {
        const option = section.split("\n")[0].replace(" University", "");
        for (const text of bullets(section)) assert.equal(facts.find((fact) => fact.text === text)?.option, option);
      }
      assert.doesNotMatch(report, /Optimal|Decoy|Filler|Editorial notes|Proposed valence/);
    }
  });

  test(`Task ${task.taskVersion} preserves the full-information optimum and each profile's decoy preference`, () => {
    const roles = ["Optimal", "Decoy", "Filler"];
    assert.deepEqual(roles.map((role) => score(facts, role)), [6, 2, 0]);
    const expected = [[1, 3, 0], [1, 2, -1], [2, 3, -1]];
    const expectedSigns = [[10, 6], [9, 7], [10, 6]];
    for (let profile = 1; profile <= 3; profile++) {
      const visible = facts.filter((fact) => fact.profiles.includes(profile));
      assert.equal(visible.length, 16);
      assert.deepEqual(roles.map((role) => score(visible, role)), expected[profile - 1]);
      assert.deepEqual([1, -1].map((sign) => visible.filter((fact) => fact.valence === sign).length), expectedSigns[profile - 1]);
    }
  });
}

test("Task A and Task B match category allocations and valence for each fact ID", () => {
  const [a, b] = source.tasks.map((task) => task.facts);
  const category = (value) => ({ Mobility: "Access", "Visitor experience": "Delegate experience", "Event operations": "Conference operations", "Community and environment": "Community and sustainability" })[value] ?? value;
  for (const fact of a) {
    const counterpart = b.find((item) => item.id === fact.id);
    assert.equal(counterpart.category, category(fact.category));
    assert.equal(counterpart.valence, fact.valence);
    assert.deepEqual(counterpart.profiles, fact.profiles);
    assert.equal(counterpart.role, fact.role);
  }
});
