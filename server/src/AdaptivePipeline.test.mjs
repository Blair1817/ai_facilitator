import { mockSynthesisCoverage } from "../test/participant_sim/fakes/synthesisCoverage.mjs";
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
function world({ chat = lines.map((text, i) => ({ text, sender: { id: names[i % 3], name: names[i % 3] } })), remaining = 400_000, condition = "adaptive", taskIndex = 0 } = {}) {
  const roster = [...new Set(chat.filter(m => m.sender.id !== "ai" && m.speakerType !== "timer_reminder").map(m => m.sender.name))];
  while (roster.length < 3) roster.push(names.find(n => !roster.includes(n)));
  const players = roster.map(name => makeFakePlayer({ id: name, name, hexCode: "ffffff" }));
  const game = new FakeGame({}, players), round = new FakeRound({ taskIndex, taskVersion: "A", facilitation: condition,
    generalInfo: "Choose Norvale, Fenwick or Halden using only public task information.", decisionOptions: ["Norvale", "Fenwick", "Halden"].map(label => ({ id: label, label })) }, game);
  const stage = new FakeStage({ name: "Task" }, round); stage.currentGame = game;
  game.currentRound = round; game.currentStage = stage;
  for (const p of players) { p.currentGame = game; p.round = new FakeScope("playerRound"); p.stage = new FakeScope("playerStage"); }
  const transcript = chat.map((m, i) => ({ stage: "Discussion", speakerType: "human", messageType: "human", ...m, messageId: `canonical-${i}` }));
  game.set(`chat_round_${taskIndex}`, transcript);
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
    else if (kind === "validator") data = mockSynthesisCoverage(validators[v++] ?? flags(), body.messages[1].content);
    else data = generators?.[g++] ?? (system.includes("# synthesiser.md") ? synthesis : system.includes("# challenger.md") ? challengerReply : staticReply);
    await mutate?.(kind, w, requests);
    return provider(data);
  };
  try {
    const result = await harness.handleChat(undefined, { game: w.game, adaptiveTrigger: trigger });
    return { requests, result, audit: readAppendOnlyAttribute(w.game, "llmLog").at(-1),
      published: w.game.get(`chat_round_${w.round.get("taskIndex")}`).filter(m => m.facilitatorOrigin === "LLM_GENERATED") };
  } finally {
    harness.adaptiveCloseoutScheduler.cancel(w.game, "test_complete");
    timers.forEach(clearTimeout); globalThis.fetch = oldFetch; globalThis.setTimeout = oldTimeout;
  }
}
// With equal urgency and waiting time, the remaining role tie is uniform.
test("equally urgent new scrutiny and integration candidates tie uniformly, at any remaining time", async () => {
  for (const remaining of [400_000, 120_000]) {
    for (const [value, role, act] of [[0, "challenger", "EVIDENCE_AUDIT"], [0.99, "synthesiser", "EVIDENCE_CONSOLIDATION"]]) {
      const w = world({ remaining }), raw = { ...need(w), integrationCandidate: need(w, "INTEGRATE"), integrationStatus: "qualified" };
      const r = await withRandom(value, () => run(w, { assessments: [raw] }));
      assert.equal(r.published.length, 1);
      assert.equal(r.audit.plan.role, role, `${remaining}/${value}`);
      assert.equal(r.audit.plan.requiredReasoningAct, act);
      assert.equal(r.audit.selection.mode, "random");
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
// 2026-11-11: an Adaptive Specialist never repairs; any failure goes to Static.
test("outside-plan grounding is not repaired; the Specialist failure reaches Static", async () => {
  const w = world(), invalid = { ...challengerReply, groundingMessageIds: ["m0"] };
  const r = await run(w, { generators: [invalid, staticReply] });
  assert.equal(r.audit.recovery.counts.generatorRepair, 0);
  assert.equal(r.published.length, 1);
  assert.equal(r.audit.selectedRole, "STATIC");
  assert.equal(r.audit.fallbackRoute, "SPECIALIST_TO_STATIC_POLICY");
  assert.equal(r.audit.modelCallCount, r.requests.length);
});
test("a Validator-rejected Specialist goes to Static; Static keeps its own bounded repair", async () => {
  const r = await run(world(), { validators: [flags("notGrounded"), flags("notGrounded"), flags()] });
  assert.equal(r.audit.modelCallCount, r.requests.length);
  assert.equal(r.audit.recovery.counts.generatorRepair, 0);
  assert.equal(r.audit.recovery.counts.staticRepair, 1);
  assert.equal(r.audit.fallbackPublished, true);
  assert.equal(r.requests.length, 7);
});
test("a repetition rejection uses Static without a reassessment or redraw, even with another verified need", async () => {
  const w = world(), raw = { ...need(w), integrationCandidate: need(w, "INTEGRATE"), integrationStatus: "qualified" };
  const r = await withRandom(0, () => run(w, { assessments: [raw], validators: [flags("repetition"), flags()] }));
  assert.equal(r.requests.filter(x => x.kind === "assessor").length, 1, "no reassessment call");
  assert.equal(r.audit.recovery.counts.generatorRepair, 0);
  assert.equal(r.audit.fallbackPublished, true);
  assert.equal(r.audit.selectedRole, "STATIC");
});
test("<=20s starts no automatic call, and time/stage/snapshot changes still prevent late publication", async () => {
  const floor = await run(world({ remaining: 20_000 })); assert.equal(floor.requests.length, 0);
  for (const change of ["time", "snapshot-edit", "snapshot-delete", "end", "round"]) {
    const w = world();
    const r = await run(w, { mutate(kind, w) {
      if (kind !== "generator") return;
      if (change === "time") w.game.set("deadline", Date.now() + 20_000);
      else if (change === "end") w.stage.set("ended", true);
      else if (change === "round") w.game.currentRound = new FakeRound({}, w.game);
      else if (change === "snapshot-delete") w.game.set("chat_round_0", w.game.get("chat_round_0").slice(1));
      else w.game.set("chat_round_0", w.game.get("chat_round_0").map((m, i) => i ? m : { ...m, text: "Edited old public message" }));
    } });
    assert.equal(r.published.length, 0, change);
    assert.deepEqual(r.requests.map(r => r.kind), ["assessor", "generator"], change);
    assert.ok(r.audit.cancellation, change);
  }
});
test("automatic Challenger runs allow ordinary appends, but Facilitator messages still supersede", async () => {
  const addHuman = (w, n) => w.game.set("chat_round_0", [...w.game.get("chat_round_0"),
    ...Array.from({ length: n }, (_, i) => ({ ...w.chat[0], messageId: `during-${i}`, text: `during ${i}` }))]);
  const message = world();
  const ok = await run(message, { mutate(kind, w) { if (kind === "generator") addHuman(w, 1); } });
  assert.equal(ok.published.length, 1, "one new human message no longer discards a message-triggered result");
  for (const n of [2, 3, 12]) {
    const w = world();
    assert.equal((await run(w, { mutate(kind, w) { if (kind === "generator") addHuman(w, n); } })).published.length, 1);
  }

  const facilitator = world();
  const superseded = await run(facilitator, { mutate(kind, w) {
    if (kind === "generator") w.game.set("chat_round_0", [...w.game.get("chat_round_0"),
      { ...w.chat[0], messageId: "ai-reply", text: "Facilitator reply", messageType: "facilitator", speakerType: "facilitator", sender: { id: "ai", name: "Facilitator" } }]);
  } });
  assert.equal(superseded.published.length, 0, "a newer Facilitator message always supersedes the older automatic result");
});

test("a correction during synthesis validation refreshes coverage before publishing", async () => {
  const w = world({ remaining: 180_000 });
  w.game.set("messagesSinceLastPublish", 0);
  const raw = { ...need(w), integrationCandidate: need(w, "INTEGRATE"), integrationStatus: "qualified" };
  const correction = "Correction: Norvale can send reminders after the update.";
  const updated = { ...synthesis,
    message: synthesis.message.replace("Its app cannot send reminders.", correction),
    groundingMessageIds: [...synthesis.groundingMessageIds, "m6"] };
  const result = await run(w, { assessments: [raw], generators: [synthesis, updated],
    trigger: { triggerSource: "time_180", triggerSources: ["time_180"] },
    mutate(kind, { game, chat }, requests) {
      if (kind === "validator" && requests.length === 3) game.append("chat_round_0", { ...chat[0], messageId: "correction", text: correction });
    } });
  assert.deepEqual(result.requests.map(request => request.kind), ["assessor", "generator", "validator", "generator", "validator"]);
  assert.equal(result.published.length, 1);
  assert.equal(result.published[0].text, updated.message);
  assert.equal(result.audit.synthesisContextRefreshed, true);
  assert.ok(result.audit.plan.synthesisCoverage.sourceMessageIds.includes("m6"));
  const validatorContext = result.requests.at(-1).messages[1].content;
  assert.equal(validatorContext.split(lines[1]).length - 1, 1, "source text occurs only in the transcript");
  assert.match(validatorContext, /"evidence":\[\{"messageId":"m0"\}/);
});

test("second-round Task A still gets a validated prompt when discussion keeps overtaking synthesis", async () => {
  const w = world({ taskIndex: 1, remaining: 120_000 });
  w.game.set("chat_round_0", [{ ...w.chat[0], text: "Previous round only" }]);
  const result = await run(w, { assessments: [need(w, "INTEGRATE")],
    mutate(kind, { game, chat }, requests) {
      if (kind === "generator" && requests.length <= 3) {
        game.append("chat_round_1", { ...chat[0], messageId: `update-${requests.length}`, text: `Public update ${requests.length}.` });
      }
    } });
  assert.deepEqual(result.requests.map(request => request.kind), ["assessor", "generator", "generator", "generator", "validator"]);
  assert.equal(result.audit.synthesisRefreshExhausted, true);
  assert.equal(result.published[0]?.role, staticReply.role);
  assert.match(result.requests.at(-1).messages[1].content, /Public update 3/);
  assert.equal(w.game.get("chat_round_0").length, 1);
});

test("a timed synthesis overtaken twice stays eligible for retry", async () => {
  const w = world({ remaining: 120_000 });
  w.game.set("messagesSinceLastPublish", 0);
  const raw = { ...need(w), integrationCandidate: need(w, "INTEGRATE"), integrationStatus: "qualified" };
  const result = await run(w, { assessments: [raw],
    trigger: { triggerSource: "time_120", triggerSources: ["time_120"] },
    mutate(kind, { game, chat }, requests) {
      if (kind === "generator") game.append("chat_round_0", { ...chat[0], messageId: `update-${requests.length}`, text: "New public task information." });
    } });
  assert.equal(result.published.length, 0);
  assert.equal(result.audit.reasonCode, "SYNTHESIS_CONTEXT_CHANGED");
  assert.equal(result.result.deferred, true);
});

// 2026-11-11: C is silent across the last 12 public messages (silence rule).
const silentC = () => [...lines, ...lines].map((text, i) => ({ text: `${text} (${i})`, sender: { id: names[i % 2], name: names[i % 2] } }));
test("a participation invitation is dropped if its target contributes before publication", async () => {
  const w = world({ chat: silentC() });
  const invite = { role: "INFORMATION_EXPANDER", message: "@[C], anything to share from your notes? No worries if not.", groundingMessageIds: [] };
  const result = await run(w, { generators: [invite, staticReply],
    mutate(kind, { game, chat }, requests) {
      if (kind === "validator" && requests.length === 2) game.append("chat_round_0", {
        ...chat[0], sender: { id: "C", name: "C" }, messageId: "c-resumed", text: "I found one other transport detail.",
      });
    } });
  assert.equal(result.audit.specialistFailure?.selection?.operation, "participation_gap");
  assert.equal(result.published[0]?.role, staticReply.role);
  assert.doesNotMatch(result.published[0].text, /@/);
  assert.equal(w.round.get("participationInvites"), undefined);
});

test("a Challenger cannot tag a participant outside its cited public evidence; the failure goes to Static", async () => {
  const w = world();
  const ungroundedMention = { ...challengerReply, message: "@[A], which public facts support the preference for Norvale?" };
  const result = await run(w, { generators: [ungroundedMention, staticReply] });
  assert.equal(result.published[0]?.text, staticReply.message);
  assert.equal(result.requests.filter(request => request.kind === "generator").length, 2);
  assert.match(JSON.stringify(result.audit.specialistFailure), /UNSUPPORTED_MENTION_TARGET/);
});

test("a delivered participation invitation gives the next message checkpoint to substantive needs", async () => {
  const w = world({ chat: silentC() });
  const invitation = { role: "INFORMATION_EXPANDER", message: "@[C], anything to share from your notes? No worries if not.", groundingMessageIds: [] };
  const first = await run(w, { generators: [invitation] });
  assert.equal(first.published[0]?.role, invitation.role);
  assert.equal(w.round.get("participationInvites").C.count, 1);

  for (let i = 0; i < 6; i++) w.game.append("chat_round_0", { ...w.chat[i], messageId: `next-${i}` });
  w.game.set("lastAttemptTimestamp", Date.now() - 16_000);
  const [priorInvitation] = w.round.get("cognitiveInterventionHistory");
  const assessment = { ...need(w), semanticReview: { key: "Norvale preference without support",
    matches: [{ id: priorInvitation.planId, relation: "different", responseEvidence: [], newEvidence: [] }] } };
  const second = await run(w, { assessments: [assessment] });
  assert.deepEqual(second.audit.silenceRule.eligible, [], "not re-invited within 12 messages");
  assert.equal(second.published.at(-1)?.role, challengerReply.role, JSON.stringify({
    selection: second.audit.selection, reason: second.audit.reason, specialistFailure: second.audit.specialistFailure,
  }));
  assert.equal(w.round.get("participationInvites").C.count, 1);
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


test("a full synthesis above 55 words is preserved, gets a larger token budget, and can cite beyond detector seeds", async () => {
  const extra = " The shuttle stops at the main hall only on weekdays and does not serve the riverside entrance on weekends.";
  const chat = lines.map((text, i) => ({ text: i === 0 ? text + extra : text,
    sender: { id: names[i % 3], name: names[i % 3] } }));
  const w = world({ chat });
  const summary = chat.map(m => m.text).join(" ") + " How do you weigh all these reported points together?";
  assert.ok(summary.split(/\s+/).length > 55);
  const r = await run(w, { assessments: [need(w, "INTEGRATE")], generators: [{ role: "INFORMATION_SYNTHESISER", message: summary,
    groundingMessageIds: chat.map((_, i) => `m${i}`) }] });
  assert.equal(r.published.length, 1);
  assert.equal(r.published[0].content, summary);
  assert.equal(r.audit.plan.maxWords, null);
  assert.deepEqual(r.audit.plan.evidenceIds, chat.map((_, i) => `m${i}`));
  assert.ok((r.requests.find(x => x.kind === "generator").max_tokens ?? r.requests.find(x => x.kind === "generator").max_completion_tokens) >= 8192);
  assert.equal(r.audit.validator.coverage.passed, true);
});

test("an incomplete synthesis coverage audit cannot publish even when all boolean flags say pass", async () => {
  const w = world();
  const r = await run(w, { assessments: [need(w, "INTEGRATE")],
    validators: [{ ...flags(), synthesisCoverage: [] }, flags()] });
  assert.equal(r.published.length, 1);
  assert.equal(r.published[0].content, staticReply.message);
  assert.equal(r.audit.selectedRole, "STATIC");
});
