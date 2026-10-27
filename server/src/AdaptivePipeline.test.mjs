// Real callbacks with a fake Empirica store, controlled provider responses and
// no external requests. These tests verify orchestration, not model quality.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { FakeGame, FakeRound, FakeStage, FakeScope, makeFakePlayer } from "../test/participant_sim/fakes/fakeStore.mjs";
import { getOfflineCallbacksHarness } from "../test/participant_sim/fakes/loadCallbacks.mjs";
import { readAppendOnlyAttribute } from "./AppendOnlyAttribute.mjs";
import { VALIDATOR_CRITERIA } from "./SemanticValidator.js";
import { selectAdaptiveAssessment } from "./AdaptiveEvidence.mjs";
// 2026-10-26: legacy single-need fixtures are converted to independent candidates.
import { toDetectorOutput, toDetectorText } from "../test/participant_sim/fakes/detectorOutput.mjs";
const asDetector = data => typeof data === "string" ? toDetectorText(data) : toDetectorOutput(data);
async function withRandom(value, task) {
  const original = Math.random; Math.random = () => value;
  try { return await task(); } finally { Math.random = original; }
}
const dir = path.dirname(fileURLToPath(import.meta.url));
process.argv[1] = path.join(dir, "fake-entry.js");
const replay = JSON.parse(fs.readFileSync(path.join(dir, "../test/fixtures/adaptive-closeout-replay.json")));
test("five runtime closeout/reselection few-shots pass schema, evidence and expected selection", async () => {
  const { validateAgainstAssessorSchema } = await import("./SemanticAssessor.js");
  const cases = JSON.parse(fs.readFileSync(path.join(dir, "../test/fixtures/adaptive-closeout-examples.json")));
  for (const c of cases) {
    const output = toDetectorOutput(c.output);
    assert.equal(validateAgainstAssessorSchema(output).ok, true, c.id);
    const input = c.input;
    const selected = selectAdaptiveAssessment(output, {
      chat: input.CUMULATIVE_PUBLIC_CONTEXT.map(m => ({ ...m, sender: { id: m.sender, name: m.sender } })),
      roster: input.ACTIVE_PARTICIPANT_NAMES, optionLabels: ["Norvale", "Halden", "Fenwick"],
      remainingTimeMs: input.SCHEDULING.remainingTimeMs, triggerSource: input.SCHEDULING.triggerSource,
      excluded: input.EXCLUDED_SEMANTIC_TARGETS,
    });
    assert.equal(selected.need, c.output.need, c.id);
    assert.ok(!selected.downgradedReason, `${c.id}: ${selected.downgradedReason}`);
  }
});
const lines = ["Norvale has indoor signs.", "Fenwick has outdoor seating.", "Norvale has displays across the courtyard.", "Norvale app cannot send reminders.", "I prefer Norvale.", "Norvale seems good to me too."];
const names = ["A", "B", "C"];
function world({ chat = lines.map((text, i) => ({ text, sender: { id: names[i % 3], name: names[i % 3] } })), remaining = 400_000, condition = "adaptive" } = {}) {
  const roster = [...new Set(chat.filter(m => m.sender.id !== "ai" && m.speakerType !== "timer_reminder").map(m => m.sender.name))];
  while (roster.length < 3) roster.push(names.find(n => !roster.includes(n)));
  const players = roster.map(name => makeFakePlayer({ id: name, name, hexCode: "ffffff" }));
  const game = new FakeGame({}, players), round = new FakeRound({ taskIndex: 0, taskVersion: "A", facilitation: condition,
    generalInfo: "Choose Norvale, Fenwick or Halden using only public task information.", decisionOptions: ["Norvale", "Fenwick", "Halden"].map(label => ({ id: label, label })) }, game);
  const stage = new FakeStage({ name: "Task" }, round); stage.currentGame = game;
  game.currentRound = round; game.currentStage = stage;
  for (const p of players) { p.currentGame = game; p.round = new FakeScope("playerRound"); p.stage = new FakeScope("playerStage"); }
  const transcript = chat.map((m, i) => ({ stage: "Discussion", speakerType: "human", messageType: "human", ...m, messageId: `canonical-${i}` }));
  game.set("chat_round_0", transcript);
  game.set("deadline", Date.now() + remaining); game.set("taskStartTime", Date.now() - 100_000);
  const humans = transcript.filter(m => m.speakerType === "human").length;
  game.set("humanMessageCount", humans - 1); game.set("messagesSinceLastPublish", humans - 1);
  return { game, round, stage, chat: transcript };
}
const none = { need: "NONE", operation: null, target: null, rationale: "No other open need" };
function need(w, kind = "SCRUTINIZE") {
  const ids = kind === "INTEGRATE" ? [0, 2, 3] : [4, 5];
  return { need: kind, operation: kind === "INTEGRATE" ? "fragmented_evidence" : "unsupported_claim", rationale: "Public evidence",
    target: { label: kind === "INTEGRATE" ? "Unconnected Norvale points" : "Norvale preference without support", optionLabels: ["Norvale"], criteria: [],
      messageIds: ids.map(i => `m${i}`), evidence: ids.map(i => ({ messageId: `m${i}`, span: w.chat[i].text })) } };
}
const staticReply = { role: "STATIC", message: "What else from your notes would help the discussion?", groundingMessageIds: [] };
const challengerReply = { role: "EVIDENCE_CHALLENGER", message: "Which public facts support the preference for Norvale?", groundingMessageIds: ["m4", "m5"] };
const synthesis = { role: "INFORMATION_SYNTHESISER", message: "1. Norvale has indoor signs.\n2. Displays are across the courtyard.\n3. Its app cannot send reminders.\nHow do you weigh these points?", groundingMessageIds: ["m0", "m2", "m3"] };
const flags = (...failed) => Object.fromEntries(VALIDATOR_CRITERIA.map(k => [k, failed.includes(k)]));
const provider = data => new Response(JSON.stringify({ choices: [{ message: { content: typeof data === "string" ? data : JSON.stringify(data) }, finish_reason: "stop" }] }), { headers: { "content-type": "application/json" } });
async function run(w, { assessments = [need(w)], generators, validators = [], trigger, mutate } = {}) {
  const harness = await getOfflineCallbacksHarness(), requests = [];
  const oldFetch = globalThis.fetch, oldTimeout = globalThis.setTimeout, timers = [];
  globalThis.setTimeout = (...args) => { const t = oldTimeout(...args); timers.push(t); return t; };
  let a = 0, g = 0, v = 0;
  globalThis.fetch = async (_url, options) => {
    const body = JSON.parse(options.body), system = body.messages[0].content;
    const kind = system.startsWith("# assessor.md") ? "assessor" : system.startsWith("# validator.md") ? "validator" : "generator";
    requests.push({ kind, ...body });
    let data;
    if (kind === "assessor") data = asDetector(assessments[Math.min(a++, assessments.length - 1)]);
    else if (kind === "validator") data = validators[v++] ?? flags();
    else data = generators?.[g++] ?? (system.includes("# synthesiser.md") ? synthesis : system.includes("# challenger.md") ? challengerReply : staticReply);
    await mutate?.(kind, w, requests);
    return provider(data);
  };
  try {
    await harness.handleChat(undefined, { game: w.game, adaptiveTrigger: trigger });
    return { requests, audit: readAppendOnlyAttribute(w.game, "llmLog").at(-1),
      published: w.game.get("chat_round_0").filter(m => m.facilitatorOrigin === "LLM_GENERATED") };
  } finally {
    harness.adaptiveCloseoutScheduler.cancel(w.game, "test_complete");
    timers.forEach(clearTimeout); globalThis.fetch = oldFetch; globalThis.setTimeout = oldTimeout;
  }
}
// 2026-10-26: no priority between needs. Both verified candidates enter the
// pool and the role is drawn uniformly (Math.random is fixed here).
test("verified scrutiny and integration are both eligible and the role is drawn uniformly, at any remaining time", async () => {
  for (const remaining of [400_000, 120_000]) {
    for (const [value, role, act] of [[0, "challenger", "EVIDENCE_AUDIT"], [0.99, "synthesiser", "EVIDENCE_CONSOLIDATION"]]) {
      const w = world({ remaining }), raw = { ...need(w), integrationCandidate: need(w, "INTEGRATE"), integrationStatus: "qualified" };
      const r = await withRandom(value, () => run(w, { assessments: [raw] }));
      assert.equal(r.published.length, 1);
      assert.equal(r.audit.plan.role, role, `${remaining}/${value}`);
      assert.equal(r.audit.plan.requiredReasoningAct, act);
      assert.equal(r.audit.selection.mode, "randomized");
      assert.deepEqual(r.audit.selection.pool.map(c => c.role), ["challenger", "synthesiser"]);
      assert.equal(r.audit.selection.probability, 0.5);
      assert.equal(Object.hasOwn(r.audit.plan.scheduling, "integrationPriority"), false);
      assert.doesNotMatch(r.requests[0].messages[1].content, /"priority"|fixedIntegrationPriority/);
      assert.ok(r.audit.visibleWordCount <= (role === "challenger" ? 50 : 55));
    }
  }
});
test("180s independent scan can integrate below six messages; an already-covered/empty scan does not emit Static", async () => {
  for (const complete of [false, true]) {
    const w = world({ remaining: 180_000 }); w.game.set("messagesSinceLastPublish", 0);
    const raw = complete ? { ...none, integrationCandidate: null, integrationStatus: "already_covered" }
      : { ...need(w), integrationCandidate: need(w, "INTEGRATE"), integrationStatus: "qualified" };
    const r = await run(w, { assessments: [raw], trigger: { triggerSource: "time_180", triggerSources: ["time_180"] } });
    assert.equal(r.published.length, complete ? 0 : 1);
    assert.equal(r.requests.length, complete ? 1 : 3);
  }
});
test("insufficient integration evidence is never relabelled into a Synthesiser plan", () => {
  const w = world(), raw = { ...need(w), integrationCandidate: { ...need(w, "INTEGRATE"), target: { ...need(w, "INTEGRATE").target, messageIds: ["m0"], evidence: [{ messageId: "m0", span: lines[0] }] } } };
  const selection = selectAdaptiveAssessment(toDetectorOutput(raw), { chat: w.chat, roster: names, remainingTimeMs: 100_000 });
  assert.equal(selection.role, "challenger");
  assert.equal(selection.integrationObservation.reason, "INSUFFICIENT_DISTINCT_PARTICIPANTS");
});
test("Assessor missing criteria gets one structure repair followed by evidence validation", async () => {
  const w = world(), invalid = need(w); delete invalid.target.criteria;
  const r = await run(w, { assessments: [invalid, need(w)] });
  assert.deepEqual(r.requests.map(r => r.kind), ["assessor", "assessor", "generator", "validator"]);
  assert.equal(r.audit.recovery.counts.assessorRepair, 1);
  assert.equal(r.published.length, 1);
  assert.match(r.requests[1].messages.at(-1).content, /Never invent quotes/);
  const broken = await run(world(), { assessments: [invalid] });
  assert.equal(broken.audit.selectedRole, "STATIC");
  assert.equal(broken.requests.filter(r => r.kind === "assessor").length, 2);
});
test("outside-plan grounding repairs within original IDs; repeated failure reaches Static", async () => {
  for (const repaired of [true, false]) {
    const w = world(), invalid = { ...challengerReply, groundingMessageIds: ["m0"] };
    const r = await run(w, { generators: [invalid, repaired ? challengerReply : invalid, staticReply] });
    assert.equal(r.audit.recovery.counts.generatorRepair, 1);
    assert.equal(r.published.length, 1);
    assert.equal(r.audit.selectedRole, repaired ? "challenger" : "STATIC");
    assert.match(r.requests[2].messages[1].content, /Allowed grounding IDs remain exactly \["m4","m5"\]/);
    assert.equal(r.audit.modelCallCount, r.requests.length);
  }
});
test("unsupported facts use one same-plan repair; Static keeps its own bounded repair", async () => {
  const r = await run(world(), { validators: [flags("notGrounded"), flags("notGrounded"), flags("repetition"), flags()] });
  assert.equal(r.audit.modelCallCount, r.requests.length);
  assert.equal(r.audit.recovery.counts.generatorRepair, 1);
  assert.equal(r.audit.recovery.counts.staticRepair, 1);
  assert.equal(r.audit.fallbackPublished, true);
  assert.equal(r.requests.length, 9);
});
// 2026-10-26: a repetition rejection redraws once from the remaining verified
// pool without a new detector call; an empty pool ends in the Static policy.
test("repetition redraws once from the remaining verified pool; an empty pool uses Static", async () => {
  const single = await run(world(), { assessments: [need(world())], validators: [flags("repetition"), flags()] });
  assert.equal(single.requests.filter(r => r.kind === "assessor").length, 1, "no reassessment call");
  assert.equal(single.audit.recovery.counts.reselection, 1);
  assert.equal(single.audit.recovery.counts.generatorRepair, 0, "repetition is not a paraphrase repair");
  assert.equal(single.audit.reselectionResult.need, "NONE");
  assert.equal(single.audit.fallbackPublished, true);
  assert.equal(single.audit.selectedRole, "STATIC");

  const w = world(), raw = { ...need(w), integrationCandidate: need(w, "INTEGRATE"), integrationStatus: "qualified" };
  const both = await withRandom(0, () => run(w, { assessments: [raw], validators: [flags("repetition"), flags()] }));
  assert.equal(both.requests.filter(r => r.kind === "assessor").length, 1);
  assert.equal(both.audit.recovery.counts.reselection, 1);
  assert.equal(both.audit.reselectionResult.role, "synthesiser");
  assert.equal(both.audit.selection.redraw.role, "synthesiser");
  assert.equal(both.audit.selection.redraw.probability, 1);
  assert.equal(both.published.length, 1);
  assert.equal(both.audit.selectedRole, "synthesiser");
});
test("<=20s starts no automatic call, and time/context/end changes during calls prevent late publication", async () => {
  const floor = await run(world({ remaining: 20_000 })); assert.equal(floor.requests.length, 0);
  for (const change of ["time", "summary", "objection", "withdrawal", "end", "round"]) {
    const w = world();
    const r = await run(w, { mutate(kind, w) {
      if (kind !== "generator") return;
      if (change === "time") w.game.set("deadline", Date.now() + 20_000);
      else if (change === "end") w.stage.set("ended", true);
      else if (change === "round") w.game.currentRound = new FakeRound({}, w.game);
      // 2026-10-25: message-triggered runs tolerate <= 2 new human messages,
      // so a context change here adds three.
      else w.game.set("chat_round_0", [...w.game.get("chat_round_0"),
        ...[1, 2, 3].map(i => ({ ...w.chat[0], messageId: `new-context-${i}`, text: `${change} ${i}` }))]);
    } });
    assert.equal(r.published.length, 0, change);
    assert.deepEqual(r.requests.map(r => r.kind), ["assessor", "generator"], change);
    assert.ok(r.audit.cancellation, change);
  }
});
test("stale tolerance: message runs publish after <=2 new human messages; closeout runs and new Facilitator messages stay strict", async () => {
  const addHuman = (w, n) => w.game.set("chat_round_0", [...w.game.get("chat_round_0"),
    ...Array.from({ length: n }, (_, i) => ({ ...w.chat[0], messageId: `during-${i}`, text: `during ${i}` }))]);
  const message = world();
  const ok = await run(message, { mutate(kind, w) { if (kind === "generator") addHuman(w, 1); } });
  assert.equal(ok.published.length, 1, "one new human message no longer discards a message-triggered result");
  const two = world();
  assert.equal((await run(two, { mutate(kind, w) { if (kind === "generator") addHuman(w, 2); } })).published.length, 1);

  const closeout = world({ remaining: 180_000 }); closeout.game.set("messagesSinceLastPublish", 0);
  const raw = { ...need(closeout), integrationCandidate: need(closeout, "INTEGRATE"), integrationStatus: "qualified" };
  const strict = await run(closeout, { assessments: [raw], trigger: { triggerSource: "time_180", triggerSources: ["time_180"] },
    mutate(kind, w) { if (kind === "generator") addHuman(w, 1); } });
  assert.equal(strict.published.length, 0, "scheduler-triggered closeout keeps the strict rule");
  assert.ok(strict.audit.cancellation);

  const facilitator = world();
  const superseded = await run(facilitator, { mutate(kind, w) {
    if (kind === "generator") w.game.set("chat_round_0", [...w.game.get("chat_round_0"),
      { ...w.chat[0], messageId: "ai-reply", text: "Facilitator reply", messageType: "facilitator", speakerType: "facilitator", sender: { id: "ai", name: "Facilitator" } }]);
  } });
  assert.equal(superseded.published.length, 0, "a newer Facilitator message always supersedes the older automatic result");
});
test("ten real checkpoints are replayable; checkpoint45 makes no new automatic call", async () => {
  assert.equal(replay.gameId, "adaptive-replay-session");
  assert.doesNotMatch(JSON.stringify(replay), /\b[0-9A-Z]{26}\b|https?:\/\//);
  for (const checkpoint of replay.checkpoints) {
    for (const message of checkpoint.chat) {
      assert.deepEqual(Object.keys(message.sender).sort(), ["id", "name"]);
      assert.ok(message.timestamp >= 0 && message.timestamp < 900_000);
      if (message.speakerType === "human") assert.match(message.sender.id, /^participant-\d+$/);
    }
  }
  assert.deepEqual(replay.checkpoints.map(c => c.checkpoint), [6,8,10,13,15,21,27,33,39,45]);
  for (const fixture of replay.checkpoints) {
    const w = world({ chat: fixture.chat, remaining: fixture.remainingTimeMs });
    w.round.set("generalInfo", fixture.taskGeneralContext);
    const r = await run(w, { assessments: [fixture.detectorRawResponse],
      generators: fixture.generatorRawResponses.map(g => g.rawText) });
    assert.equal(r.audit.modelCallCount ?? 0, r.requests.length, `checkpoint ${fixture.checkpoint}`);
    if (fixture.checkpoint === 45) assert.equal(r.requests.length, 0);
    assert.ok(r.requests.length <= 13);
  }
});

test("real checkpoint33 repetition redraws once from an empty pool, then NONE uses Static, with no forced synthesis", async () => {
  const f = replay.checkpoints.find(c => c.checkpoint === 33);
  const w = world({ chat: f.chat, remaining: f.remainingTimeMs });
  w.round.set("generalInfo", f.taskGeneralContext);
  const specialist = JSON.parse(f.generatorRawResponses[0].rawText);
  const r = await run(w, { assessments: [f.detectorRawResponse, none], generators: [specialist, staticReply], validators: [flags("repetition"), flags()] });
  assert.equal(r.audit.recovery.counts.reselection, 1);
  assert.equal(r.audit.reselectionResult.need, "NONE");
  assert.equal(r.audit.fallbackPublished, true);
  assert.equal(r.audit.selectedRole, "STATIC");
  assert.match(r.audit.excludedSemanticTargets[0].target.label, /Fenwick/i);
});

test("early two-person public readiness can trigger qualified integration below six messages", async () => {
  const texts = ["Norvale has indoor signs.", "Norvale has displays across the courtyard.", "Norvale app cannot send reminders.", "Choose Norvale, ready to submit.", "Agreed, we can submit."];
  const authors = ["A", "B", "A", "A", "B"];
  const w = world({ chat: texts.map((text,i) => ({ text, sender: { id: authors[i], name: authors[i] } })) });
  const q = i => ({ messageId: `m${i}`, span: texts[i] });
  const integration = { need: "INTEGRATE", operation: "fragmented_evidence", rationale: "Three unconnected points", target: {
    label: "Norvale points", messageIds: ["m0", "m1", "m2"], evidence: [q(0),q(1),q(2)], optionLabels: ["Norvale"], criteria: [] } };
  const closeout = { proposal: { active: true, optionLabel: "Norvale", evidence: [q(3)] }, participants: [
    { participantName: "A", reviewedThroughMessageId: "m3", stance: "ready", optionLabel: "Norvale", evidence: [q(3)] },
    { participantName: "B", reviewedThroughMessageId: "m4", stance: "ready", optionLabel: "Norvale", evidence: [q(4)] },
    { participantName: "C", reviewedThroughMessageId: null, stance: "uncommitted", optionLabel: null, evidence: [] },
  ] };
  const r = await run(w, { assessments: [{ ...none, closeout, integrationCandidate: integration, integrationStatus: "qualified" }],
    generators: [{ ...synthesis, groundingMessageIds: ["m0", "m1", "m2"] }],
    trigger: { triggerSource: "early_closeout_probe", triggerSources: ["early_closeout_probe"] } });
  assert.equal(r.published.length, 1);
  assert.equal(r.audit.scheduling.stage, "early_closeout");
  assert.deepEqual(r.audit.earlyCloseout.supporters, ["A", "B"]);
  assert.equal(w.stage.get("ended"), undefined);
  assert.equal(w.round.get("finalDecisionConfirmed"), undefined);
});

test("overlapping timed/message evaluations share the durable automatic lock and never show assessment typing", async () => {
  const w = world(), harness = await getOfflineCallbacksHarness();
  const oldFetch = globalThis.fetch, oldTimeout = globalThis.setTimeout, timers = [];
  globalThis.setTimeout = (...args) => { const t = oldTimeout(...args); timers.push(t); return t; };
  let release, started; const ready = new Promise(resolve => { started = resolve; });
  let assessorCalls = 0;
  globalThis.fetch = async (_url, options) => {
    const system = JSON.parse(options.body).messages[0].content;
    if (system.startsWith("# assessor.md")) {
      assessorCalls++; started(); await new Promise(resolve => { release = resolve; }); return provider(toDetectorOutput(need(w)));
    }
    return provider(system.startsWith("# validator.md") ? flags() : challengerReply);
  };
  try {
    const first = harness.handleChat(undefined, { game: w.game });
    await ready;
    assert.ok(Object.values(w.game.get("llmInFlight")).every(e => !e.visibleResponsePending));
    w.game.set("lastAttemptTimestamp", Date.now() - 31_000); // expose lock independently of cooldown
    const second = await harness.handleChat(undefined, { game: w.game, adaptiveTrigger: { triggerSource: "time_180", triggerSources: ["time_180"] } });
    assert.equal(second.deferred, true);
    assert.equal(assessorCalls, 1);
    release(); await first;
    assert.equal(w.game.get("publishedThisRound"), 1);
    assert.equal(w.game.get("chat_round_0").filter(m => m.facilitatorOrigin === "LLM_GENERATED").length, 1);
  } finally {
    release?.(); harness.adaptiveCloseoutScheduler.cancel(w.game, "test_complete");
    timers.forEach(clearTimeout); globalThis.fetch = oldFetch; globalThis.setTimeout = oldTimeout;
  }
});
