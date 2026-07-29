import taskConfig from "./HPTConfig.json" with { type: "json" };

// readyForFlowTesting / readyForFormalExperiment are always derived, never set
// by hand, so they can't silently drift out of sync with the underlying
// per-field availability flags below. Exported so tests can exercise the
// derivation logic directly, not just the two fixed task1/task2 outcomes.
export function computeReadiness(entry) {
  const readyForFlowTesting = Boolean(
    entry.participantMaterialsAvailable && entry.privateProfilesAvailable
  );
  const readyForFormalExperiment = Boolean(
    readyForFlowTesting &&
    entry.correctAnswerAvailable &&
    entry.hiddenFactBankAvailable &&
    entry.taskKeywordsAvailable &&
    entry.scoringConfigAvailable
  );
  return { readyForFlowTesting, readyForFormalExperiment };
}

// Fields under each task entry:
// - participantMaterialsAvailable / privateProfilesAvailable: whether the
//   participant-facing background + private profiles exist and are real
//   (not placeholder/invented). Sent to the client via game.set(...)/
//   player.set(...) once a game actually starts.
// - correctAnswerAvailable / hiddenFactBankAvailable / taskKeywordsAvailable /
//   scoringConfigAvailable: whether the corresponding analysis-only material
//   is defined. These are never sent to the client, never sent to the LLM,
//   and never invented here when false -- the associated *content* field
//   stays null until a researcher supplies real material.
// - readyForFlowTesting / readyForFormalExperiment: derived, see above.
const task1Base = {
  participantMaterialsAvailable: true,
  // BLOCKER (unresolved, not acted on): taskConfig.playerConfig actually
  // contains 5 profiles (Green/Blue/Pink/Red/Orange), not 3, even though the
  // formal design is 3 participants per game. callbacks.js's onGameStart
  // shuffles all 5 then only reads indices [0,1,2] of the shuffled array, so
  // each game does get exactly 3 unique, non-repeating profiles -- but
  // whether "randomly sample 3 of an over-provisioned 5-profile pool per
  // game" is the intended design, or whether exactly 3 of these 5 are the
  // real formal profiles and the other 2 are leftover from an earlier
  // 5-player version of this task, cannot be determined from anything in
  // this repo (no comment, filename, or other marker distinguishes them).
  // Not deleting any profile without that confirmation -- ask a researcher
  // which is correct before changing taskConfig.playerConfig.
  privateProfilesAvailable: true,
  // None of these are defined anywhere in the current repo -- left false/null
  // rather than guessed. Task 1 has real participant-facing content, but no
  // formalized "correct answer" artifact exists.
  correctAnswerAvailable: false,
  hiddenFactBankAvailable: false,
  taskKeywordsAvailable: false,
  scoringConfigAvailable: false,

  generalInfo: taskConfig.generalInfo,
  decisionOptions: taskConfig.decisionOptions,
  playerConfig: taskConfig.playerConfig,
  correctAnswer: null,
  taskKeywords: null,
  diagnosticUnsharedInfo: null,
  disconfirmingEvidence: null,
};

const task2Base = {
  // BLOCKER: no Task 2 materials of any kind have been provided.
  participantMaterialsAvailable: false,
  privateProfilesAvailable: false,
  correctAnswerAvailable: false,
  hiddenFactBankAvailable: false,
  taskKeywordsAvailable: false,
  scoringConfigAvailable: false,

  generalInfo: null,
  decisionOptions: null,
  playerConfig: null,
  correctAnswer: null,
  taskKeywords: null,
  diagnosticUnsharedInfo: null,
  disconfirmingEvidence: null,
};

export const taskRegistry = {
  task1: { ...task1Base, ...computeReadiness(task1Base) },
  task2: { ...task2Base, ...computeReadiness(task2Base) },
};
