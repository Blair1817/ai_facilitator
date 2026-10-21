// 2026-10-21 categorical need detector redesign.
//
// Unit coverage for the deterministic parts (participation rule, evidence
// check, gate, plan/preflight compatibility) plus offline end-to-end runs of
// the real callbacks.js (bundled with the fake Empirica core, fetch mocked):
// no real external LLM request is made anywhere in this file.
import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { FakeGame, FakeRound, FakeStage, FakeScope, makeFakePlayer } from "../test/participant_sim/fakes/fakeStore.mjs";
import { getOfflineCallbacksHarness } from "../test/participant_sim/fakes/loadCallbacks.mjs";
import { buildCanonicalMessage } from "./ExperimentPolicies.mjs";
import { readAppendOnlyAttribute } from "./AppendOnlyAttribute.mjs";
import { VALIDATOR_CRITERIA } from "./SemanticValidator.js";
import { NEED_CATEGORIES, COGNITIVE_NEEDS, countPublicMessagesByName, quietParticipants } from "./CognitiveOperations.mjs";
import { checkNeedAssessment } from "./EvidenceChecker.js";
import { evaluateNeedGate, chooseRole } from "./utils.js";
import { compilePlan } from "./PolicyCompiler.js";
import { preflightPlan } from "./PlanPreflight.mjs";

const dirname = path.dirname(fileURLToPath(import.meta.url));
process.argv[1] = path.join(dirname, "fake-entry.js");
const { validateAgainstAssessorSchema } = await import("./SemanticAssessor.js");

const ROSTER = ["Alex", "Casey", "Jordan"];
const msg = (name, text) => ({ text, sender: { id: `id-${name}`, name } });
const quote = (chat, i) => ({ messageId: `m${i}`, span: chat[i].text });
const need = (needName, operation, target) => ({ need: needName, operation, target, rationale: "audit" });
const target = (chat, indices, extra = {}) => ({
  label: "target", messageIds: indices.map((i) => `m${i}`), evidence: indices.map((i) => quote(chat, i)),
  optionLabels: [], criteria: [], ...extra,
});

// Alex and Casey talk; Jordan has posted once (quiet relative to the others).
const CHAT = [
  msg("Alex", "I prefer City B."),
  msg("Casey", "City B sounds good to me too."),
  msg("Alex", "City A transport is 12 minutes."),
  msg("Casey", "City B transport is 18 minutes."),
  msg("Alex", "City A cost is 25000."),
  msg("Casey", "City B cost is 32000."),
  msg("Jordan", "ok"),
];

// ── participation rule ──────────────────────────────────────────────────────

test("participation counts use roster names only and ignore Facilitator/system messages", () => {
  const chat = [...CHAT, { text: "AI says hi", sender: { id: "ai", name: "Facilitator" } }, msg("Stranger", "hi")];
  assert.deepEqual(countPublicMessagesByName(chat, ROSTER), { Alex: 3, Casey: 3, Jordan: 1 });
});

test("quiet rule: silent or < half the others' mean once others average >= 2; nobody is quiet early", () => {
  assert.deepEqual(quietParticipants({ Alex: 3, Casey: 3, Jordan: 1 }), ["Jordan"]);
  assert.deepEqual(quietParticipants({ Alex: 1, Casey: 0, Jordan: 0 }), ["Casey", "Jordan"], "fully silent participants stay eligible (previous behaviour)");
  assert.deepEqual(quietParticipants({ Alex: 1, Casey: 1, Jordan: 1 }), []);
  assert.deepEqual(quietParticipants({ Alex: 4, Casey: 4, Jordan: 2 }), [], "exactly half the others' mean is not quiet");
  assert.deepEqual(quietParticipants({ Alex: 0, Casey: 0, Jordan: 0 }), []);
});

// ── evidence check (N1-N4) ──────────────────────────────────────────────────

const check = (raw, chat = CHAT) => checkNeedAssessment(raw, { chat, activeParticipantNames: ROSTER });

test("N1: NONE passes through without a downgrade; unknown need or mismatched operation downgrade to NONE", () => {
  const none = check({ need: "NONE", operation: null, target: null, rationale: "" });
  assert.equal(none.need, "NONE");
  assert.equal(none.downgradedReason, null);
  assert.equal(check({ need: "CHALLENGE", operation: "unsupported_claim", target: target(CHAT, [0, 1]) }).downgradedReason, "INVALID_NEED");
  assert.equal(check(need("ELICIT", "unsupported_claim", target(CHAT, [0, 1]))).downgradedReason, "OPERATION_NEED_MISMATCH");
  assert.equal(check(null).downgradedReason, "INVALID_NEED");
});

test("N2: quotations must be exact substrings of their own cited public message", () => {
  const paraphrase = need("SCRUTINIZE", "unsupported_claim", { ...target(CHAT, [0, 1]), evidence: [{ messageId: "m0", span: "I like City B" }, quote(CHAT, 1)] });
  assert.equal(check(paraphrase).downgradedReason, "INVALID_EVIDENCE");
  const missingQuote = need("SCRUTINIZE", "unsupported_claim", { ...target(CHAT, [0, 1]), evidence: [quote(CHAT, 0)] });
  assert.equal(check(missingQuote).downgradedReason, "INVALID_EVIDENCE");
  const crossQuote = need("SCRUTINIZE", "unsupported_claim", { ...target(CHAT, [0, 1]), evidence: [{ messageId: "m0", span: CHAT[1].text }, quote(CHAT, 1)] });
  assert.equal(check(crossQuote).downgradedReason, "INVALID_EVIDENCE", "a quote must come from its own message");
  const aiChat = [...CHAT, { text: "Facilitator text", sender: { id: "ai", name: "Facilitator" }, messageType: "facilitator" }];
  const aiCited = need("SCRUTINIZE", "unsupported_claim", target(aiChat, [0, 7]));
  assert.equal(check(aiCited, aiChat).downgradedReason, "INVALID_EVIDENCE", "Facilitator messages are not participant evidence");
  assert.equal(check(need("SCRUTINIZE", "unsupported_claim", null)).downgradedReason, "MISSING_TARGET");
});

test("N3: SCRUTINIZE and INTEGRATE need two distinct participants; fragmented evidence needs three messages", () => {
  assert.equal(check(need("SCRUTINIZE", "unsupported_claim", target(CHAT, [0, 2]))).downgradedReason, "INSUFFICIENT_DISTINCT_PARTICIPANTS");
  assert.equal(check(need("SCRUTINIZE", "unsupported_claim", target(CHAT, [0, 1]))).role, "challenger");
  assert.equal(check(need("INTEGRATE", "cross_option_evidence", target(CHAT, [2, 4]))).downgradedReason, "INSUFFICIENT_DISTINCT_PARTICIPANTS");
  assert.equal(check(need("INTEGRATE", "fragmented_evidence", target(CHAT, [2, 3]))).downgradedReason, "INSUFFICIENT_DISTRIBUTED_EVIDENCE");
  assert.equal(check(need("INTEGRATE", "fragmented_evidence", target(CHAT, [2, 3, 4]))).role, "synthesiser");
  assert.equal(check(need("ELICIT", "coverage_gap", target(CHAT, [2]))).role, "expander", "ELICIT may cite a single participant");
});

test("N4: participation_gap must name a roster participant verified quiet by code", () => {
  const invite = (name) => need("ELICIT", "participation_gap", target(CHAT, [5], { participantName: name }));
  const ok = check(invite("Jordan"));
  assert.equal(ok.role, "expander");
  assert.equal(ok.target.participantName, "Jordan");
  assert.equal(check(invite("Alex")).downgradedReason, "PARTICIPANT_NOT_VERIFIED_QUIET");
  assert.equal(check(invite("Stranger")).downgradedReason, "PARTICIPANT_NOT_VERIFIED_QUIET");
  assert.equal(check(need("ELICIT", "participation_gap", target(CHAT, [5]))).downgradedReason, "PARTICIPANT_NOT_VERIFIED_QUIET");
});

test("every non-NONE need maps only to its own role's operations", () => {
  for (const [needName, role] of Object.entries(NEED_CATEGORIES)) {
    if (!role) continue;
    for (const [operation, [opRole]] of Object.entries(COGNITIVE_NEEDS)) {
      const raw = need(needName, operation, target(CHAT, [0, 1, 3], operation === "participation_gap" ? { participantName: "Jordan" } : {}));
      const result = check(raw);
      if (opRole === role) assert.equal(result.role, role, `${needName}/${operation}`);
      else assert.equal(result.downgradedReason, "OPERATION_NEED_MISMATCH", `${needName}/${operation}`);
    }
  }
});

// ── gate ────────────────────────────────────────────────────────────────────

test("gate: time floor abstains; NONE, rejected evidence and detector failure use the Static policy; verified need is a Specialist", () => {
  const verified = check(need("SCRUTINIZE", "unsupported_claim", target(CHAT, [0, 1])));
  assert.equal(evaluateNeedGate(verified, { remainingTime: 9_000 }).decision, "abstain");
  assert.equal(evaluateNeedGate(null, { remainingTime: 60_000 }).fallbackKind, "detector_unavailable");
  assert.equal(evaluateNeedGate(check({ need: "NONE", operation: null, target: null, rationale: "" }), { remainingTime: 60_000 }).fallbackKind, "no_need");
  const rejected = evaluateNeedGate(check(need("SCRUTINIZE", "unsupported_claim", target(CHAT, [0, 2]))), { remainingTime: 60_000 });
  assert.equal(rejected.decision, "static_policy");
  assert.equal(rejected.fallbackKind, "evidence_check_failed");
  const gate = evaluateNeedGate(verified, { remainingTime: 60_000 });
  assert.equal(gate.decision, "specialist");
  assert.equal(gate.chosenRole, "challenger");
  assert.deepEqual(gate.eligibleRoles, ["challenger"]);
  assert.equal(chooseRole(gate, { remainingTime: 60_000 }).role, "challenger");
  assert.equal(chooseRole(gate, { remainingTime: 15_000, synthesiserFired: false }).role, "challenger", "the deadline nudge can never switch to a role the detector did not choose");
});

// ── plan + preflight compatibility ──────────────────────────────────────────

const planFor = (raw, chat = CHAT) => {
  const checked = check(raw, chat);
  const plan = compilePlan(checked.role, checked.checkedFactors, { score: null, threshold: null, eligibleMessageIds: chat.map((_, i) => `m${i}`) });
  const preflight = preflightPlan(plan, { chat, taskGeneralContext: "Choose City A or City B.", activeParticipantNames: ROSTER });
  return { checked, plan, preflight };
};

test("verified needs compile to the matching fixed operation and pass preflight", () => {
  const cases = [
    [need("ELICIT", "coverage_gap", target(CHAT, [2], { optionLabels: ["City A"] })), "expander", "COVERAGE_GAP_ELICITATION"],
    [need("ELICIT", "participation_gap", target(CHAT, [5], { participantName: "Jordan" })), "expander", "PARTICIPATION_ELICITATION"],
    [need("SCRUTINIZE", "unsupported_claim", target(CHAT, [0, 1], { optionLabels: ["City B"] })), "challenger", "EVIDENCE_AUDIT"],
    [need("INTEGRATE", "cross_option_evidence", target(CHAT, [2, 3], { optionLabels: ["City A", "City B"], criteria: ["transport"] })), "synthesiser", "CROSS_OPTION_COMPARISON"],
  ];
  for (const [raw, role, act] of cases) {
    const { plan, preflight } = planFor(raw);
    assert.equal(plan.role, role);
    assert.equal(plan.requiredReasoningAct, act);
    assert.equal(plan.intensity, "medium", "no numeric score feeds the plan");
    assert.equal(preflight.status, "passed", `${act}: ${preflight.failureReasons}`);
  }
});

test("preflight still blocks a participation target that is not quiet", () => {
  const { plan } = planFor(need("ELICIT", "participation_gap", target(CHAT, [5], { participantName: "Jordan" })));
  const balancedChat = [...CHAT, msg("Jordan", "City A has trains."), msg("Jordan", "City B has trams.")];
  const preflight = preflightPlan(plan, { chat: balancedChat, taskGeneralContext: "Choose City A or City B.", activeParticipantNames: ROSTER });
  assert.equal(preflight.status, "failed");
  assert.ok(preflight.failureReasons.includes("TARGET_UNSUPPORTED"));
});

// ── offline end-to-end through the real callbacks ───────────────────────────

function world(facilitation, lines) {
  const players = ROSTER.map((name, index) => makeFakePlayer({ id: `need-${index}`, name, hexCode: "ffffff" }));
  const byName = Object.fromEntries(players.map((p) => [p.get("name"), p]));
  const game = new FakeGame({}, players);
  const round = new FakeRound({
    index: 0, taskIndex: 0, taskVersion: "A", facilitation,
    generalInfo: "Choose City A or City B using public transport and cost evidence.",
    decisionOptions: [{ id: "a", label: "City A" }, { id: "b", label: "City B" }],
  }, game);
  const stage = new FakeStage({ name: "Task" }, round);
  stage.currentGame = game;
  game.currentRound = round;
  game.currentStage = stage;
  for (const player of players) {
    player.currentGame = game;
    player.round = new FakeScope("playerRound");
    player.stage = new FakeScope("playerStage");
  }
  game.set("deadline", Date.now() + 400_000);
  game.set("taskStartTime", Date.now() - 100_000);
  game.set("humanMessageCount", lines.length - 1);
  game.set("messagesSinceLastPublish", lines.length - 1);
  game.set("chat_round_0", lines.map(({ text, sender }, index) => buildCanonicalMessage({
    messageId: `need-human-${index}`, groupId: game.id, participantId: byName[sender.name].id, roundIndex: 0,
    stage: "Discussion", messageType: "human", speakerType: "human", timestamp: Date.now() + index,
    sequencePosition: index, content: text, sender: { id: byName[sender.name].id, name: sender.name },
  })));
  return { game, round, stage };
}

const provider = (data) => new Response(JSON.stringify({
  choices: [{ message: { content: typeof data === "string" ? data : JSON.stringify(data) }, finish_reason: "stop" }],
  usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
}), { headers: { "content-type": "application/json" } });
const passFlags = () => Object.fromEntries(VALIDATOR_CRITERIA.map((key) => [key, false]));
const published = (game) => game.get("chat_round_0").filter((m) => m.sender?.id === "ai");

async function runCheckpoint(w, detector, generatorFor, { onFetch } = {}) {
  const { handleChat } = await getOfflineCallbacksHarness();
  const calls = [];
  const priorFetch = globalThis.fetch;
  const priorError = console.error;
  console.error = () => {};
  globalThis.fetch = async (_url, options) => {
    const body = JSON.parse(options.body);
    const system = body.messages[0].content;
    onFetch?.(system);
    if (system.startsWith("# assessor.md")) {
      calls.push("detector");
      if (detector === "API_ERROR") return new Response("boom", { status: 500 });
      return provider(detector);
    }
    if (system.startsWith("# validator.md")) { calls.push("validator"); return provider(passFlags()); }
    const prompt = /# (static|expander|challenger|synthesiser|generalist)\.md/.exec(system)?.[1] ?? "unknown";
    calls.push(prompt);
    return provider(generatorFor(prompt, body));
  };
  try { await handleChat(undefined, { game: w.game }); }
  finally { globalThis.fetch = priorFetch; console.error = priorError; }
  return { calls, audit: readAppendOnlyAttribute(w.game, "llmLog").at(-1), published: published(w.game) };
}

const STATIC_REPLY = { role: "STATIC", message: "What else from your notes should the group hear?", groundingMessageIds: [] };

test("end-to-end: ELICIT participation_gap invites the code-verified quiet participant through the Expander", async () => {
  const w = world("adaptive", CHAT);
  const chat = w.game.get("chat_round_0");
  const detector = need("ELICIT", "participation_gap", {
    label: "Invite Jordan", messageIds: ["m5"], evidence: [{ messageId: "m5", span: chat[5].text }],
    optionLabels: [], criteria: [], participantName: "Jordan",
  });
  let expanderContext = "";
  const r = await runCheckpoint(w, detector, (prompt, body) => {
    expanderContext = body.messages[1].content;
    return prompt === "expander"
      ? { role: "INFORMATION_EXPANDER", message: "@[Jordan], anything from your notes on any of the options, good or bad? No worries if not.", groundingMessageIds: [] }
      : STATIC_REPLY;
  });
  assert.deepEqual(r.calls, ["detector", "expander", "validator"]);
  assert.equal(r.published.length, 1);
  assert.match(r.published[0].text ?? r.published[0].content, /@\[Jordan\]/);
  assert.equal(r.audit.selectedRole, "expander");
  assert.equal(r.audit.plan.requiredReasoningAct, "PARTICIPATION_ELICITATION");
  assert.deepEqual(r.audit.quietParticipants, ["Jordan"]);
  assert.match(expanderContext, /PARTICIPATION_ELICITATION/);
});

test("end-to-end: the detector receives exact participation counts and the quiet list", async () => {
  const w = world("adaptive", CHAT);
  let detectorInput = "";
  const { handleChat } = await getOfflineCallbacksHarness();
  const priorFetch = globalThis.fetch;
  globalThis.fetch = async (_url, options) => {
    const body = JSON.parse(options.body);
    if (body.messages[0].content.startsWith("# assessor.md")) { detectorInput = body.messages[1].content; return provider({ need: "NONE", operation: null, target: null, rationale: "" }); }
    if (body.messages[0].content.startsWith("# validator.md")) return provider(passFlags());
    return provider(STATIC_REPLY);
  };
  try { await handleChat(undefined, { game: w.game }); } finally { globalThis.fetch = priorFetch; }
  assert.match(detectorInput, /\[PARTICIPATION_COUNTS\]\n\{"Alex":3,"Casey":3,"Jordan":1\}/);
  assert.match(detectorInput, /\[QUIET_PARTICIPANTS\]\n\["Jordan"\]/);
});

test("end-to-end: a fabricated quotation never reaches a Specialist and uses the Static policy", async () => {
  const w = world("adaptive", CHAT);
  const detector = need("SCRUTINIZE", "unsupported_claim", {
    label: "City B", messageIds: ["m0", "m1"],
    evidence: [{ messageId: "m0", span: "City B is obviously best" }, { messageId: "m1", span: "City B sounds good to me too." }],
    optionLabels: [], criteria: [],
  });
  const r = await runCheckpoint(w, detector, () => STATIC_REPLY);
  assert.deepEqual(r.calls, ["detector", "static", "validator"]);
  assert.equal(r.audit.gateDecision, "static_policy");
  assert.equal(r.audit.fallbackKind, "evidence_check_failed");
  assert.equal(r.audit.checkedDetectorFactors.downgradedReason, "INVALID_EVIDENCE");
  assert.equal(r.published.length, 1);
});

test("robustness: Adaptive publishes exactly one message per checkpoint for every detector outcome (message-count parity with Static)", async () => {
  const outcomes = {
    none: { need: "NONE", operation: null, target: null, rationale: "" },
    verified: need("SCRUTINIZE", "unsupported_claim", { label: "City B", messageIds: ["m0", "m1"], evidence: [{ messageId: "m0", span: "I prefer City B." }, { messageId: "m1", span: "City B sounds good to me too." }], optionLabels: ["City B"], criteria: [] }),
    evidenceFails: need("SCRUTINIZE", "unsupported_claim", { label: "x", messageIds: ["m0", "m2"], evidence: [{ messageId: "m0", span: "I prefer City B." }, { messageId: "m2", span: "City A transport is 12 minutes." }], optionLabels: [], criteria: [] }),
    schemaInvalid: { breadth_deficiency: { status: "present", strength: 1 } },
    notJson: "definitely not json",
    apiError: "API_ERROR",
  };
  const generator = (prompt) => prompt === "challenger"
    ? { role: "EVIDENCE_CHALLENGER", message: "Which task facts support the preference for City B?", groundingMessageIds: ["m0"] }
    : STATIC_REPLY;
  for (const [name, detector] of Object.entries(outcomes)) {
    const w = world("adaptive", CHAT);
    const r = await runCheckpoint(w, detector, generator);
    assert.equal(r.published.length, 1, `${name}: exactly one publication`);
    assert.ok(r.calls.length <= 5, `${name}: bounded provider calls (${r.calls.join(",")})`);
    assert.equal(w.game.get("publishedThisRound"), 1, name);
  }
  const s = world("static", CHAT);
  const staticRun = await runCheckpoint(s, null, () => STATIC_REPLY);
  assert.equal(staticRun.published.length, 1);
  assert.deepEqual(staticRun.calls, ["static", "validator"]);
});

test("Static matched delay: applied and logged when configured; a stage change during the delay makes no provider call", async () => {
  const prior = process.env.STATIC_MATCHED_DELAY_MS;
  process.env.STATIC_MATCHED_DELAY_MS = "40";
  try {
    const w = world("static", CHAT);
    const started = Date.now();
    const r = await runCheckpoint(w, null, () => STATIC_REPLY);
    assert.ok(Date.now() - started >= 40);
    assert.equal(r.audit.staticMatchedDelayMs, 40);
    assert.equal(r.published.length, 1);

    const stale = world("static", CHAT);
    const { handleChat } = await getOfflineCallbacksHarness();
    let requests = 0;
    const priorFetch = globalThis.fetch;
    globalThis.fetch = async () => { requests += 1; return provider(STATIC_REPLY); };
    try {
      const pending = handleChat(undefined, { game: stale.game });
      await new Promise((resolve) => setTimeout(resolve, 5));
      stale.game.currentStage = new FakeStage({ name: "FinalDecision" }, stale.round);
      await pending;
    } finally { globalThis.fetch = priorFetch; }
    assert.equal(requests, 0);
    assert.equal(published(stale.game).length, 0);
    assert.match(readAppendOnlyAttribute(stale.game, "llmLog").at(-1).reason, /matched delay/);
  } finally {
    if (prior === undefined) delete process.env.STATIC_MATCHED_DELAY_MS;
    else process.env.STATIC_MATCHED_DELAY_MS = prior;
  }
});

test("Adaptive never waits for the Static matched delay", async () => {
  const prior = process.env.STATIC_MATCHED_DELAY_MS;
  process.env.STATIC_MATCHED_DELAY_MS = "60000";
  try {
    const w = world("adaptive", CHAT);
    const started = Date.now();
    const r = await runCheckpoint(w, { need: "NONE", operation: null, target: null, rationale: "" }, () => STATIC_REPLY);
    assert.ok(Date.now() - started < 30_000);
    assert.equal(r.audit.staticMatchedDelayMs, undefined);
    assert.equal(r.published.length, 1);
  } finally {
    if (prior === undefined) delete process.env.STATIC_MATCHED_DELAY_MS;
    else process.env.STATIC_MATCHED_DELAY_MS = prior;
  }
});

test("schema accepts the categorical output used throughout these tests", () => {
  assert.equal(validateAgainstAssessorSchema(need("ELICIT", "participation_gap", target(CHAT, [5], { participantName: "Jordan" }))).ok, true);
  assert.equal(validateAgainstAssessorSchema({ need: "NONE", operation: null, target: null, rationale: "" }).ok, true);
});
