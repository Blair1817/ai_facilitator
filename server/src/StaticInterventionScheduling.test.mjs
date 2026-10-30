import test from "node:test";
import assert from "node:assert/strict";
import { FakeGame, FakeRound, FakeStage, FakeScope, makeFakePlayer } from "../test/participant_sim/fakes/fakeStore.mjs";
import { getOfflineCallbacksHarness } from "../test/participant_sim/fakes/loadCallbacks.mjs";
import { readAppendOnlyAttribute } from "./AppendOnlyAttribute.mjs";
import { VALIDATOR_CRITERIA } from "./SemanticValidator.js";
import { createStaticInterventionScheduler, STATIC_OPPORTUNITY_KEY, STATIC_MAX_ATTEMPTS } from "./StaticInterventionScheduler.mjs";
import { createFacilitatorPublicationCoordinator } from "./FacilitatorPublication.mjs";

// Tests run the real callback entry point with a controlled clock/provider.
// No model, live Tajriba, or participant session is contacted.
const flags = (...failures) => Object.fromEntries(VALIDATOR_CRITERIA.map(k => [k, failures.includes(k)]));
const response = (data, status = 200) => new Response(JSON.stringify({
  choices: [{ message: { content: JSON.stringify(data) }, finish_reason: "stop" }],
}), { status, headers: { "content-type": "application/json" } });
const gate = () => { let release; const promise = new Promise(resolve => { release = resolve; }); return { promise, release }; };
const settle = async () => { for (let i = 0; i < 5; i++) await new Promise(resolve => setImmediate(resolve)); };
async function until(predicate) { for (let i = 0; i < 100; i++) { if (predicate()) return; await settle(); } assert.fail("Callback did not reach the controlled boundary"); }

async function fixture({ hook, remaining = 400_000 } = {}) {
  const h = await getOfflineCallbacksHarness();
  const real = { now: Date.now, fetch: globalThis.fetch, setTimeout: globalThis.setTimeout, clearTimeout: globalThis.clearTimeout };
  let time = real.now(), timerId = 0, serial = 0;
  const timers = new Map(), calls = [];
  Date.now = () => time;
  globalThis.setTimeout = (fn, delay = 0) => {
    const timer = { id: ++timerId, at: time + Math.max(0, Number(delay)), fn, unref() {} };
    timers.set(timer.id, timer); return timer;
  };
  globalThis.clearTimeout = timer => timers.delete(timer?.id);
  const players = ["Alex", "Casey", "Jordan"].map(name => makeFakePlayer({ id: name, name, hexCode: "ffffff" }));
  const game = new FakeGame({}, players), round = new FakeRound({ taskIndex: 0, taskVersion: "A", facilitation: "static",
    generalInfo: "Choose City A or City B using the public information.", decisionOptions: [{ id: "a", label: "City A" }, { id: "b", label: "City B" }] }, game);
  const stage = new FakeStage({ name: "Task" }, round); stage.currentGame = game;
  game.currentRound = round; game.currentStage = stage;
  for (const p of players) { p.currentGame = game; p.round = new FakeScope("playerRound"); p.stage = new FakeScope("playerStage"); }
  game.set("deadline", time + remaining); game.set("taskStartTime", time - 100_000);
  function add(text = "A newly shared public fact.", sender = players[serial % 3]) {
    const message = { messageId: `scheduling-human-${serial++}`, stage: "Discussion", messageType: "human", speakerType: "human",
      text, content: text, timestamp: time, sender: { id: sender.id, name: sender.get("name") } };
    game.set("chat_round_0", [...(game.get("chat_round_0") || []), message]); return message;
  }
  for (let i = 0; i < 6; i++) add(`Public fact ${i}.`);
  game.set("humanMessageCount", 5); game.set("messagesSinceLastPublish", 5);
  const f = { h, game, round, stage, players, calls, timers, add,
    state: () => round.get(STATIC_OPPORTUNITY_KEY),
    logs: () => readAppendOnlyAttribute(game, "llmLog"),
    events: () => readAppendOnlyAttribute(round, "staticInterventionEvents"),
    messages: () => game.get("chat_round_0").filter(m => m.facilitatorOrigin === "LLM_GENERATED"),
    run: extra => h.handleChat(undefined, { game, ...extra }),
    send: async (text, sender) => { add(text, sender); await f.run(); },
    jump: ms => { time += ms; },
    async advance(ms) {
      const target = time + ms;
      let steps = 0;
      while (true) {
        const next = [...timers.values()].filter(t => t.at <= target).sort((a, b) => a.at - b.at || a.id - b.id)[0];
        if (!next) break;
        assert.ok(++steps < 150, "A scheduler must not busy-loop or accumulate retry timers");
        timers.delete(next.id); time = next.at; next.fn(); await settle();
      }
      time = target; await settle();
    },
    async close() {
      stage.set("ended", true); h.staticInterventionScheduler.cancel(game); h.adaptiveCloseoutScheduler.cancel(game);
      h.Empirica.setFlusher(undefined); await settle(); timers.clear();
      Date.now = real.now; globalThis.fetch = real.fetch; globalThis.setTimeout = real.setTimeout; globalThis.clearTimeout = real.clearTimeout;
    },
  };
  globalThis.fetch = async (url, options) => {
    assert.match(String(url), /^http:\/\/127\.0\.0\.1:65535/);
    const body = JSON.parse(options.body), system = body.messages[0].content;
    const kind = system.startsWith("# validator.md") ? "validator" : "generator";
    const requested = system.includes("# Participant-requested Generalist") || system.includes("PARTICIPANT-REQUESTED SCOPE");
    const call = { kind, requested, body }; calls.push(call);
    const override = await hook?.(call, f);
    return override ?? response(kind === "validator" ? flags() : {
      role: requested ? "GENERALIST" : "STATIC",
      message: requested ? "The task asks your group to compare the shared public information and agree on one choice."
        : "What public information should the group compare next?", groundingMessageIds: [],
    });
  };
  return f;
}

for (const n of [0, 1, 2]) test(`Static publishes once with ${n} new participant messages during generation`, async () => {
  let changed = false;
  const f = await fixture({ hook: async (call, f) => {
    if (call.kind !== "generator" || changed) return;
    changed = true; for (let i = 0; i < n; i++) await f.send(`New public point ${i}.`);
  } });
  try {
    await f.run(); assert.equal(f.messages().length, 1); assert.equal(f.state().status, "PUBLISHED");
    assert.equal(f.calls.length, 2); assert.equal(f.game.get("humanMessageCount"), 6 + n);
    await f.advance(31_000); assert.equal(f.calls.length, 2);
    assert.equal(f.events().filter(e => e.reasonCode === "PUBLISHED").length, 1);
  } finally { await f.close(); }
});

for (const phase of ["generator", "validator"]) test(`3 new messages during ${phase} discard the old candidate and retry fresh without a new message`, async () => {
  let changed = false;
  const f = await fixture({ hook: async (call, f) => {
    if (call.kind !== phase || changed) return;
    changed = true; for (let i = 0; i < 3; i++) await f.send(`Fresh retry context ${i}.`);
  } });
  try {
    await f.run(); const opportunityId = f.state().opportunityId;
    assert.equal(f.messages().length, 0); assert.equal(f.state().status, "PENDING");
    assert.equal(f.logs().find(e => e.attemptId)?.reasonCode, "STALE_CONTEXT");
    assert.equal(f.calls.filter(c => c.kind === "validator").length, phase === "generator" ? 0 : 1);
    await f.advance(29_999); assert.equal(f.messages().length, 0);
    await f.advance(1); assert.equal(f.messages().length, 1);
    assert.equal(f.state().opportunityId, opportunityId); assert.equal(f.state().attemptCount, 2);
    assert.match(f.calls.filter(c => c.kind === "generator").at(-1).body.messages[1].content, /Fresh retry context 2/);
    assert.equal(f.game.get("humanMessageCount"), 9, "Timer retry must not manufacture a human message");
  } finally { await f.close(); }
});

test("a cooldown-blocked eligible checkpoint retries on the timer after participants go silent", async () => {
  const f = await fixture();
  try {
    f.game.set("lastAttemptTimestamp", Date.now() - 20_000);
    await f.run(); assert.equal(f.calls.length, 0); assert.equal(f.state().status, "PENDING");
    assert.ok(f.events().some(e => e.reasonCode === "COOLDOWN_ACTIVE"));
    await f.advance(9_999); assert.equal(f.calls.length, 0);
    await f.advance(1); assert.equal(f.messages().length, 1); assert.equal(f.game.get("humanMessageCount"), 6);
  } finally { await f.close(); }
});

test("multiple checkpoints coalesce while the generation lock is held, then retry on release", async () => {
  const blocked = gate(); let began = false;
  const f = await fixture({ hook: async call => { if (call.kind === "generator" && !began) { began = true; await blocked.promise; } } });
  try {
    const first = f.run(); await until(() => began); const id = f.state().opportunityId;
    f.jump(31_000); for (let i = 0; i < 3; i++) await f.send(`Queued public point ${i}.`);
    assert.equal(f.calls.length, 1); assert.equal(f.state().opportunityId, id);
    assert.equal(f.logs().filter(e => e.reasonCode === "LOCK_BUSY").length, 3);
    blocked.release(); await first; await f.advance(0);
    assert.equal(f.messages().length, 1); assert.equal(f.state().attemptCount, 2);
    assert.equal(f.state().opportunityId, id); assert.equal(f.calls.length, 3);
  } finally { blocked.release(); await f.close(); }
});

for (const order of ["requested-first", "automatic-first"]) test(`${order}: request wins; automatic waits for later discussion and rebuilds`, async () => {
  const auto = gate(), request = gate(); let autoStarted = false, requestedStarted = false;
  const f = await fixture({ hook: async call => {
    if (call.kind !== "generator") return;
    if (!call.requested && !autoStarted) { autoStarted = true; await auto.promise; }
    else if (call.requested) { requestedStarted = true; await request.promise; }
  } });
  try {
    const first = f.run(); await until(() => autoStarted);
    f.add("@[Facilitator] Can you clarify the task?"); const requested = f.run(); await until(() => requestedStarted);
    if (order === "requested-first") { request.release(); await requested; auto.release(); await first; }
    else { auto.release(); await first; assert.equal(f.messages().length, 0); request.release(); await requested; }
    assert.equal(f.messages().length, 1); assert.equal(f.messages()[0].facilitatorTrigger, "PARTICIPANT_REQUEST");
    assert.equal(f.logs().find(e => e.participantRequested)?.outcome, "PUBLISHED", "Exercise a valid requested response, not a safe fallback");
    assert.equal(f.state().status, "PENDING"); const id = f.state().opportunityId;
    await f.advance(31_000); assert.equal(f.messages().length, 1, "Cooldown alone cannot publish after a requested reply");
    await f.send("City A has a newly shared strength.", f.players[0]);
    await f.send("City A also has a drawback.", f.players[0]);
    assert.equal(f.messages().length, 1, "One speaker alone does not meet the post-request discussion rule");
    await f.send("City B has another point to compare.", f.players[1]);
    assert.equal(f.messages().length, 2); assert.equal(f.messages()[1].facilitatorTrigger, "AUTOMATIC_CHECKPOINT");
    assert.equal(f.state().opportunityId, id); assert.equal(f.game.get("totalInterventions"), 1);
    assert.match(f.calls.filter(c => c.kind === "generator" && !c.requested).at(-1).body.messages[1].content, /City B has another point/);
  } finally { auto.release(); request.release(); await f.close(); }
});

test("concurrent timer retries cannot publish the same opportunity twice", async () => {
  const f = await fixture();
  try {
    f.game.set("lastAttemptTimestamp", Date.now()); await f.run(); const id = f.state().opportunityId;
    f.jump(30_000);
    await Promise.all([f.run({ staticRetry: { opportunityId: id } }), f.run({ staticRetry: { opportunityId: id } })]);
    await f.advance(0); assert.equal(f.messages().length, 1); assert.equal(f.state().attemptCount, 1);
    await f.run({ staticRetry: { opportunityId: id } }); assert.equal(f.messages().length, 1);
    assert.equal(f.events().filter(e => e.reasonCode === "PUBLISHED").length, 1);
  } finally { await f.close(); }
});

for (const phase of ["generator", "validator"]) test(`phase end during ${phase} cancels the opportunity and timer`, async () => {
  let changed = false;
  const f = await fixture({ hook: async (call, f) => {
    if (call.kind !== phase || changed) return;
    changed = true; f.stage.set("ended", true);
    for (const listener of f.h.Empirica.attributeListeners.filter(l => l.kind === "stage" && l.key === "ended"))
      await listener.callback(undefined, { stage: f.stage, ended: true });
  } });
  try {
    await f.run(); assert.equal(f.messages().length, 0); assert.equal(f.state().status, "CANCELLED");
    assert.equal(f.state().reasonCode, "PHASE_ENDED"); const calls = f.calls.length;
    await f.advance(60_000); assert.equal(f.calls.length, calls);
  } finally { await f.close(); }
});

test("pending work expires at the phase deadline without another chat event", async () => {
  const f = await fixture({ remaining: 15_000 });
  try {
    f.game.set("lastAttemptTimestamp", Date.now()); await f.run(); assert.equal(f.calls.length, 0);
    await f.advance(15_000); assert.equal(f.state().status, "CANCELLED"); assert.equal(f.calls.length, 0);
  } finally { await f.close(); }
});

test("semantic rejection preserves safety, waits for new context, and exhausts the bounded opportunity budget", async () => {
  const f = await fixture({ hook: call => call.kind === "validator" ? response(flags("roleMisaligned")) : undefined });
  try {
    await f.run(); assert.equal(f.calls.length, 4); assert.equal(f.messages().length, 0);
    assert.equal(f.state().status, "PENDING"); await f.advance(30_000); assert.equal(f.calls.length, 4);
    for (let i = 1; i < STATIC_MAX_ATTEMPTS; i++) {
      await f.send(`New context for reconsideration ${i}.`); await f.advance(30_000);
    }
    assert.equal(f.state().status, "CANCELLED"); assert.equal(f.state().reasonCode, "RETRY_EXHAUSTED");
    assert.equal(f.calls.length, 12); assert.equal(f.messages().length, 0);
    await f.advance(60_000); assert.equal(f.calls.length, 12);
  } finally { await f.close(); }
});

test("API errors retry without new messages at 30s intervals and stop after three attempts", async () => {
  const f = await fixture({ hook: () => response({ error: "temporary provider failure" }, 503) });
  try {
    await f.run(); assert.equal(f.calls.length, 1); await f.advance(30_000); assert.equal(f.calls.length, 2);
    await f.advance(30_000); assert.equal(f.calls.length, STATIC_MAX_ATTEMPTS);
    assert.equal(f.state().reasonCode, "RETRY_EXHAUSTED"); assert.equal(f.messages().length, 0);
    assert.ok(f.logs().filter(l => l.requestMade).every(l => l.reasonCode === "API_ERROR"));
    await f.advance(100_000); assert.equal(f.calls.length, STATIC_MAX_ATTEMPTS);
    assert.deepEqual(f.game.get("llmInFlight"), {});
  } finally { await f.close(); }
});

test("fixed opening, silence reminders and Timer messages retain their exclusion semantics", async () => {
  const f = await fixture({ hook: (call, f) => {
    if (call.kind !== "generator") return;
    const extra = ["DISCUSSION_OPENING", "SILENCE_NUDGE"].map((trigger, i) => ({ messageId: `fixed-${i}`, text: "Fixed reminder.",
      stage: "Discussion", messageType: "facilitator", speakerType: "facilitator", facilitatorOrigin: "DETERMINISTIC_FIXED",
      facilitatorTrigger: trigger, sender: { id: "ai", name: "Facilitator" } }));
    extra.push({ messageId: "timer", text: "One minute remains.", stage: "Discussion", messageType: "timer_reminder", speakerType: "timer_reminder", sender: { id: "timer", name: "Timer" } });
    f.game.set("chat_round_0", [...f.game.get("chat_round_0"), ...extra]);
  } });
  try { await f.run(); assert.equal(f.messages().length, 1); assert.equal(f.game.get("humanMessageCount"), 6); }
  finally { await f.close(); }
});

test("request arriving in the last publication flush prevents the old automatic append", async () => {
  const boundary = gate(); let waiting = false;
  const f = await fixture();
  f.h.Empirica.setFlusher({ async flush() {
    if (!waiting && Object.values(f.game.get("llmInFlight") || {}).some(e => e.visibleResponsePending && !e.participantRequested)) {
      waiting = true; await boundary.promise;
    }
  } });
  try {
    const automatic = f.run(); await until(() => waiting);
    f.add("@[Facilitator] Please explain the task."); const requested = f.run(); await settle();
    boundary.release(); await Promise.all([automatic, requested]);
    assert.equal(f.messages().length, 1); assert.equal(f.messages()[0].facilitatorTrigger, "PARTICIPANT_REQUEST");
  } finally { boundary.release(); await f.close(); }
});

test("an automatic publication committed before a request exists remains legitimate", async () => {
  const f = await fixture();
  try {
    await f.run(); const publishedId = f.messages()[0].messageId;
    await f.send("@[Facilitator] Can you clarify that?");
    assert.equal(f.messages().length, 2); assert.equal(f.messages()[0].messageId, publishedId);
    assert.equal(f.game.get("totalInterventions"), 1);
  } finally { await f.close(); }
});

test("a request entering during automatic validation still has priority", async () => {
  const autoValidator = gate(), requestedGenerator = gate(); let validating = false, requested = false;
  const f = await fixture({ hook: async call => {
    if (call.kind === "validator" && !call.requested) { validating = true; await autoValidator.promise; }
    if (call.kind === "generator" && call.requested) { requested = true; await requestedGenerator.promise; }
  } });
  try {
    const automatic = f.run(); await until(() => validating);
    f.add("@[Facilitator] Can you explain this task?"); const reply = f.run(); await until(() => requested);
    autoValidator.release(); await automatic; assert.equal(f.messages().length, 0);
    requestedGenerator.release(); await reply; assert.equal(f.messages().length, 1);
    assert.equal(f.messages()[0].facilitatorTrigger, "PARTICIPANT_REQUEST");
  } finally { autoValidator.release(); requestedGenerator.release(); await f.close(); }
});

test("a requested safe fallback also defers the displaced automatic opportunity", async () => {
  const automaticGate = gate(); let started = false;
  const f = await fixture({ hook: async call => {
    if (call.kind === "generator" && !call.requested && !started) { started = true; await automaticGate.promise; }
    if (call.requested) return response({ error: "provider unavailable" }, 503);
  } });
  try {
    const automatic = f.run(); await until(() => started);
    await f.send("@[Facilitator] Please help me understand the task."); automaticGate.release(); await automatic;
    assert.ok(f.logs().some(e => e.outcome === "PUBLISHED_REQUEST_FALLBACK"));
    assert.ok(f.state().requestBarrier); await f.advance(31_000);
    assert.equal(f.messages().length, 0); assert.equal(f.state().status, "PENDING");
  } finally { automaticGate.release(); await f.close(); }
});

test("the ready listener recovers interrupted work and retries without a participant message", async () => {
  let failed = false;
  const f = await fixture({ hook: () => { if (!failed) { failed = true; return response({}, 503); } } });
  try {
    await f.run(); const stored = { ...f.state() }; f.h.staticInterventionScheduler.cancel(f.game);
    f.round.set(STATIC_OPPORTUNITY_KEY, { ...stored, status: "GENERATING", ownerInstanceId: "dead-process",
      eventSequence: f.state().eventSequence });
    f.game.set("llmInFlight", { interrupted: { auditRequestId: "interrupted", serverInstanceId: "dead-process", outcome: "PENDING" } });
    for (const listener of f.h.Empirica.readys) await listener.callback({ scopesByKind: () => new Map([[f.game.id, f.game]]) });
    await f.h.facilitatorTasks.drain();
    assert.ok(f.logs().some(e => e.outcome === "INTERRUPTED_CALLBACKS_RESTART"));
    assert.equal(f.state().status, "PENDING"); await f.advance(30_000);
    assert.equal(f.messages().length, 1); assert.equal(f.state().opportunityId, stored.opportunityId);
    assert.equal(f.state().attemptCount, 2); assert.equal(f.game.get("humanMessageCount"), 6);
  } finally { await f.close(); }
});

test("background dispatch coalesces new humans and a silent Static retry preserves the message cursor", async () => {
  const held = gate(); let started = false;
  const f = await fixture({ hook: async call => {
    if (call.kind === "generator" && !started) { started = true; await held.promise; }
  } });
  try {
    f.h.dispatchChat(undefined, { game: f.game }); await until(() => started);
    for (let i = 0; i < 3; i++) f.add(`Batched public fact ${i}.`);
    f.h.dispatchChat(undefined, { game: f.game });
    await until(() => f.game.get("humanMessageCount") === 9);
    held.release(); await f.h.facilitatorTasks.drain();
    assert.equal(f.messages().length, 0); assert.equal(f.state().status, "PENDING");
    const cursor = { ...f.game.get("humanMessageCursor") };
    await f.advance(30_000);
    assert.equal(f.messages().length, 1); assert.equal(f.state().attemptCount, 2);
    assert.equal(f.game.get("humanMessageCount"), 9);
    assert.deepEqual(f.game.get("humanMessageCursor"), cursor);
    f.h.dispatchChat(undefined, { game: f.game }); await f.h.facilitatorTasks.drain();
    assert.equal(f.messages().length, 1); assert.equal(f.calls.length, 3);
  } finally { held.release(); await f.h.facilitatorTasks.drain(); await f.close(); }
});

test("a request followed by an ordinary message in one dispatched batch still supersedes Static", async () => {
  const automaticGate = gate(), requestedGate = gate(); let automaticStarted = false, requestedStarted = false;
  const f = await fixture({ hook: async call => {
    if (call.kind !== "generator") return;
    if (call.requested) { requestedStarted = true; await requestedGate.promise; }
    else if (!automaticStarted) { automaticStarted = true; await automaticGate.promise; }
  } });
  try {
    f.h.dispatchChat(undefined, { game: f.game }); await until(() => automaticStarted);
    f.add("@[Facilitator] What information can we compare?", f.players[0]);
    f.add("Here is another public fact.", f.players[1]);
    f.h.dispatchChat(undefined, { game: f.game }); await until(() => requestedStarted);
    automaticGate.release(); await settle(); assert.equal(f.messages().length, 0);
    requestedGate.release(); await f.h.facilitatorTasks.drain();
    assert.equal(f.messages().length, 1); assert.equal(f.messages()[0].facilitatorTrigger, "PARTICIPANT_REQUEST");
    assert.equal(f.game.get("humanMessageCount"), 8); assert.equal(f.state().status, "PENDING");
    await f.advance(31_000); assert.equal(f.messages().length, 1);
    assert.equal(f.calls.filter(c => c.kind === "validator").length, 1);
  } finally { automaticGate.release(); requestedGate.release(); await f.h.facilitatorTasks.drain(); await f.close(); }
});

test("phase changes at the final publication boundary cancel without committing a candidate", async () => {
  const f = await fixture(); let changed = false;
  f.h.Empirica.setFlusher({ async flush() {
    if (!changed && Object.values(f.game.get("llmInFlight") || {}).some(e => e.visibleResponsePending)) {
      changed = true; f.stage.set("ended", true);
    }
  } });
  try {
    await f.run(); assert.equal(f.messages().length, 0); assert.equal(f.state().status, "CANCELLED");
    assert.equal(f.logs().find(e => e.attemptId)?.reasonCode, "PHASE_ENDED");
    assert.deepEqual(f.game.get("llmInFlight"), {});
  } finally { await f.close(); }
});

test("durable opportunity recovery rearms cooldown, and a committed message reconciles to PUBLISHED", async () => {
  const f = await fixture(); let runs = 0;
  const recovered = createStaticInterventionScheduler({ instanceId: "replacement-callbacks", now: () => Date.now(),
    run: async () => { runs++; }, flush: () => {}, setTimer: (...args) => setTimeout(...args) });
  try {
    f.game.set("lastAttemptTimestamp", Date.now()); await f.run();
    f.h.staticInterventionScheduler.cancel(f.game);
    const stored = { ...f.state(), status: "GENERATING", ownerInstanceId: "old-callbacks", attemptCount: 1, notBefore: Date.now() + 30_000 };
    f.round.set(STATIC_OPPORTUNITY_KEY, stored); recovered.wake(f.game);
    assert.equal(f.state().status, "PENDING"); assert.equal(f.state().attemptCount, 1);
    await f.advance(29_999); assert.equal(runs, 0);
    f.game.set("chat_round_0", [...f.game.get("chat_round_0"), { messageId: `facilitator-${stored.opportunityId}`, opportunityId: stored.opportunityId }]);
    recovered.wake(f.game); assert.equal(f.state().status, "PUBLISHED");
    await f.advance(30_000); assert.equal(runs, 0);
  } finally { recovered.cancel(f.game); await f.close(); }
});

test("publication mutex releases after exceptions and does not hold other sessions", async () => {
  const coordinator = createFacilitatorPublicationCoordinator(), first = { id: "one" }, second = { id: "two" }, blocked = gate();
  const pending = coordinator.commit(first, async () => { await blocked.promise; throw new Error("append failure"); });
  assert.equal(await coordinator.commit(second, () => "other session"), "other session");
  const next = coordinator.commit(first, () => "next publication"); blocked.release();
  await assert.rejects(pending, /append failure/); assert.equal(await next, "next publication");
});

for (const boundary of ["initial-state", "before-append", "after-append"]) test(`a transient ${boundary} flush error releases state and cannot duplicate publication`, async () => {
  const f = await fixture(); let failed = false;
  f.h.Empirica.setFlusher({ async flush() {
    const active = Object.values(f.game.get("llmInFlight") || {});
    const hit = boundary === "initial-state" ? active.some(e => !e.visibleResponsePending) && !f.calls.length
      : boundary === "before-append" ? active.some(e => e.visibleResponsePending) && !f.messages().length
      : active.some(e => !e.visibleResponsePending) && f.messages().length > 0;
    if (hit && !failed) { failed = true; throw new Error("controlled storage interruption"); }
  } });
  try {
    await f.run(); assert.equal(failed, true); assert.deepEqual(f.game.get("llmInFlight"), {});
    if (boundary === "after-append") assert.equal(f.state().status, "PUBLISHED");
    else { assert.equal(f.state().status, "PENDING"); await f.advance(30_000); }
    assert.equal(f.messages().length, 1); assert.equal(f.game.get("publishedThisRound"), 1);
    assert.equal(f.game.get("totalInterventions"), 1);
    await f.advance(31_000); assert.equal(f.messages().length, 1);
  } finally { await f.close(); }
});

test("a requested reply committed before a crash restores its discussion barrier", async () => {
  let failed = false;
  const f = await fixture({ hook: () => { if (!failed) { failed = true; return response({}, 503); } } });
  try {
    await f.run(); const id = f.state().opportunityId;
    f.game.set("chat_round_0", [...f.game.get("chat_round_0"), { messageId: "recovered-request", stage: "Discussion",
      messageType: "facilitator", speakerType: "facilitator", facilitatorOrigin: "LLM_GENERATED",
      facilitatorTrigger: "PARTICIPANT_REQUEST", sender: { id: "ai", name: "Facilitator" }, text: "Earlier requested clarification." }]);
    f.h.staticInterventionScheduler.wake(f.game);
    assert.equal(f.state().requestBarrier.messageId, "recovered-request");
    await f.advance(30_000); assert.equal(f.calls.length, 1);
    await f.send("City A has a point to consider.", f.players[0]);
    await f.send("City B has another point.", f.players[1]);
    assert.equal(f.messages().length, 2); assert.equal(f.state().opportunityId, id);
  } finally { await f.close(); }
});

test("the attempt budget is flushed before starting model work", async () => {
  let persistedAttemptCount = 0;
  const f = await fixture({ hook: (_call, f) => { assert.equal(persistedAttemptCount, f.state().attemptCount); } });
  f.h.Empirica.setFlusher({ async flush() {
    if (f.state()?.status === "GENERATING") persistedAttemptCount = f.state().attemptCount;
  } });
  try { await f.run(); assert.equal(persistedAttemptCount, 1); assert.equal(f.messages().length, 1); }
  finally { await f.close(); }
});

test("recovery reconciles a real canonical message and partial publication accounting exactly once", async () => {
  const f = await fixture();
  try {
    await f.run(); const original = { ...f.state() }, message = f.messages()[0];
    assert.equal(message.messageId, `facilitator-${original.opportunityId}`);
    f.round.set(STATIC_OPPORTUNITY_KEY, { ...original, status: "GENERATING", ownerInstanceId: "dead-process" });
    f.game.set("publishedThisRound", 0); f.game.set("totalInterventions", 0); f.game.set("interventionHistory", []);
    f.game.set("messagesSinceLastPublish", 6);
    f.h.staticInterventionScheduler.wake(f.game);
    assert.equal(f.state().status, "PUBLISHED"); assert.equal(f.game.get("publishedThisRound"), 1);
    assert.equal(f.game.get("totalInterventions"), 1); assert.equal(f.game.get("messagesSinceLastPublish"), 0);
    f.h.staticInterventionScheduler.wake(f.game); await f.advance(30_000);
    assert.equal(f.calls.length, 2); assert.equal(f.messages().length, 1);
    assert.equal(f.game.get("interventionHistory").filter(item => item.messageId === message.messageId).length, 1);
  } finally { await f.close(); }
});

test("the unchanged ten-second start floor has its own cancellation reason", async () => {
  const f = await fixture({ remaining: 10_000 });
  try {
    await f.run(); assert.equal(f.calls.length, 0); assert.equal(f.state().status, "CANCELLED");
    assert.equal(f.state().reasonCode, "TIME_FLOOR");
  } finally { await f.close(); }
});
