import { personalPages, personalProgressKey } from "./personalFlow.mjs";
import { PRACTICE_PERSONAL_PAGES } from "./practice.mjs";
export function isTestGame(game) {
  return game?.get("testControlsEnabled") === true
    && game.get("treatment")?.testMode === true && game.get("treatmentName") === "test";
}
export function testPersonalState(player, round, stage) {
  const practice = round.get("isPractice") && stage.get("name") === "PracticeWelcome";
  const pages = practice ? PRACTICE_PERSONAL_PAGES : personalPages(stage.get("name"), round.get("taskIndex"));
  const progress = practice ? { index: player.round.get("practicePageIndex") || 0 }
    : player.round.get(personalProgressKey(stage.get("name")));
  return { practice, pages, index: progress?.index ?? 0, version: player.round.get("testProgressVersion") || 0 };
}
