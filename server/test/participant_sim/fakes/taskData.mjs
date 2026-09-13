// Loads the REAL Task A stimuli from server/src/HPTConfig.json (fs.readFile,
// not an ESM `import ... .json`, so no import-attribute issues and no
// bundling needed for this file). Used to ground every simulated transcript
// in the actual Talwick/Rovenna/Meridia hidden-profile task and the actual
// Green/Blue/Pink player identities, exactly as a real Task-A round would.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CONFIG_PATH = path.resolve(__dirname, "../../../src/HPTConfig.json");

const raw = JSON.parse(fs.readFileSync(CONFIG_PATH, "utf8"));
export const TASK_A = raw.tasks.find((t) => t.taskVersion === "A");

if (!TASK_A) throw new Error("taskData.mjs: could not find taskVersion 'A' in HPTConfig.json");

export const GENERAL_INFO = TASK_A.generalInfo;
export const DECISION_OPTIONS = TASK_A.decisionOptions;
export const PLAYER_CONFIG = TASK_A.playerConfig; // [{playerName, hexCode, playerContent, ...}, ...]

export function playerConfigByName(name) {
  const found = PLAYER_CONFIG.find((p) => p.playerName === name);
  if (!found) throw new Error(`taskData.mjs: no player config named "${name}"`);
  return found;
}

// Fixed 3-player roster used by every scenario, matching the real
// onGameStart shuffle's output shape (name/hexCode pulled straight from
// HPTConfig.json's playerConfig array; the real code additionally shuffles
// WHICH slot each human gets, which is irrelevant to testing the
// facilitator's discussion-reading logic).
export const ROSTER = ["Green", "Blue", "Pink"].map((name) => {
  const cfg = playerConfigByName(name);
  return { id: `p-${name.toLowerCase()}`, name: cfg.playerName, hexCode: cfg.hexCode, privateContent: cfg.playerContent };
});
