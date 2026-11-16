// The Static facilitator must send exactly Alsobay et al.'s request and post its
// reply as the original did (microsoft/ai_facilitator 2a0c688, treatment
// llmFacilitation_noCue). The original sources are kept verbatim in
// test/fixtures/alsobay_2a0c688. WHEN Static speaks is this study's control
// variable: the shared six-message checkpoint, not the original 90 s timer.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { FakeGame, FakeRound, FakeStage, FakeScope, makeFakePlayer } from "../test/participant_sim/fakes/fakeStore.mjs";
import { getOfflineCallbacksHarness } from "../test/participant_sim/fakes/loadCallbacks.mjs";
import { buildCanonicalMessage } from "./ExperimentPolicies.mjs";
import { readAppendOnlyAttribute } from "./AppendOnlyAttribute.mjs";
import { buildChatCompletionPayload } from "./LLMTransport.mjs";
import { llmSystemPrompts as originalPrompts } from "../test/fixtures/alsobay_2a0c688/LLMConfig.mjs";
import {
  alsobaySystemPrompt, alsobayTaskSentence, formatDuration, buildAlsobayMessages, parseAlsobayResponse,
} from "./AlsobayStatic.mjs";

const dir = path.dirname(fileURLToPath(import.meta.url));
process.argv[1] = path.join(dir, "fake-entry.js");
const originalCallbacks = fs.readFileSync(path.join(dir, "../test/fixtures/alsobay_2a0c688/callbacks.js.txt"), "utf8");
const ORIGINAL_TASK = "which of three cities (Eldoron, Myloria, Cragnio) should host a large sporting event";
const config = JSON.parse(fs.readFileSync(path.join(dir, "HPTConfig.json"), "utf8"));

// ── Prompt, formatting and request layout ───────────────────────────────────
test("the system prompt is the original LLM prompt with requireLLMMessage true, character for character, except the task sentence", () => {
  const original = originalPrompts("LLM", true);
  assert.ok(original.includes(ORIGINAL_TASK));
  for (const task of config.tasks) {
    const sentence = alsobayTaskSentence(task.taskVersion, task.decisionOptions.map(o => o.label));
    assert.equal(alsobaySystemPrompt(sentence), original.replace(ORIGINAL_TASK, sentence), task.taskVersion);
  }
  // The original timed request used llmSystemPrompts(facilitation, requireLLMMessage) and
  // llmFacilitation_noCue sets requireLLMMessage: true, so timed and requested prompts are identical.
  assert.match(originalCallbacks, /llmSystemPrompts\(facilitation, requireLLMMessage\)/);
  assert.match(originalCallbacks, /llmSystemPrompts\(facilitation, true\)/);
  const treatments = fs.readFileSync(path.join(dir, "../test/fixtures/alsobay_2a0c688/treatments.yaml"), "utf8");
  assert.match(treatments, /name: llmFacilitation_noCue[\s\S]*?llmRequestInterval: 90[\s\S]*?requireLLMMessage: true/);
});

test("task sentences name this study's tasks and options in their given order", () => {
  assert.equal(alsobayTaskSentence("A", ["Talwick", "Rovenna", "Meridia"]), "which of three cities (Talwick, Rovenna, Meridia) should host the International Youth Games");
  assert.equal(alsobayTaskSentence("B", ["Norvale University", "Halden University", "Fenwick University"]),
    "which of three university campuses (Norvale University, Halden University, Fenwick University) should host the Global Innovation Summit");
  for (const task of config.tasks) for (const label of task.decisionOptions.map(o => o.label)) assert.ok(task.generalInfo.includes(label));
});

test("formatDuration is the original function", () => {
  const source = originalCallbacks.slice(originalCallbacks.indexOf("function formatDuration"), originalCallbacks.indexOf("\n}\n", originalCallbacks.indexOf("function formatDuration")) + 2);
  const original = new Function(`${source}; return formatDuration;`)();
  for (const ms of [0, 999, 1000, 59_999, 60_000, 61_500, 90_000, 754_321, 900_000]) assert.equal(formatDuration(ms), original(ms), String(ms));
});

const say = (name, text, ts, extra = {}) => ({ text, content: text, ts, timestamp: ts, stage: "Discussion", messageType: "human", speakerType: "human", sender: { id: name.toLowerCase(), name }, ...extra });
test("the request has the original four system messages and one transcript message, in the original order and format", () => {
  const now = 1_000_000, taskStartTime = now - 200_000, deadline = taskStartTime + 900_000;
  const chat = [
    say("Facilitator", "Hi everyone, welcome!", now - 195_000, { messageType: "facilitator", speakerType: "facilitator", sender: { id: "ai", name: "Facilitator" } }),
    say("Green", "everyone got the city page?", now - 125_000),
    { text: "8 minutes remain.", ts: now - 100_000, stage: "Discussion", messageType: "timer_reminder", speakerType: "timer_reminder", sender: { id: "system-timer_reminder", name: "Timer" } },
    say("Pink", "yep. Rovenna looks pretty solid", now - 61_500),
  ];
  const messages = buildAlsobayMessages({ chat, attendees: ["Green", "Pink", "Blue"], taskSentence: "which of three cities (A, B, C) should host it", now, taskStartTime, deadline });
  assert.deepEqual(messages.map(m => m.role), ["system", "system", "system", "system", "user"]);
  assert.equal(messages[0].content, alsobaySystemPrompt("which of three cities (A, B, C) should host it"));
  assert.equal(messages[1].content, "Meeting attendees: Green, Pink, Blue");
  assert.equal(messages[2].content, "[TIME ELAPSED: 3 mins, 20 seconds]");
  assert.equal(messages[3].content, "[TIME REMAINING: 11 mins, 40 seconds]");
  assert.equal(messages[4].content, [
    "[3 mins, 15 seconds ago] Facilitator: Hi everyone, welcome!",
    "[2 mins, 5 seconds ago] Green: everyone got the city page?",
    "[1 mins, 1 seconds ago] Pink: yep. Rovenna looks pretty solid",
  ].join("\n"));
  // The original built exactly these messages with four unshift calls onto the transcript.
  for (const line of ["content: `[TIME REMAINING: ${formatDuration(remainingTime)}]`, role: \"system\"",
    "content: `[TIME ELAPSED: ${formatDuration(timeElapsed)}]`, role: \"system\"",
    "content: `Meeting attendees: ${players.map((player) => player.get(\"name\")).join(\", \")}`, role: \"system\"",
    "`[${formatDuration(new Date().getTime() - message.ts)} ago] ${message.sender.name}: ${message.text}`"]) assert.ok(originalCallbacks.includes(line), line);
});

test("JSON-object output: MESSAGE is posted as returned; anything else is not posted", () => {
  const long = "Line one.\nLine two with @[Pink] and " + Array(120).fill("word").join(" ");
  assert.deepEqual(parseAlsobayResponse(JSON.stringify({ MESSAGE: long, RATIONALE: "r" })), { ok: true, llmAction: { MESSAGE: long, RATIONALE: "r" } });
  for (const bad of ["not json", "{}", JSON.stringify({ MESSAGE: "" }), JSON.stringify({ MESSAGE: 7 }), "null", "[]"]) assert.equal(parseAlsobayResponse(bad).ok, false, bad);
  const payload = buildChatCompletionPayload({ model: "gpt-5.6-luna", maxTokens: 1000, messages: [], endpoint: "https://api.openai.com/v1/chat/completions", responseFormat: "json_object" });
  assert.deepEqual(payload.response_format, { type: "json_object" });
  assert.match(originalCallbacks, /text: \{ format: \{ type: "json_object" \} \}/);
});

// ── Timing ──────────────────────────────────────────────────────────────────

function world({ facilitation = "static", lines = ["everyone got the city page?", "Rovenna looks solid", "the hotels are close", "Talwick has a train", "Meridia has rooms", "what about Blue?"], remaining = 600_000 } = {}) {
  const players = ["Green", "Pink", "Blue"].map((name, i) => makeFakePlayer({ id: `p${i}`, name, hexCode: "ffffff" }));
  const game = new FakeGame({}, players);
  const task = config.tasks[0];
  const round = new FakeRound({ index: 0, taskIndex: 0, taskVersion: "A", facilitation, generalInfo: task.generalInfo, decisionOptions: task.decisionOptions }, game);
  const stage = new FakeStage({ name: "Task" }, round); stage.currentGame = game;
  game.currentRound = round; game.currentStage = stage;
  for (const p of players) { p.currentGame = game; p.round = new FakeScope("playerRound"); p.stage = new FakeScope("playerStage"); }
  game.set("taskStartTime", Date.now() - (900_000 - remaining)); game.set("deadline", Date.now() + remaining);
  game.set("chat_round_0", lines.map((text, i) => buildCanonicalMessage({ messageId: `h${i}`, groupId: game.id, participantId: players[i % 3].id, roundIndex: 0,
    stage: "Discussion", messageType: "human", speakerType: "human", timestamp: Date.now() - 1000 * (lines.length - i), sequencePosition: i, content: text,
    sender: { id: players[i % 3].id, name: players[i % 3].get("name") } })));
  game.set("humanMessageCount", Math.max(0, lines.length - 1));
  game.set("messagesSinceLastPublish", Math.max(0, lines.length - 1));
  return { game, round, stage, players };
}
async function withProvider(reply, task) {
  const prior = globalThis.fetch, requests = [];
  globalThis.fetch = async (_url, options) => {
    const body = JSON.parse(options.body); requests.push(body);
    const data = typeof reply === "function" ? reply(body, requests) : reply;
    if (data === "ERROR") return new Response("boom", { status: 500 });
    return new Response(JSON.stringify({ choices: [{ message: { content: typeof data === "string" ? data : JSON.stringify(data) }, finish_reason: "stop" }] }), { headers: { "content-type": "application/json" } });
  };
  try { await task(); } finally { globalThis.fetch = prior; }
  return requests;
}
const posted = w => w.game.get("chat_round_0").filter(m => m.sender?.id === "ai");
const log = w => readAppendOnlyAttribute(w.game, "llmLog");


// ── End to end through the real callbacks ───────────────────────────────────
test("an automatic Static turn posts the model's MESSAGE verbatim as an automatic intervention and logs the original fields", async () => {
  const { handleChat } = await getOfflineCallbacksHarness();
  const w = world();
  const MESSAGE = "Let's track what we know so far:\nRovenna: hotels close to venues.\n@[Blue], what do you have on Meridia or Talwick?";
  const requests = await withProvider({ MESSAGE, RATIONALE: "Blue has not spoken." }, () => handleChat(undefined, { game: w.game }));
  assert.equal(requests.length, 1, "one request, no Validator, no retry");
  assert.deepEqual(requests[0].messages.map(m => m.role), ["system", "system", "system", "system", "user"]);
  assert.equal(requests[0].messages[0].content, originalPrompts("LLM", true).replace(ORIGINAL_TASK, "which of three cities (Talwick, Rovenna, Meridia) should host the International Youth Games"));
  assert.match(requests[0].messages[4].content, /^\[\d+ seconds ago\] Green: everyone got the city page\?\n/);
  assert.equal(requests[0].max_completion_tokens ?? requests[0].max_tokens, 1000);
  assert.deepEqual(posted(w).map(m => [m.content, m.role, m.facilitatorTrigger, m.countsAsIntervention]), [[MESSAGE, "STATIC", "AUTOMATIC_CHECKPOINT", true]]);
  const entry = log(w).at(-1);
  assert.equal(entry.directlyRequested, false); assert.equal(entry.requireLLMMessage, true); assert.equal(entry.triggerSource, "message");
  assert.equal(entry.requestMade, true); assert.equal(entry.requestSuccess, true); assert.equal(entry.messageAdded, true);
  assert.deepEqual(entry.llmAction, { MESSAGE, RATIONALE: "Blue has not spoken." });
  assert.equal(entry.messagesOAIFormat.length, 5);
  assert.equal(entry.staticPolicy, "alsobay_2a0c688");
  assert.equal(w.game.get("totalInterventions"), 1);
});

test("Static automatic turns use the study's shared checkpoint: six participant messages, the cooldown, and one pipeline at a time", async () => {
  const { handleChat } = await getOfflineCallbacksHarness();
  const lines = Array.from({ length: 5 }, (_, i) => `Point ${i}.`);
  const w = world({ lines });
  w.game.set("humanMessageCount", 0); w.game.set("messagesSinceLastPublish", 0);
  const send = text => w.game.get("chat_round_0").push(buildCanonicalMessage({ messageId: `x-${text}`, groupId: w.game.id, participantId: "p0", roundIndex: 0,
    stage: "Discussion", messageType: "human", speakerType: "human", timestamp: Date.now(), sequencePosition: 99, content: text, sender: { id: "p0", name: "Green" } }));
  let requests = await withProvider({ MESSAGE: "first", RATIONALE: "r" }, () => handleChat(undefined, { game: w.game }));
  assert.equal(requests.length, 0, "five messages: below the six-message gate");
  send("Point 5.");
  requests = await withProvider({ MESSAGE: "first", RATIONALE: "r" }, () => handleChat(undefined, { game: w.game }));
  assert.equal(requests.length, 1, "the sixth message opens the checkpoint");
  assert.equal(w.game.get("messagesSinceLastPublish"), 0, "a Static publication resets the shared gate");
  for (let i = 6; i < 11; i++) send(`Point ${i}.`);
  requests = await withProvider({ MESSAGE: "second", RATIONALE: "r" }, () => handleChat(undefined, { game: w.game }));
  assert.equal(requests.length, 0, "five new messages are not enough");
  send("Point 11.");
  requests = await withProvider({ MESSAGE: "second", RATIONALE: "r" }, () => handleChat(undefined, { game: w.game }));
  assert.equal(requests.length, 0, "the shared 15-second cooldown still applies");
  assert.match(log(w).at(-1).reason, /cooldown/);
  w.game.set("lastAttemptTimestamp", Date.now() - 31_000);
  send("Point 12.");
  requests = await withProvider({ MESSAGE: "second", RATIONALE: "r" }, () => handleChat(undefined, { game: w.game }));
  assert.equal(requests.length, 1);
  assert.deepEqual(posted(w).map(m => m.content), ["first", "second"]);
});

test("a provider error or a reply without MESSAGE posts nothing and is not retried", async () => {
  const { handleChat } = await getOfflineCallbacksHarness();
  for (const reply of ["ERROR", "not json", { RATIONALE: "no message" }]) {
    const w = world({ lines: Array.from({ length: 6 }, (_, i) => `Point ${i}.`) });
    w.game.set("humanMessageCount", 5); w.game.set("messagesSinceLastPublish", 5);
    const requests = await withProvider(reply, () => handleChat(undefined, { game: w.game }));
    assert.equal(requests.length, 1, String(reply));
    assert.equal(posted(w).length, 0, String(reply));
    assert.equal(log(w).at(-1).messageAdded, false);
    assert.deepEqual(w.game.get("llmInFlight"), {});
  }
});

test("@[Facilitator] in Static: the same prompt, required to respond, answered at once; not an intervention; no safe fallback", async () => {
  const { handleChat } = await getOfflineCallbacksHarness();
  const w = world({ lines: ["Rovenna looks solid", "@[Facilitator] can you list what we have?"] });
  const requests = await withProvider({ MESSAGE: "So far: Rovenna looks solid.", RATIONALE: "asked" }, () => handleChat(undefined, { game: w.game }));
  assert.equal(requests.length, 1);
  assert.equal(requests[0].messages[0].content, originalPrompts("LLM", true).replace(ORIGINAL_TASK, "which of three cities (Talwick, Rovenna, Meridia) should host the International Youth Games"));
  assert.deepEqual(posted(w).map(m => [m.content, m.facilitatorTrigger, m.countsAsIntervention]), [["So far: Rovenna looks solid.", "PARTICIPANT_REQUEST", false]]);
  assert.equal(log(w).at(-1).directlyRequested, true);
  assert.equal(w.game.get("totalParticipantRequestReplies"), 1);
  const failed = world({ lines: ["@[Facilitator] help?"] });
  await withProvider("ERROR", () => handleChat(undefined, { game: failed.game }));
  assert.equal(posted(failed).length, 0, "the original posted nothing when the request failed");
});

test("Static and the Adaptive Static-policy turn send the identical request for the same discussion", async () => {
  const { handleChat } = await getOfflineCallbacksHarness();
  const lines = Array.from({ length: 6 }, (_, i) => `Point ${i} about Rovenna and Talwick.`);
  const s = world({ lines });
  const staticRequests = await withProvider({ MESSAGE: "ok", RATIONALE: "r" }, () => handleChat(undefined, { game: s.game }));
  const a = world({ facilitation: "adaptive", lines });
  a.game.set("humanMessageCount", 5); a.game.set("messagesSinceLastPublish", 5);
  const adaptiveRequests = await withProvider(body => body.messages[0].content.startsWith("# assessor.md")
    ? { candidates: { elicit: null, scrutinize: null, integrate: null }, rationale: "none" } : { MESSAGE: "ok", RATIONALE: "r" }, () => handleChat(undefined, { game: a.game }));
  const adaptiveStatic = adaptiveRequests.find(r => !r.messages[0].content.startsWith("# assessor.md"));
  const strip = messages => messages.map(m => ({ ...m, content: m.content.replace(/\d+ (mins|seconds)/g, "N") }));
  assert.deepEqual(strip(adaptiveStatic.messages), strip(staticRequests[0].messages));
});
