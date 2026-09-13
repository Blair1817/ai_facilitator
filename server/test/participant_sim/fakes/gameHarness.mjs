// Wires a fake Game/Round/Stage/Player set (fakeStore.mjs) together with the
// REAL ExperimentPolicies.mjs canonical-message builder and the REAL
// AppendOnlyAttribute-backed llmLog reader, so a scenario script can drive
// the actual `handleChat` function (from loadCallbacks.mjs) message by
// message exactly the way a live Empirica "chat_round_0" attribute mutation
// would, and then inspect exactly what a real post-hoc researcher would see
// in the exported llmLog.
import { FakeGame, FakeRound, FakeStage, makeFakePlayer } from "./fakeStore.mjs";
import { buildCanonicalMessage, allocateSequencePosition, MESSAGE_TYPES } from "../../../src/ExperimentPolicies.mjs";
import { readAppendOnlyAttribute } from "../../../src/AppendOnlyAttribute.mjs";
import { ROSTER, GENERAL_INFO, DECISION_OPTIONS } from "./taskData.mjs";

const ROUND_INDEX = 0;
const CHAT_KEY = `chat_round_${ROUND_INDEX}`;

/**
 * Build one fresh fake Task-stage world: a Game with 3 players (Green/Blue/
 * Pink, real names+hex codes from HPTConfig.json), one Round already
 * carrying the real Task A generalInfo/decisionOptions, and one Stage named
 * "Task" that is current. `facilitation` is "static" or "adaptive".
 * `remainingMs` sets how much discussion time is left (drives the
 * time-floor / forced-synthesiser-nudge boundaries); `taskStartTime` is
 * derived so elapsedTime looks sane (10-minute nominal Task stage).
 */
export function makeTaskWorld({ facilitation = "adaptive", remainingMs = 5 * 60 * 1000, gameDurationMs = 10 * 60 * 1000 } = {}) {
  const players = ROSTER.map((r) => makeFakePlayer({ id: r.id, name: r.name, hexCode: r.hexCode }));
  const game = new FakeGame({}, players);
  const round = new FakeRound(
    { index: ROUND_INDEX, facilitation, generalInfo: GENERAL_INFO, decisionOptions: DECISION_OPTIONS, taskVersion: "A" },
    game,
  );
  const stage = new FakeStage({ name: "Task" }, round);
  game.currentRound = round;
  game.currentStage = stage;
  const now = Date.now();
  game.set("taskStartTime", now - (gameDurationMs - remainingMs));
  game.set("deadline", now + remainingMs);
  game.set(CHAT_KEY, []);
  return { game, round, stage, players, chatKey: CHAT_KEY, checkpointErrors: [] };
}

/** Move the world's clock so `remainingMs` are left before the deadline (for
 * scenarios that need to land a message at an exact time-remaining boundary,
 * e.g. the <=10s time floor or the <=20s forced-synthesiser nudge). Does not
 * touch taskStartTime, matching how a real Task stage's elapsed-time only
 * grows while its deadline is fixed at round start. */
export function setRemainingMs(world, remainingMs) {
  world.game.set("deadline", Date.now() + remainingMs);
}

/** Append one real, schema-correct human chat message (mirrors exactly what
 * callbacks.js's `humanMessageRequest` listener + `appendCanonicalMessage`
 * produce) using the REAL buildCanonicalMessage/allocateSequencePosition
 * from ExperimentPolicies.mjs -- not a hand-rolled shape. */
export function sendHuman(world, playerName, content, { timestamp } = {}) {
  const player = world.players.find((p) => p.get("name") === playerName);
  if (!player) throw new Error(`sendHuman: no player named "${playerName}" in this world`);
  const counters = { ...(world.game.get("messageSequenceCounters") || {}) };
  const sequencePosition = allocateSequencePosition(counters, world.chatKey);
  world.game.set("messageSequenceCounters", counters);
  const ts = timestamp ?? Date.now();
  const message = buildCanonicalMessage({
    messageId: `human-${player.id}-${ts}-${sequencePosition}`,
    groupId: world.game.id,
    participantId: player.id,
    roundIndex: ROUND_INDEX,
    stage: "Discussion",
    messageType: MESSAGE_TYPES.HUMAN,
    speakerType: MESSAGE_TYPES.HUMAN,
    timestamp: ts,
    sequencePosition,
    content,
    sender: { id: player.id, name: player.get("name"), hexCode: player.get("hexCode") },
  });
  world.game.append(world.chatKey, message);
  return message;
}

/** Append a raw message object directly, bypassing buildCanonicalMessage's
 * own non-empty-content guard, so we can observe how handleChat's OWN
 * filtering reacts to content a real client should never have been able to
 * submit but a misbehaving/compromised client could (empty/whitespace-only
 * scenario). */
export function sendRawMessage(world, fields) {
  world.game.append(world.chatKey, fields);
}

/**
 * Invoke the real handleChat exactly like a live "chat_round_0" attribute
 * mutation would (2-arg call; only the second arg's `game` is read by the
 * real function -- confirmed by reading `async function handleChat(env,
 * { game })` in callbacks.js this session).
 *
 * Empirica's real dispatcher (node_modules/@empirica/core/dist/
 * chunk-LPBU7J6R.js `startAttribute`) wraps every attribute-listener
 * invocation in try/catch and only pretty-prints the error to console --
 * an exception inside handleChat does NOT crash the game in production, it
 * just means whatever handleChat was in the middle of doing (a write, a
 * flush) never completes. We reproduce that same error boundary here so a
 * scenario that trips a real exception (see TEST_REPORT.md's Bugs section)
 * doesn't kill the whole run, and we record it on `world.checkpointErrors`
 * so callers can assert on / report it instead of it disappearing silently.
 */
export async function fireCheckpoint(handleChat, world) {
  try {
    await handleChat(undefined, { game: world.game });
    return { threw: false };
  } catch (err) {
    world.checkpointErrors.push({ message: err.message, stack: err.stack });
    return { threw: true, error: err };
  }
}

export function getChat(world) {
  return world.game.get(world.chatKey) || [];
}

export function getPublishedFacilitatorMessages(world) {
  return getChat(world).filter((m) => m.messageType === MESSAGE_TYPES.FACILITATOR);
}

export function getLlmLog(world) {
  return readAppendOnlyAttribute(world.game, "llmLog");
}

export function getLatestLogEntry(world) {
  const log = getLlmLog(world);
  return log.length ? log[log.length - 1] : null;
}
