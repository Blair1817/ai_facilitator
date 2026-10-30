import test from "node:test";
import assert from "node:assert/strict";
import { verifyEarlyCloseout, verifySemanticTarget, selectAdaptiveAssessment } from "./AdaptiveEvidence.mjs";
import { createCloseoutScheduler } from "./AdaptiveCloseoutScheduler.mjs";
import { FakeGame, FakeRound, FakeStage } from "../test/participant_sim/fakes/fakeStore.mjs";

const roster = ["A", "B", "C"], optionLabels = ["Norvale", "Fenwick"];
const msg = (name, text, i) => ({ messageId: `m${i}`, text, sender: { id: name, name }, speakerType: "human", messageType: "human" });
const chat = [msg("A", "Choose Norvale, ready to submit", 0), msg("B", "Agreed, we can submit", 1)];
const quote = m => ({ messageId: m.messageId, span: m.text });
function observation(messages = chat) {
  return { proposal: { active: true, optionLabel: "Norvale", evidence: [quote(messages[0])] },
    participants: roster.map(name => {
      const m = messages.filter(m => m.sender.name === name).at(-1);
      return { participantName: name, reviewedThroughMessageId: m?.messageId ?? null,
        stance: m ? "ready" : "uncommitted", optionLabel: m ? "Norvale" : null, evidence: m ? [quote(m)] : [] };
    }) };
}
const verify = (raw, messages = chat) => verifyEarlyCloseout(raw, { chat: messages, roster, optionLabels });
test("two different ready people with contextual agreement and a silent third qualify, without unanimity", () => {
  const result = verify(observation());
  assert.equal(result.active, true);
  assert.deepEqual(result.supporters, ["A", "B"]);
  assert.equal(result.reason, "two_public_ready_positions_not_unanimity");
});
for (const stance of ["preference", "withdrawn", "uncommitted", "object", "continue"]) {
  test(`current ${stance} replaces prior agreement, never accumulates votes`, () => {
    const raw = observation(); raw.participants[1].stance = stance;
    assert.equal(verify(raw).active, false);
  });
}
test("one person repeated, different options, stale review, invented quote and AI assent do not qualify", () => {
  const samePerson = [chat[0], msg("A", "Yes, submit Norvale", 1)];
  assert.equal(verify(observation(samePerson), samePerson).active, false);
  const different = observation(); different.participants[1].optionLabel = "Fenwick";
  assert.equal(verify(different).active, false);
  const expired = observation(); expired.proposal.active = false;
  assert.equal(verify(expired).active, false);
  const ungrounded = observation(); ungrounded.participants[1].evidence[0].span = "I agree with Norvale";
  assert.equal(verify(ungrounded).active, false);
  const newer = [...chat, msg("B", "Actually I want Fenwick", 2)];
  assert.equal(verify(observation(), newer).reason, "stale_participant_review");
  const ai = [chat[0], { ...chat[1], sender: { id: "ai", name: "B" }, speakerType: "facilitator" }];
  assert.equal(verify(observation(), ai).active, false);
});
// 2026-10-26: there is no integration priority; the objection still removes
// early-closeout readiness and the stage label is descriptive only.
test("third person's objection blocks early-closeout readiness; stages are descriptive with no priority", () => {
  const messages = [...chat, msg("C", "Wait, I want to keep discussing", 2)];
  const closeout = observation(messages); closeout.participants[2].stance = "continue";
  const raw = { candidates: { elicit: null, scrutinize: null, integrate: null }, rationale: "No open integration", closeout, integrationStatus: "already_covered" };
  const select = remainingTimeMs => selectAdaptiveAssessment(raw, { chat: messages, roster, optionLabels, remainingTimeMs });
  assert.equal(select(500_000).early.active, false);
  assert.equal(select(500_000).scheduling.stage, "ordinary");
  assert.equal(Object.hasOwn(select(500_000).scheduling, "integrationPriority"), false);
  assert.equal(select(120_000).scheduling.stage, "closeout_assessment");
  assert.equal(select(120_000).role, null);
});

test("semantic Fenwick issue stays excluded with new IDs; another issue on Fenwick is allowed", () => {
  const references = [{ id: "prior", semanticKey: "Fenwick poster accessibility", target: { messageIds: ["old"] }, publicMessageBoundary: 1, evidence: [{ span: "Posters in corridors" }] }];
  const messages = [msg("A", "Posters in corridors", 0), msg("B", "Posters in corridors", 1)];
  const review = (key, relation, newEvidence = []) => ({ key, matches: [{ id: "prior", relation, newEvidence, responseEvidence: [] }] });
  const check = r => verifySemanticTarget(r, { chat: messages, references });
  assert.equal(check(review("Fenwick poster accessibility", "unchanged")).ok, false);
  assert.equal(check(review("reworded poster concern", "unchanged")).ok, false);
  assert.equal(check(review("Fenwick shuttle assumption", "different")).ok, true);
  assert.equal(check(review("Fenwick poster accessibility", "material_change")).reason, "no_material_new_evidence");
  assert.equal(check(review("Fenwick poster accessibility", "material_change", [quote(messages[1])])).ok, false, "same fact under a new ID is not new evidence");
  messages.push(msg("B", "The posters have now moved to an exhibition room", 2));
  const reopened = check(review("Fenwick poster accessibility", "material_change", [quote(messages[2])]));
  assert.equal(reopened.ok, true);
});

function clockWorld(remaining = 900_000) {
  let time = 1_000_000, serial = 0;
  const timers = new Map(), game = new FakeGame({}, []);
  const round = new FakeRound({ facilitation: "adaptive" }, game), stage = new FakeStage({ name: "Task" }, round);
  game.currentRound = round; game.currentStage = stage; game.set("deadline", time + remaining);
  return { game, round, stage, now: () => time,
    elapse(ms) { time += ms; },
    setTimer(fn, delay) { const id = ++serial; timers.set(id, { fn, at: time + delay }); return id; },
    clearTimer(id) { timers.delete(id); },
    async advance(ms) {
      const until = time + ms;
      for (;;) {
        const due = [...timers].sort((a,b) => a[1].at - b[1].at)[0];
        if (!due || due[1].at > until) break;
        time = due[1].at; timers.delete(due[0]); await due[1].fn();
      }
      time = Math.max(time, until);
    },
  };
}
test("deadline-relative independent 180/120 events need no messages and repeated registration is idempotent", async () => {
  const c = clockWorld(), calls = [];
  const scheduler = createCloseoutScheduler({ ...c, run: async (_g, t) => { calls.push({ ...t, time: c.now() }); } });
  scheduler.register(c.game); scheduler.register(c.game);
  await c.advance(719_999); assert.equal(calls.length, 0);
  await c.advance(1); assert.equal(calls[0].triggerSource, "time_180");
  await c.advance(60_000); assert.equal(calls[1].triggerSource, "time_120");
  await c.advance(100_000); assert.equal(calls.length, 2);
  assert.equal(c.round.get("adaptiveCloseoutSchedule").cancelled.reason, "adaptive_20s_floor");
});
test("an in-flight 180-second check crossing 120 seconds still schedules the separate priority event", async () => {
  const c = clockWorld(180_000), calls = [];
  const scheduler = createCloseoutScheduler({ ...c, run: async (_g, t) => {
    calls.push(t.triggerSource);
    if (calls.length === 1) c.elapse(65_000);
  } });
  scheduler.register(c.game); await c.advance(0);
  await c.advance(1000);
  assert.deepEqual(calls, ["time_180", "time_120"]);
});
test("late registration coalesces two events; recovery does not repeat completed thresholds", async () => {
  const c = clockWorld(100_000), calls = [];
  const config = { ...c, run: async (_g, t) => calls.push(t) };
  const scheduler = createCloseoutScheduler(config);
  scheduler.register(c.game); await c.advance(0);
  assert.deepEqual(calls[0].triggerSources, ["time_180", "time_120"]);
  scheduler.cancel(c.game, "restart");
  createCloseoutScheduler(config).register(c.game); await c.advance(0);
  assert.equal(calls.length, 1);
});
test("cooldown and in-flight refusal defer without losing a timed opportunity", async () => {
  const c = clockWorld(181_000), calls = [];
  c.game.set("lastAttemptTimestamp", c.now());
  let locked = true;
  const scheduler = createCloseoutScheduler({ ...c, run: async (_g, t) => { calls.push(t); return { deferred: locked }; } });
  scheduler.register(c.game); await c.advance(14_999); assert.equal(calls.length, 0);
  await c.advance(1); assert.equal(calls.length, 1);
  assert.equal(c.round.get("adaptiveCloseoutSchedule").completed[180], undefined);
  locked = false; await c.advance(1000);
  assert.equal(calls.length, 2); assert.ok(c.round.get("adaptiveCloseoutSchedule").completed[180]);
});
test("expired/ended/cross-round/Static registration cannot catch up or publish", async () => {
  for (const mode of ["floor", "ended", "round", "static"]) {
    const c = clockWorld(mode === "floor" ? 20_000 : 180_000); let calls = 0;
    if (mode === "static") c.round.set("facilitation", "static");
    const scheduler = createCloseoutScheduler({ ...c, run: async () => calls++ });
    scheduler.register(c.game);
    if (mode === "ended") c.stage.set("ended", true);
    if (mode === "round") c.game.currentRound = new FakeRound({}, c.game);
    await c.advance(1000); assert.equal(calls, 0, mode);
  }
});
