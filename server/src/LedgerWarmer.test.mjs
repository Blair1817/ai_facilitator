// Background ledger warm-up: lane ordering, coalescing, cache reuse by the
// Synthesiser, and the content-free counters kept on the Round.
import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";
process.argv[1] = path.join(path.dirname(fileURLToPath(import.meta.url)), "fake-entry.js");
const { buildSynthesisLedger, renderSynthesisLedger } = await import("./SynthesisLedger.mjs");
const { createLedgerWarmer, mergeLedgerCache, withoutLatestSource, addWarmStats, planWarmPass, recordWarmFailures } = await import("./LedgerWarmer.mjs");
const { readFile } = await import("node:fs/promises");
const { mockLedgerExtraction, mockLedgerAudit, ledgerTargets } = await import("../test/participant_sim/fakes/ledgerMock.mjs");

const OPTIONS = ["Talwick", "Rovenna", "Meridia"];
const say = (name, text) => ({ text, sender: { id: name.toLowerCase(), name } });
const CHAT = [
  say("Green", "everyone got the city page?"),
  say("Pink", "the hotels are close to all the venues in Rovenna"),
  { text: "Welcome!", sender: { id: "ai", name: "Facilitator" }, messageType: "facilitator", speakerType: "facilitator" },
  say("Green", "Talwick has a direct airport train, but some hotels need multiple changes"),
  say("Blue", "I'd go with Talwick"),
  say("Pink", "Rovenna hotels are near the venues"),
  say("Blue", "Meridia has university rooms for people who need somewhere cheap"),
];
const model = () => {
  const calls = [];
  const callLLM = async (messages, _options, kind) => {
    calls.push({ kind, targets: kind === "ledger_extract" ? ledgerTargets(messages[1].content) : null });
    const data = kind === "ledger_extract" ? mockLedgerExtraction(messages[1].content) : mockLedgerAudit(messages[1].content);
    return { success: true, rawText: JSON.stringify(data) };
  };
  return { callLLM, calls };
};
const build = (chat, cache, callLLM) => buildSynthesisLedger({ chat, optionLabels: OPTIONS, taskGeneralContext: "Choose Talwick, Rovenna or Meridia.", cache, callLLM });
const tick = () => new Promise(resolve => setImmediate(resolve));

test("warm passes and exclusive builds on one lane never overlap and run in order", async () => {
  const warmer = createLedgerWarmer();
  const log = [];
  let running = 0;
  const job = name => async () => {
    running += 1; assert.equal(running, 1, "two jobs ran at once");
    log.push(`start ${name}`); await tick(); log.push(`end ${name}`);
    running -= 1; return name;
  };
  const a = warmer.warm("round", job("warm1"));
  const b = warmer.exclusive("round", job("synth"));
  const c = warmer.warm("round", job("warm2"));
  // warm2 arrives while warm1 is still waiting to start, so it shares warm1
  // (which reads the chat only when it starts).
  assert.deepEqual(await Promise.all([a, b, c]), ["warm1", "synth", "warm1"]);
  assert.deepEqual(log, ["start warm1", "end warm1", "start synth", "end synth"]);
  // After the Synthesiser build, a new request runs a new pass.
  assert.equal(await warmer.warm("round", job("warm3")), "warm3");
  assert.deepEqual(log.slice(-2), ["start warm3", "end warm3"]);
});

test("requests arriving while a pass is waiting share it; one arriving mid-pass queues exactly one more", async () => {
  const warmer = createLedgerWarmer();
  let passes = 0;
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const blocker = warmer.exclusive("round", () => gate);
  const pass = async () => { passes += 1; await tick(); return passes; };
  const first = warmer.warm("round", pass);
  const second = warmer.warm("round", pass);
  assert.equal(first, second, "a waiting pass is shared");
  release(); await blocker; await first;
  assert.equal(passes, 1);
  // Mid-pass: the running pass no longer absorbs requests.
  let inPass;
  const started = new Promise(resolve => { inPass = resolve; });
  const slow = warmer.warm("round", async () => { passes += 1; inPass(); await tick(); });
  await started;
  const next = warmer.warm("round", pass);
  assert.notEqual(slow, next);
  await next;
  assert.equal(passes, 3);
});

test("a failed pass is reported, resolves to null and does not block later work", async () => {
  const errors = [];
  const warmer = createLedgerWarmer({ onError: (error, key) => errors.push([error.message, key]) });
  assert.equal(await warmer.warm("round", async () => { throw new Error("provider down"); }), null);
  assert.deepEqual(errors, [["provider down", "round"]]);
  assert.equal(await warmer.exclusive("round", async () => "ok"), "ok");
  // A failing exclusive job rejects for its caller only.
  await assert.rejects(warmer.exclusive("round", async () => { throw new Error("boom"); }), /boom/);
  assert.equal(await warmer.warm("round", async () => "after"), "after");
});

test("lanes are independent per round", async () => {
  const warmer = createLedgerWarmer();
  let release;
  const held = warmer.exclusive("round-a", () => new Promise(resolve => { release = resolve; }));
  assert.equal(await warmer.warm("round-b", async () => "b"), "b");
  release(); await held;
});

test("after a warm-up the Synthesiser build extracts only the latest message, which yields the model question", async () => {
  const warm = model();
  const warmed = await build(CHAT.slice(0, 6), {}, warm.callLLM);
  assert.ok(Object.keys(warmed.cache).length >= 3, "warm-up cached confirmed entries");

  // Synthesiser turn: one more participant message arrived since the warm-up.
  const synth = model();
  const cache = withoutLatestSource(mergeLedgerCache({}, warmed.cache), CHAT);
  const ledger = await build(CHAT, cache, synth.callLLM);
  const extracts = synth.calls.filter(c => c.kind === "ledger_extract");
  assert.equal(extracts.length, 1);
  assert.deepEqual(extracts[0].targets, ["m6"], "only the message the warm-up had not seen");
  assert.equal(renderSynthesisLedger(ledger, OPTIONS).stats.questionSource, "model");

  // Fully warmed: the latest message is still re-extracted so the question comes from the model.
  const full = await build(CHAT, {}, model().callLLM);
  const again = model();
  const ledger2 = await build(CHAT, withoutLatestSource(full.cache, CHAT), again.callLLM);
  assert.deepEqual(again.calls.filter(c => c.kind === "ledger_extract").map(c => c.targets), [["m6"]]);
  assert.equal(renderSynthesisLedger(ledger2, OPTIONS).stats.questionSource, "model");

  // Same scoreboard as building from scratch.
  const cold = await build(CHAT, {}, model().callLLM);
  assert.deepEqual(renderSynthesisLedger(ledger, OPTIONS).candidate.message.sections, renderSynthesisLedger(cold, OPTIONS).candidate.message.sections);
});

test("mergeLedgerCache keeps entries from both and prefers the newer one", () => {
  const merged = mergeLedgerCache({ m1: { text: "a", entry: 1 }, m2: { text: "b", entry: 2 } }, { m2: { text: "b", entry: 3 }, m4: { text: "d", entry: 4 } });
  assert.deepEqual(merged, { m1: { text: "a", entry: 1 }, m2: { text: "b", entry: 3 }, m4: { text: "d", entry: 4 } });
  assert.deepEqual(mergeLedgerCache(null, undefined), {});
});

test("withoutLatestSource leaves the cache unchanged when the latest message is not cached", () => {
  const cache = { m1: { text: "x" } };
  assert.equal(withoutLatestSource(cache, CHAT), cache);
  assert.deepEqual(withoutLatestSource(undefined, []), {});
});

test("warm-up counters are cumulative and content-free", () => {
  const first = addWarmStats(undefined, { modelCalls: 2, failedCalls: 0, messagesExtracted: 3, latencyMs: 4000, completedAt: 10, cachedMessages: 3 });
  const second = addWarmStats(first, { modelCalls: 2, failedCalls: 1, messagesExtracted: 1, latencyMs: 2500, completedAt: 20, cachedMessages: 4 });
  assert.deepEqual(second, { passes: 2, modelCalls: 4, failedCalls: 1, messagesExtracted: 4, totalLatencyMs: 6500, lastPassAt: 20, cachedMessages: 4 });
});

test("a message the warm-up could not confirm is skipped by later passes until its text changes", async () => {
  // m3's extraction is malformed (a point whose quote is not in the message), so it is never confirmed.
  const callLLM = async (messages, _o, kind) => {
    const user = messages[1].content;
    if (kind !== "ledger_extract") return { success: true, rawText: JSON.stringify(mockLedgerAudit(user)) };
    const data = mockLedgerExtraction(user);
    for (const entry of data.entries) if (entry.messageId === "m3") entry.points[0].quote = "not in the message";
    return { success: true, rawText: JSON.stringify(data) };
  };
  const chat = CHAT.slice(0, 4);
  let plan = planWarmPass({}, {}, chat);
  assert.deepEqual(plan, { attempt: ["m0", "m1", "m3"], skip: [] });
  const first = await build(chat, {}, callLLM);
  assert.equal(first.cache.m3, undefined);
  const skipped = recordWarmFailures({}, chat, plan.attempt, first.cache);
  assert.deepEqual(Object.keys(skipped), ["m3"]);

  // Next pass: only the new message is sent; m3 is skipped and gets the fallback entry.
  const longer = CHAT.slice(0, 5);
  plan = planWarmPass(first.cache, skipped, longer);
  assert.deepEqual(plan, { attempt: ["m4"], skip: ["m3"] });
  const m = model();
  const second = await buildSynthesisLedger({ chat: longer, optionLabels: OPTIONS, cache: first.cache, skipIds: plan.skip, callLLM: m.callLLM });
  assert.deepEqual(m.calls.filter(c => c.kind === "ledger_extract").map(c => c.targets), [["m4"]]);
  assert.equal(second.entries.m3.fallbackReason, "skipped");
  assert.equal(second.cache.m3, undefined);

  // An edited message is tried again.
  const edited = longer.map((msg, i) => i === 3 ? { ...msg, text: `${msg.text} (edited)` } : msg);
  assert.deepEqual(planWarmPass(second.cache, skipped, edited).attempt, ["m3"]);
});

test("callbacks wiring: Adaptive messages trigger a warm-up, the Synthesiser builds on the same lane", async () => {
  const source = await readFile(new URL("./callbacks.js", import.meta.url), "utf8");
  assert.match(source, /round\.get\("facilitation"\) === "adaptive"/);
  assert.match(source, /!round\.get\("isPractice"\)/);
  assert.match(source, /isFormalHumanMessage\(tail\) && ledgerWarmupApplies\(game, round\)\) ledgerWarmer\.warm\(/);
  assert.match(source, /await ledgerWarmer\.exclusive\(laneKey,/);
  assert.match(source, /refresh === 0 \? withoutLatestSource\(cached, current\) : cached/);
  assert.match(source, /process\.env\.LEDGER_WARMUP !== "off"/);
  // The warm-up never takes the automatic-intervention lock.
  const warmFn = source.slice(source.indexOf("function warmRoundLedger"), source.indexOf("export function dispatchChat"));
  assert.doesNotMatch(warmFn, /beginInFlight|AUTOMATIC_PIPELINE_GROUP|finalizeAuditLog/);
});
