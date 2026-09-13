// Shared driver for every Tier 2 (real-LLM) scenario: builds a live task
// world, sends a scenario's transcript one message at a time through the
// REAL live handleChat (fakes/loadCallbacks.mjs's getLiveHandleChat), and
// returns the full decision trail (llmLog entries generated, published
// chat messages, checkpoint state) for the scenario's own check() function
// to grade.
import { getLiveHandleChat } from "./loadCallbacks.mjs";
import { makeTaskWorld, setRemainingMs, sendHuman, fireCheckpoint, getLlmLog, getPublishedFacilitatorMessages } from "./gameHarness.mjs";

export async function runLiveScenario(scenario) {
  const handleChat = await getLiveHandleChat();
  const world = makeTaskWorld({ facilitation: scenario.facilitation ?? "adaptive", remainingMs: scenario.remainingMs ?? 5 * 60_000 });
  const logEntriesByMessageIndex = [];
  for (let i = 0; i < scenario.transcript.length; i++) {
    const turn = scenario.transcript[i];
    sendHuman(world, turn.player, turn.text);
    const before = getLlmLog(world).length;
    const fireResult = await fireCheckpoint(handleChat, world);
    const after = getLlmLog(world).length;
    logEntriesByMessageIndex.push({ index: i, turn, fired: fireResult.threw ? "threw" : (after > before ? "triggered" : "not-triggered"), threw: fireResult.threw, error: fireResult.threw ? fireResult.error.message : null });
  }
  const llmLog = getLlmLog(world);
  const triggeredEntries = llmLog; // every entry in the log corresponds to a triggered checkpoint (see Bug #1 note: non-triggered ones never get logged)
  const lastEntry = triggeredEntries.length ? triggeredEntries[triggeredEntries.length - 1] : null;
  const published = getPublishedFacilitatorMessages(world);
  return {
    world, logEntriesByMessageIndex, llmLog, lastEntry, published,
    publishedTexts: published.map((m) => m.content),
  };
}
