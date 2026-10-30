import test from "node:test";
import assert from "node:assert/strict";
import { FakeGame, FakeRound, FakeStage, FakeScope, makeFakePlayer } from "../test/participant_sim/fakes/fakeStore.mjs";
import { getOfflineCallbacksHarness } from "../test/participant_sim/fakes/loadCallbacks.mjs";
import { readAppendOnlyAttribute } from "./AppendOnlyAttribute.mjs";
import { VALIDATOR_CRITERIA } from "./SemanticValidator.js";
import { createStaticInterventionScheduler, STATIC_OPPORTUNITY_KEY, STATIC_REQUEST_RESUMPTION_KEY, STATIC_MAX_ATTEMPTS } from "./StaticInterventionScheduler.mjs";
import { createFacilitatorPublicationCoordinator } from "./FacilitatorPublication.mjs";

// Tests run the real callback entry point with a controlled clock/provider.
// No model, live Tajriba, or participant session is contacted.
const flags = (...failures) => Object.fromEntries(VALIDATOR_CRITERIA.map(k => [k, failures.includes(k)]));
function retryFeedback(call) {
  const section = call.body.messages[1].content.split("[STATIC_OPPORTUNITY_FAILURE_RECORDS]\n")[1];
  return section ? JSON.parse(section.split("\n\n[STATIC_RETRY_CORRECTION_REQUIREMENTS]")[0]) : [];
}
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

for (const n of [0, 1, 2, 3, 12]) test(`Static publishes once with ${n} new participant messages during generation`, async () => {
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

for (const phase of ["generator", "validator"]) test(`3 new messages during ${phase} do not invalidate an otherwise valid candidate`, async () => {
  let changed = false;
  const f = await fixture({ hook: async (call, f) => {
    if (call.kind !== phase || changed) return;
    changed = true; for (let i = 0; i < 3; i++) await f.send(`Fresh retry context ${i}.`);
  } });
  try {
    await f.run();
    assert.equal(f.messages().length, 1); assert.equal(f.state().status, "PUBLISHED");
    assert.equal(f.logs().find(e => e.attemptId)?.reasonCode, "PUBLISHED");
    assert.equal(f.calls.length, 2); assert.equal(f.state().attemptCount, 1);
    assert.equal(f.game.get("humanMessageCount"), 9);
    assert.equal(f.game.get("messagesSinceLastPublish"), 0);
    await f.advance(30_000); assert.equal(f.calls.length, 2);
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

test("multiple checkpoints coalesce while the generation lock is held, without count-based invalidation", async () => {
  const blocked = gate(); let began = false;
  const f = await fixture({ hook: async call => { if (call.kind === "generator" && !began) { began = true; await blocked.promise; } } });
  try {
    const first = f.run(); await until(() => began); const id = f.state().opportunityId;
    f.jump(31_000); for (let i = 0; i < 3; i++) await f.send(`Queued public point ${i}.`);
    assert.equal(f.calls.length, 1); assert.equal(f.state().opportunityId, id);
    assert.equal(f.logs().filter(e => e.reasonCode === "LOCK_BUSY").length, 3);
    blocked.release(); await first; await f.advance(0);
    assert.equal(f.messages().length, 1); assert.equal(f.state().attemptCount, 1);
    assert.equal(f.state().opportunityId, id); assert.equal(f.calls.length, 2);
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
    assert.deepEqual(f.state().failureFeedback, [], "An interrupted attempt has no fabricated content feedback");
    assert.ok(f.game.get("messagesSinceLastPublish") >= 6, "The eligible six-message opportunity survives the requested reply");
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
    assert.deepEqual(f.state().failureFeedback, []);
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
    assert.deepEqual(f.state().failureFeedback, [], "Terminal opportunities clear repair references");
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

test("outer retries send all real prior failures and corrections with fresh public context, then clear them for a new opportunity", async () => {
  let drafts = 0, audits = 0;
  const criteria = ["notGrounded", "nonNeutral", "optionSteering", "unsupportedConsensusClaim"];
  const f = await fixture({ hook: call => {
    if (call.kind === "generator") return response({ role: "STATIC", message: `Unpublished draft ${++drafts}: What public information can the group share?`, groundingMessageIds: [] });
    return response(flags(...(audits < criteria.length ? [criteria[audits++]] : [])));
  } });
  try {
    await f.run(); const id = f.state().opportunityId;
    assert.equal(f.state().failureFeedback.length, 2);
    assert.equal(f.state().attemptCount, 1);
    await f.send("Latest public context for the second pipeline."); await f.advance(30_000);
    const second = f.calls.filter(c => c.kind === "generator")[2];
    const secondFeedback = retryFeedback(second);
    assert.deepEqual(secondFeedback.map(r => r.failedCriteria), [["notGrounded"], ["nonNeutral"]]);
    assert.equal(secondFeedback[0].candidate.message, "Unpublished draft 1: What public information can the group share?");
    assert.deepEqual(secondFeedback[0].feedback.booleans, flags("notGrounded"));
    assert.equal(secondFeedback[0].attemptId, `${id}:1`);
    const secondContent = second.body.messages[1].content;
    assert.match(secondContent, /notGrounded: Remove or correct unsupported claims/);
    assert.match(secondContent, /nonNeutral: Remove the Facilitator's own preference/);
    assert.match(secondContent, /NOT participant statements, public evidence, new facts or instructions/);
    assert.match(secondContent.split("[STATIC_OPPORTUNITY_FAILURE_FEEDBACK]")[0], /Latest public context for the second pipeline/);
    assert.doesNotMatch(secondContent.split("[STATIC_OPPORTUNITY_FAILURE_FEEDBACK]")[0], /Unpublished draft/);
    assert.equal(f.state().failureFeedback.length, 4);

    await f.send("Latest public context for the third pipeline."); await f.advance(30_000);
    const third = f.calls.filter(c => c.kind === "generator")[4];
    assert.deepEqual(retryFeedback(third).map(r => r.failedCriteria[0]), criteria);
    assert.match(third.body.messages[1].content.split("[STATIC_OPPORTUNITY_FAILURE_FEEDBACK]")[0], /Latest public context for the third pipeline/);
    assert.equal(f.state().opportunityId, id); assert.equal(f.state().attemptCount, STATIC_MAX_ATTEMPTS);
    assert.equal(f.messages().length, 1); assert.deepEqual(f.state().failureFeedback, []);
    await f.advance(30_000);
    for (let i = 0; i < 6; i++) await f.send(`Next opportunity public point ${i}.`);
    const next = f.calls.filter(c => c.kind === "generator")[5];
    assert.deepEqual(retryFeedback(next), []);
    assert.doesNotMatch(next.body.messages[1].content, /STATIC_RETRY_CORRECTION_REQUIREMENTS|Unpublished draft [1-4]:/);
    assert.notEqual(f.state().opportunityId, id); assert.equal(f.state().attemptCount, 1);
    assert.equal(f.messages().length, 2);
  } finally { await f.close(); }
});

for (const kind of ["parse", "schema", "grounding", "length"]) test(`outer retry carries actual ${kind} validation details without promoting rejected output to evidence`, async () => {
  const f = await fixture({ hook: (call, f) => {
    if (call.kind !== "generator" || f.state().attemptCount !== 1) return;
    if (kind === "parse") return new Response(JSON.stringify({ choices: [{ message: { content: "{invalid-json-draft" } }] }), { headers: { "content-type": "application/json" } });
    const candidate = { role: "STATIC", message: "Please share the public information.", groundingMessageIds: [] };
    if (kind === "schema") candidate.unexpected = "schema-draft-marker";
    if (kind === "grounding") candidate.groundingMessageIds = ["invented-draft-id"];
    if (kind === "length") candidate.message = Array(51).fill("word").join(" ");
    return response(candidate);
  } });
  try {
    await f.run(); assert.equal(f.messages().length, 0);
    const failures = structuredClone(f.state().failureFeedback);
    assert.ok(failures.length >= 1);
    const code = { parse: "GENERATOR_PARSE_FAILURE", schema: "GENERATION_SCHEMA_FAILURE", grounding: "UNKNOWN_GROUNDING_ID", length: "MESSAGE_EXCEEDS_WORD_LIMIT" }[kind];
    assert.ok(failures.every(r => r.failedCriteria.includes(code)));
    if (kind === "parse") assert.match(failures[0].feedback.error, /invalid JSON/);
    if (kind === "schema") assert.equal(failures[0].feedback.errors[0].keyword, "additionalProperties");
    await f.send("A new public point after the rejected draft."); await f.advance(30_000);
    const retried = f.calls.find(c => c.kind === "generator" && retryFeedback(c).length);
    assert.deepEqual(retryFeedback(retried), failures);
    assert.match(retried.body.messages[1].content, new RegExp(`${code}: `));
    assert.equal(f.messages().length, 1);
  } finally { await f.close(); }
});

for (const kind of ["generator-api", "validator-api", "validator-schema"]) test(`${kind} failures create no fabricated content feedback`, async () => {
  let failed = false;
  const f = await fixture({ hook: call => {
    if (failed || call.kind !== (kind === "generator-api" ? "generator" : "validator")) return;
    failed = true;
    return kind === "validator-schema" ? response({ passed: true }) : response({ error: "controlled transport failure" }, 503);
  } });
  try {
    await f.run(); assert.equal(f.state().status, "PENDING");
    assert.equal(f.state().lastAttemptReason, "API_ERROR");
    assert.deepEqual(f.state().failureFeedback, []);
    assert.equal(f.logs().find(e => e.attemptId).staticContentFailures, undefined);
    await f.advance(30_000);
    assert.equal(f.messages().length, 1);
    assert.ok(f.calls.filter(c => c.kind === "generator").every(c => retryFeedback(c).length === 0));
  } finally { await f.close(); }
});

test("a real content failure before a repair transport error is retained without fabricating a second judgment", async () => {
  let generated = 0, audited = false;
  const f = await fixture({ hook: call => {
    if (call.kind === "generator" && ++generated === 2) return response({}, 503);
    if (call.kind === "validator" && !audited) { audited = true; return response(flags("optionSteering")); }
  } });
  try {
    await f.run();
    assert.equal(f.state().lastAttemptReason, "API_ERROR");
    assert.equal(f.state().failureFeedback.length, 1);
    assert.deepEqual(f.state().failureFeedback[0].failedCriteria, ["optionSteering"]);
    await f.advance(30_000);
    assert.deepEqual(retryFeedback(f.calls.filter(c => c.kind === "generator")[2]).map(r => r.failedCriteria), [["optionSteering"]]);
    assert.equal(f.messages().length, 1);
  } finally { await f.close(); }
});

test("request interruption is not content rejection and the same six-message opportunity resumes after exactly two different speakers", async () => {
  const held = gate(); let generated = 0, requested = 0, audited = false, repairing = false;
  const f = await fixture({ hook: async call => {
    if (call.requested) return call.kind === "generator"
      ? response({ role: "GENERALIST", message: `Task clarification ${++requested}: compare the shared public information and agree on one choice.`, groundingMessageIds: [] }) : undefined;
    if (call.kind === "validator" && !audited) { audited = true; return response(flags("optionSteering")); }
    if (call.kind === "generator" && ++generated === 2) { repairing = true; await held.promise; }
  } });
  try {
    const automatic = f.run(); await until(() => repairing); const id = f.state().opportunityId;
    await f.send("@[Facilitator] Please explain the task.");
    held.release(); await automatic;
    assert.equal(f.state().status, "PENDING");
    assert.equal(f.state().lastAttemptReason, "REQUEST_SUPERSEDED");
    assert.deepEqual(f.state().failureFeedback, []);
    assert.equal(f.game.get("messagesSinceLastPublish"), 7, "Request/reply did not reset the already eligible message window");
    await f.advance(30_000); assert.equal(f.messages().length, 1);
    await f.send("Another question for @[Facilitator].", f.players[0]);
    await f.send("One ordinary public point.", f.players[0]);
    assert.equal(f.messages().length, 2, "A renewed request does not count as an ordinary resumption message");
    await f.send("A second person's ordinary public point.", f.players[1]);
    assert.equal(f.messages().length, 3); assert.equal(f.state().opportunityId, id);
    assert.equal(f.state().attemptCount, 2);
    assert.equal(f.game.get("totalInterventions"), 1);
    const retry = f.calls.filter(c => c.kind === "generator" && !c.requested)[2];
    assert.deepEqual(retryFeedback(retry), []);
  } finally { held.release(); await f.close(); }
});

test("retry feedback never makes a rejected draft ID eligible evidence for the new candidate", async () => {
  const f = await fixture({ hook: (call, f) => {
    if (call.kind === "validator") return response(flags("notGrounded"));
    if (f.state().attemptCount === 2) return response({ role: "STATIC", message: "A candidate citing an unpublished draft.", groundingMessageIds: ["unpublished-draft-id"] });
  } });
  try {
    await f.run(); assert.equal(f.state().failureFeedback.length, 2);
    await f.send("Fresh public context does not include that draft ID."); await f.advance(30_000);
    const retry = f.calls.filter(c => c.kind === "generator")[2];
    assert.equal(retryFeedback(retry).length, 2);
    assert.equal(f.messages().length, 0);
    assert.equal(f.calls.filter(c => c.kind === "validator").length, 2, "Invalid new grounding is stopped before a fresh semantic audit");
    assert.ok(f.logs().at(-1).deterministic.failedCriteria.includes("UNKNOWN_GROUNDING_ID"));
  } finally { await f.close(); }
});

test("third-attempt request interruption keeps the two-speaker recovery condition across exhausted opportunities", async () => {
  const held = gate(); let waiting = false, originalId;
  const f = await fixture({ hook: async (call, f) => {
    if (call.requested) return;
    originalId ??= f.state().opportunityId;
    if (f.state().opportunityId !== originalId) return;
    if (f.state().attemptCount < 3 && call.kind === "validator") return response(flags("optionSteering"));
    if (f.state().attemptCount === 3 && call.kind === "generator") { waiting = true; await held.promise; }
  } });
  try {
    await f.run(); const id = f.state().opportunityId;
    await f.send("Public point for attempt two."); await f.advance(30_000);
    await f.send("Public point for attempt three."); await f.advance(30_000);
    await until(() => waiting);
    await f.send("@[Facilitator] Please clarify the task."); held.release();
    await until(() => f.state().status === "CANCELLED");
    assert.equal(f.state().opportunityId, id);
    assert.equal(f.state().reasonCode, "RETRY_EXHAUSTED");
    assert.equal(f.game.get("messagesSinceLastPublish"), 9);
    assert.deepEqual(f.state().failureFeedback, []);
    assert.equal(f.messages().length, 1, "The old automatic candidate did not publish");
    const replyId = f.messages()[0].messageId;
    f.round.set(STATIC_REQUEST_RESUMPTION_KEY, null);
    f.h.staticInterventionScheduler.wake(f.game);
    assert.equal(f.round.get(STATIC_REQUEST_RESUMPTION_KEY).messageId, replyId, "Recovery restores the barrier even for a terminal opportunity");
    const automaticCalls = () => f.calls.filter(c => c.kind === "generator" && !c.requested);
    const attemptsBeforeResumption = automaticCalls().length;
    await f.send("Only A resumes discussion.", f.players[0]);
    await f.advance(30_000);
    assert.equal(automaticCalls().length, attemptsBeforeResumption, "A alone must not restart automatic generation after the old opportunity closes");
    for (let i = 0; i < 3; i++) await f.send(`More messages from A ${i}.`, f.players[0]);
    await f.advance(30_000);
    assert.equal(automaticCalls().length, attemptsBeforeResumption);
    assert.notEqual(f.state().opportunityId, id); assert.equal(f.state().attemptCount, 0);
    assert.deepEqual(f.state().failureFeedback, []);
    await f.send("B also resumes discussion.", f.players[1]);
    assert.notEqual(f.state().opportunityId, id); assert.equal(f.state().attemptCount, 1);
    assert.equal(f.game.get("totalInterventions"), 1);
    assert.deepEqual(retryFeedback(automaticCalls().at(-1)), []);
    const nextId = f.state().opportunityId;
    await f.run({ staticRetry: { opportunityId: id } });
    await f.run({ staticRetry: { opportunityId: nextId } });
    await f.advance(30_000);
    assert.equal(f.game.get("totalInterventions"), 1, "Neither the exhausted opportunity nor the new one can publish twice");
  } finally { held.release(); await f.close(); }
});

for (const attempt of [1, 2]) test(`request interruption of attempt ${attempt} preserves its opportunity, feedback and two-speaker recovery`, async () => {
  const held = gate(); let waiting = false;
  const f = await fixture({ hook: async (call, f) => {
    if (call.requested) return;
    if (f.state().attemptCount < attempt && call.kind === "validator") return response(flags("optionSteering"));
    if (f.state().attemptCount === attempt && call.kind === "generator") { waiting = true; await held.promise; }
  } });
  try {
    const initial = f.run();
    if (attempt === 2) { await initial; await f.send("Fresh context for the second attempt."); await f.advance(30_000); }
    await until(() => waiting); const id = f.state().opportunityId;
    const feedback = structuredClone(f.state().failureFeedback);
    await f.send("@[Facilitator] Can you clarify?", f.players[0]); held.release();
    await until(() => f.state().status === "PENDING");
    assert.equal(f.state().opportunityId, id); assert.deepEqual(f.state().failureFeedback, feedback);
    await f.advance(30_000);
    const automaticCalls = () => f.calls.filter(c => c.kind === "generator" && !c.requested);
    const before = automaticCalls().length;
    await f.send("A resumes after asking the question.", f.players[0]);
    await f.send("A adds another ordinary point.", f.players[0]);
    assert.equal(automaticCalls().length, before);
    await f.send("B resumes too.", f.players[1]);
    assert.equal(f.state().opportunityId, id); assert.equal(f.state().attemptCount, attempt + 1);
    assert.equal(f.game.get("totalInterventions"), 1);
    assert.deepEqual(retryFeedback(automaticCalls().at(-1)), feedback);
    assert.equal(f.round.get(STATIC_REQUEST_RESUMPTION_KEY).satisfied, true);
  } finally { held.release(); await f.close(); }
});

test("only ordinary messages from distinct participants after the reply satisfy recovery", async () => {
  const held = gate(); let requested = false;
  const f = await fixture({ hook: async call => {
    if (call.requested && call.kind === "generator") { requested = true; await held.promise; }
  } });
  try {
    f.add("@[Facilitator] Please clarify the task.", f.players[0]); const reply = f.run();
    await until(() => requested);
    await f.send("A spoke before the reply.", f.players[0]);
    await f.send("B also spoke before the reply.", f.players[1]);
    held.release(); await reply; await f.advance(30_000);
    const barrier = f.round.get(STATIC_REQUEST_RESUMPTION_KEY);
    assert.equal(barrier.publicBoundary, f.game.get("chat_round_0").length);
    assert.equal(barrier.satisfied, false);
    const calls = f.calls.length;
    const additions = [
      { sender: { id: "ai" }, messageType: "facilitator", speakerType: "facilitator" },
      { sender: { id: "system" }, messageType: "timer_reminder", speakerType: "timer_reminder" },
      { sender: { id: "system" }, messageType: "system", speakerType: "system" },
    ].map((m, i) => ({ ...m, messageId: `resumption-system-${i}`, text: "A non-participant message.", stage: "Discussion" }));
    f.game.set("chat_round_0", [...f.game.get("chat_round_0"), ...additions]);
    await f.send("Only A speaks after the reply.", f.players[0]); await f.advance(30_000);
    assert.equal(f.calls.length, calls, "Pre-reply speakers, AI and system messages do not satisfy the wait");
    await f.send("B now speaks after the reply.", f.players[1]);
    assert.equal(f.game.get("totalInterventions"), 1);
    assert.equal(f.round.get(STATIC_REQUEST_RESUMPTION_KEY).satisfied, true);
  } finally { held.release(); await f.close(); }
});

test("a newer request resets recovery at its own reply and an older reply callback cannot release it", async () => {
  const held = gate(); let replies = 0, waiting = false;
  const f = await fixture({ hook: async call => {
    if (!call.requested || call.kind !== "generator") return;
    if (++replies === 2) { waiting = true; await held.promise; }
    return response({ role: "GENERALIST", message: `Clarification ${replies}: compare your publicly shared information.`, groundingMessageIds: [] });
  } });
  try {
    await f.send("@[Facilitator] First question.", f.players[0]);
    const oldReply = f.round.get(STATIC_REQUEST_RESUMPTION_KEY).messageId;
    await f.send("A's first ordinary contribution.", f.players[0]);
    f.add("@[Facilitator] Another question.", f.players[0]); const second = f.run();
    await until(() => waiting);
    await f.send("B speaks before the second reply.", f.players[1]);
    held.release(); await second;
    const currentReply = f.round.get(STATIC_REQUEST_RESUMPTION_KEY).messageId;
    assert.notEqual(currentReply, oldReply);
    f.h.staticInterventionScheduler.requestedPublished(f.game, oldReply);
    assert.equal(f.round.get(STATIC_REQUEST_RESUMPTION_KEY).messageId, currentReply);
    await f.advance(30_000);
    assert.equal(f.calls.filter(c => c.kind === "generator" && !c.requested).length, 0);
    await f.send("A speaks after the second reply.", f.players[0]);
    assert.equal(f.calls.filter(c => c.kind === "generator" && !c.requested).length, 0);
    await f.send("B speaks after the second reply.", f.players[1]);
    assert.equal(f.game.get("totalInterventions"), 1);
  } finally { held.release(); await f.close(); }
});

for (const gateName of ["cooldown", "message-count", "time-floor"]) test(`two-speaker resumption still respects the existing ${gateName} gate`, async () => {
  const f = await fixture();
  try {
    if (gateName === "message-count") {
      f.game.set("chat_round_0", []); f.game.set("humanMessageCount", 0); f.game.set("messagesSinceLastPublish", 0);
    }
    await f.send("@[Facilitator] Please clarify.", f.players[0]);
    if (gateName === "cooldown") f.game.set("lastAttemptTimestamp", Date.now());
    if (gateName === "time-floor") f.game.set("deadline", Date.now() + 10_000);
    await f.send("A contributes.", f.players[0]); await f.send("B contributes.", f.players[1]);
    assert.equal(f.round.get(STATIC_REQUEST_RESUMPTION_KEY).satisfied, true);
    const auto = () => f.calls.filter(c => c.kind === "generator" && !c.requested);
    assert.equal(auto().length, 0);
    if (gateName === "cooldown") {
      await f.advance(29_999); assert.equal(auto().length, 0);
      await f.advance(1); assert.equal(auto().length, 1);
    } else if (gateName === "message-count") {
      assert.equal(f.game.get("messagesSinceLastPublish"), 3);
      for (let i = 0; i < 3; i++) await f.send(`Another public point ${i}.`, f.players[0]);
      assert.equal(auto().length, 1);
    } else assert.equal(f.state().reasonCode, "TIME_FLOOR");
  } finally { await f.close(); }
});

for (const change of ["stage-end", "round-switch"]) test(`request resumption is group/round scoped and clears on ${change}`, async () => {
  const f = await fixture();
  try {
    await f.send("@[Facilitator] Please explain.", f.players[0]);
    assert.equal(f.round.get(STATIC_REQUEST_RESUMPTION_KEY).satisfied, false);
    const other = new FakeGame({}, f.players);
    const otherRound = new FakeRound({ taskIndex: 0, facilitation: "static" }, other);
    const otherStage = new FakeStage({ name: "Task" }, otherRound); otherStage.currentGame = other;
    other.currentRound = otherRound; other.currentStage = otherStage;
    other.set("deadline", Date.now() + 400_000); other.set("humanMessageCount", 6); other.set("messagesSinceLastPublish", 6);
    const state = f.h.staticInterventionScheduler.observe(other);
    assert.equal(f.h.staticInterventionScheduler.ready(other, state.opportunityId), true);
    assert.equal(otherRound.get(STATIC_REQUEST_RESUMPTION_KEY), undefined);
    f.h.staticInterventionScheduler.cancel(other);

    if (change === "stage-end") {
      f.stage.set("ended", true);
      for (const listener of f.h.Empirica.attributeListeners.filter(l => l.kind === "stage" && l.key === "ended"))
        await listener.callback(undefined, { stage: f.stage, ended: true });
      assert.equal(f.round.get(STATIC_REQUEST_RESUMPTION_KEY), null);
      const before = f.calls.length; await f.advance(30_000); assert.equal(f.calls.length, before);
    } else {
      const nextRound = new FakeRound({ taskIndex: 1, facilitation: "static", generalInfo: "Compare the public information." }, f.game);
      const nextStage = new FakeStage({ name: "Task" }, nextRound); nextStage.currentGame = f.game;
      f.game.currentRound = nextRound; f.game.currentStage = nextStage;
      f.h.staticInterventionScheduler.wake(f.game);
      assert.equal(f.round.get(STATIC_REQUEST_RESUMPTION_KEY), null);
      assert.equal(nextRound.get(STATIC_REQUEST_RESUMPTION_KEY), undefined);
      f.game.set("chat_round_1", Array.from({ length: 6 }, (_, i) => ({ messageId: `next-round-human-${i}`, stage: "Discussion",
        messageType: "human", speakerType: "human", text: `Next round fact ${i}.`, sender: { id: f.players[i % 3].id, name: f.players[i % 3].get("name") } })));
      f.game.set("humanMessageCount", 5); f.game.set("messagesSinceLastPublish", 5);
      f.game.set("humanMessageCursor", null); f.game.set("lastProcessedHumanMessageId", null);
      await f.run();
      assert.equal(f.game.get("chat_round_1").filter(m => m.facilitatorOrigin === "LLM_GENERATED").length, 1);
    }
  } finally { await f.close(); }
});

test("failure references survive owner recovery, but cannot cross a game or round and clear on phase cancellation", async () => {
  const f = await fixture({ hook: call => call.kind === "validator" ? response(flags("optionSteering")) : undefined });
  try {
    await f.run(); const original = structuredClone(f.state());
    assert.equal(original.failureFeedback.length, 2);
    f.round.set(STATIC_OPPORTUNITY_KEY, { ...original, ownerInstanceId: "restarted-process" });
    f.h.staticInterventionScheduler.wake(f.game);
    assert.deepEqual(f.state().failureFeedback, original.failureFeedback);
    await f.send("Fresh discussion after recovery."); await f.advance(30_000);
    assert.deepEqual(retryFeedback(f.calls.filter(c => c.kind === "generator")[2]), original.failureFeedback);

    const other = new FakeGame({}, f.players);
    const otherRound = new FakeRound({ taskIndex: 0, facilitation: "static" }, other);
    const otherStage = new FakeStage({ name: "Task" }, otherRound); otherStage.currentGame = other;
    other.currentRound = otherRound; other.currentStage = otherStage;
    other.set("deadline", Date.now() + 400_000); other.set("humanMessageCount", 6); other.set("messagesSinceLastPublish", 6);
    f.h.staticInterventionScheduler.observe(other);
    assert.deepEqual(f.h.staticInterventionScheduler.failureFeedback(other, otherRound.get(STATIC_OPPORTUNITY_KEY)), []);
    f.h.staticInterventionScheduler.cancel(other);

    const nextRound = new FakeRound({ taskIndex: 1, facilitation: "static" }, f.game);
    const nextStage = new FakeStage({ name: "Task" }, nextRound); nextStage.currentGame = f.game;
    f.game.currentRound = nextRound; f.game.currentStage = nextStage;
    f.h.staticInterventionScheduler.observe(f.game);
    assert.deepEqual(f.round.get(STATIC_OPPORTUNITY_KEY).failureFeedback, []);
    const next = nextRound.get(STATIC_OPPORTUNITY_KEY);
    assert.notEqual(next.opportunityId, original.opportunityId);
    assert.deepEqual(f.h.staticInterventionScheduler.failureFeedback(f.game, next), []);
  } finally { await f.close(); }
});

test("an exhausted opportunity clears feedback before a new eligible opportunity", async () => {
  const f = await fixture({ hook: call => call.kind === "validator" ? response(flags("optionSteering")) : undefined });
  try {
    await f.run(); const id = f.state().opportunityId;
    for (let i = 1; i < STATIC_MAX_ATTEMPTS; i++) { await f.send(`New context ${i}.`); await f.advance(30_000); }
    assert.equal(f.state().status, "CANCELLED"); assert.deepEqual(f.state().failureFeedback, []);
    const previousCalls = f.calls.length;
    await f.send("A new message after retry exhaustion."); await f.advance(30_000);
    assert.notEqual(f.state().opportunityId, id);
    assert.deepEqual(retryFeedback(f.calls.slice(previousCalls).find(c => c.kind === "generator")), []);
  } finally { await f.close(); }
});

test("generation reads public context appended during the pre-request persistence flush", async () => {
  const f = await fixture(); let added = false;
  f.h.Empirica.setFlusher({ async flush() {
    if (added || f.state()?.status !== "GENERATING") return;
    added = true; f.add("Latest public context added before the model request.");
  } });
  try {
    await f.run();
    assert.match(f.calls.find(c => c.kind === "generator").body.messages[1].content, /Latest public context added before the model request/);
    assert.equal(f.messages().length, 1);
  } finally { await f.close(); }
});

test("ordinary appends during the final publication flush do not invalidate a ready candidate", async () => {
  const f = await fixture(); let added = false;
  f.h.Empirica.setFlusher({ async flush() {
    if (added || !Object.values(f.game.get("llmInFlight") || {}).some(e => e.visibleResponsePending)) return;
    added = true;
    for (let i = 0; i < 12; i++) f.add(`Public point at final publication ${i}.`);
    f.h.dispatchChat(undefined, { game: f.game });
    // Do not await a nested lifecycle flush while holding the outer flush.
    await until(() => f.game.get("humanMessageCount") === 18);
  } });
  try {
    await f.run(); await f.h.facilitatorTasks.drain();
    assert.equal(f.messages().length, 1); assert.equal(f.state().attemptCount, 1);
    assert.equal(f.game.get("humanMessageCount"), 18);
    assert.equal(f.game.get("messagesSinceLastPublish"), 0);
    assert.equal(f.events().filter(e => e.reasonCode === "PUBLISHED").length, 1);
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
    assert.ok(f.round.get(STATIC_REQUEST_RESUMPTION_KEY)); await f.advance(31_000);
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

test("background dispatch coalesces new humans and publication preserves the message cursor", async () => {
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
    assert.equal(f.messages().length, 1); assert.equal(f.state().status, "PUBLISHED");
    const cursor = { ...f.game.get("humanMessageCursor") };
    await f.advance(30_000);
    assert.equal(f.messages().length, 1); assert.equal(f.state().attemptCount, 1);
    assert.equal(f.game.get("humanMessageCount"), 9);
    assert.deepEqual(f.game.get("humanMessageCursor"), cursor);
    f.h.dispatchChat(undefined, { game: f.game }); await f.h.facilitatorTasks.drain();
    assert.equal(f.messages().length, 1); assert.equal(f.calls.length, 2);
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
    assert.equal(f.round.get(STATIC_REQUEST_RESUMPTION_KEY).messageId, "recovered-request");
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
