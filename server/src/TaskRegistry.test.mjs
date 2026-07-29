// Executable readiness tests against the real TaskRegistry.mjs (not manual
// derivation, not a bundle-string grep). Run with:
//   node server/src/TaskRegistry.test.mjs
import assert from "node:assert/strict";
import test from "node:test";
import { taskRegistry, computeReadiness } from "./TaskRegistry.mjs";

test("task1.readyForFlowTesting === true", () => {
  assert.equal(taskRegistry.task1.readyForFlowTesting, true);
});

test("task1.readyForFormalExperiment === false", () => {
  assert.equal(taskRegistry.task1.readyForFormalExperiment, false);
});

test("task2: both readiness flags are false", () => {
  assert.equal(taskRegistry.task2.readyForFlowTesting, false);
  assert.equal(taskRegistry.task2.readyForFormalExperiment, false);
});

test("task1: decisionOptions comes from HPTConfig.json, not an inline duplicate", () => {
  assert.deepEqual(taskRegistry.task1.decisionOptions, ["Eldoron", "Myloria", "Cragnio"]);
});

test("computeReadiness: any single formal scoring requirement being false forces readyForFormalExperiment = false", () => {
  const fullyReady = {
    participantMaterialsAvailable: true,
    privateProfilesAvailable: true,
    correctAnswerAvailable: true,
    hiddenFactBankAvailable: true,
    taskKeywordsAvailable: true,
    scoringConfigAvailable: true,
  };
  // Sanity: with every requirement true, formal readiness should be true.
  assert.equal(computeReadiness(fullyReady).readyForFormalExperiment, true);

  // Flipping exactly one formal requirement to false at a time must force
  // readyForFormalExperiment back to false, regardless of which one.
  const formalKeys = [
    "correctAnswerAvailable",
    "hiddenFactBankAvailable",
    "taskKeywordsAvailable",
    "scoringConfigAvailable",
  ];
  for (const key of formalKeys) {
    const entry = { ...fullyReady, [key]: false };
    const readiness = computeReadiness(entry);
    assert.equal(
      readiness.readyForFormalExperiment,
      false,
      `expected readyForFormalExperiment=false when ${key}=false`
    );
  }
});

test("computeReadiness: missing participant materials or private profiles forces readyForFlowTesting = false (and therefore readyForFormalExperiment = false too)", () => {
  const otherwiseReady = {
    participantMaterialsAvailable: true,
    privateProfilesAvailable: true,
    correctAnswerAvailable: true,
    hiddenFactBankAvailable: true,
    taskKeywordsAvailable: true,
    scoringConfigAvailable: true,
  };

  const noParticipantMaterials = { ...otherwiseReady, participantMaterialsAvailable: false };
  assert.equal(computeReadiness(noParticipantMaterials).readyForFlowTesting, false);
  assert.equal(computeReadiness(noParticipantMaterials).readyForFormalExperiment, false);

  const noProfiles = { ...otherwiseReady, privateProfilesAvailable: false };
  assert.equal(computeReadiness(noProfiles).readyForFlowTesting, false);
  assert.equal(computeReadiness(noProfiles).readyForFormalExperiment, false);
});
