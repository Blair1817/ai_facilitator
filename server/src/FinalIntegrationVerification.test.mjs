import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { FakeGame, FakeRound, FakeStage, FakeScope, makeFakePlayer } from "../test/participant_sim/fakes/fakeStore.mjs";
import { getOfflineCallbacksHarness } from "../test/participant_sim/fakes/loadCallbacks.mjs";
import { buildCanonicalMessage } from "./ExperimentPolicies.mjs";
import { checkEvidence, checkNeedAssessment, FACTOR_KEYS } from "./EvidenceChecker.js";
import { VALIDATOR_CRITERIA } from "./SemanticValidator.js";
import { readAppendOnlyAttribute } from "./AppendOnlyAttribute.mjs";

const dirname = path.dirname(fileURLToPath(import.meta.url));
process.argv[1] = path.join(dirname, "fake-entry.js");

const { validateAgainstAssessorSchema } = await import("./SemanticAssessor.js");

const RELATION_KEYS = [
  "messageId", "mentioned", "attributed", "evaluated", "compared", "countered", "integrated",
];

function world(facilitation = "adaptive") {
  const players = ["Alex", "Casey", "Jordan"].map((name, index) => makeFakePlayer({
    id: `integration-${index}`,
    name,
    hexCode: "ffffff",
  }));
  const game = new FakeGame({}, players);
  const round = new FakeRound({
    index: 0,
    taskIndex: 0,
    taskVersion: "A",
    facilitation,
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
  game.set("humanMessageCount", 5);
  game.set("messagesSinceLastPublish", 5);
  const lines = [
    "I prefer City B.",
    "City A transport is 12 minutes.",
    "City B transport is 18 minutes.",
    "City A cost is 25000.",
    "City B cost is 32000.",
    "Those are my reported figures.",
  ];
  game.set("chat_round_0", lines.map((content, index) => buildCanonicalMessage({
    messageId: `integration-human-${index}`,
    groupId: game.id,
    participantId: players[index % players.length].id,
    roundIndex: 0,
    stage: "Discussion",
    messageType: "human",
    speakerType: "human",
    timestamp: Date.now() + index,
    sequencePosition: index,
    content,
    sender: { id: players[index % players.length].id, name: players[index % players.length].get("name") },
  })));
  return { game, round, stage, players };
}

function absentFactor() {
  return { status: "absent", strength: 0, message_ids: [], evidence: [] };
}

function factors(overrides = {}) {
  return {
    ...Object.fromEntries(FACTOR_KEYS.map((key) => [key, absentFactor()])),
    evidenceRelations: [],
    cognitiveTargets: [],
    ...overrides,
  };
}

// 2026-10-21: categorical need detector output used by the live path.
function need(needName, operation, target, rationale = "audit") {
  return { need: needName, operation, target, rationale };
}
const NO_NEED = { need: "NONE", operation: null, target: null, rationale: "No current need." };
// City B preference (Alex, m0) with a reply by Jordan (m5): two distinct participants.
const SCRUTINIZE_CITY_B = need("SCRUTINIZE", "unsupported_claim", {
  label: "Preference for City B",
  messageIds: ["m0", "m5"],
  evidence: [{ messageId: "m0", span: "I prefer City B." }, { messageId: "m5", span: "Those are my reported figures." }],
  optionLabels: ["City B"],
  criteria: [],
});

function relation(messageId, overrides = {}) {
  return {
    messageId,
    mentioned: true,
    attributed: true,
    evaluated: false,
    compared: false,
    countered: false,
    integrated: false,
    ...overrides,
  };
}

function validatorFlags(overrides = {}) {
  return {
    ...Object.fromEntries(VALIDATOR_CRITERIA.map((key) => [key, false])),
    ...overrides,
  };
}

function providerResponse(data) {
  return new Response(JSON.stringify({
    choices: [{ message: { content: JSON.stringify(data) }, finish_reason: "stop" }],
    usage: { prompt_tokens: 20, completion_tokens: 10, total_tokens: 30 },
  }), { headers: { "content-type": "application/json" } });
}

function published(game) {
  return game.get("chat_round_0").filter((message) => message.sender?.id === "ai");
}

async function withFetch(fetchImpl, task) {
  const priorFetch = globalThis.fetch;
  const priorSetTimeout = globalThis.setTimeout;
  const priorError = console.error;
  const errors = [];
  const timers = [];
  globalThis.fetch = fetchImpl;
  globalThis.setTimeout = (...args) => {
    const timer = priorSetTimeout(...args);
    timers.push(timer);
    return timer;
  };
  console.error = (...args) => errors.push(args);
  try {
    return await task(errors);
  } finally {
    globalThis.fetch = priorFetch;
    globalThis.setTimeout = priorSetTimeout;
    timers.forEach(clearTimeout);
    console.error = priorError;
  }
}

test("Assessor contract matches the runtime schema and simulator copy exactly", () => {
  const runtimePrompt = fs.readFileSync(path.join(dirname, "prompts/source/runtime/specialist/assessor.md"));
  const simulatorPrompt = fs.readFileSync(path.join(dirname, "../test/participant_sim/prompts/source/runtime/specialist/assessor.md"));
  assert.deepEqual(runtimePrompt, simulatorPrompt);

  // 2026-10-21: categorical need detector contract.
  const schema = JSON.parse(fs.readFileSync(path.join(dirname, "prompts/source/runtime/specialist/assessor.schema.json"), "utf8"));
  assert.deepEqual(schema.required, ["need", "operation", "target", "rationale"]);
  assert.deepEqual(schema.properties.need.enum, ["ELICIT", "SCRUTINIZE", "INTEGRATE", "NONE"]);
  assert.equal(schema.additionalProperties, false);
  assert.equal(schema.definitions.evidenceQuote.additionalProperties, false);

  assert.equal(validateAgainstAssessorSchema(SCRUTINIZE_CITY_B).ok, true);
  assert.equal(validateAgainstAssessorSchema(NO_NEED).ok, true);
  assert.equal(validateAgainstAssessorSchema(factors()).ok, false, "legacy eight-factor output is rejected");

  const emptyTarget = need("SCRUTINIZE", "unsupported_claim", { label: "x", messageIds: [], evidence: [], optionLabels: [], criteria: [] });
  assert.equal(validateAgainstAssessorSchema(emptyTarget).ok, false, "empty target evidence arrays are rejected");

  const aliasQuote = need("SCRUTINIZE", "unsupported_claim", { ...SCRUTINIZE_CITY_B.target, evidence: [{ messageIds: ["m0"], span: "I prefer City B." }] });
  assert.equal(validateAgainstAssessorSchema(aliasQuote).ok, false, "messageIds is rejected inside an evidence quotation");
});

test("passive two-criterion coverage cannot verify integration from two messages by one participant", () => {
  const prompt = fs.readFileSync(path.join(dirname, "prompts/source/runtime/specialist/assessor.md"), "utf8");
  assert.match(prompt, /fragmented_evidence: related facts are spread across at least three messages from at least two participants/);
  assert.match(prompt, /re-verifies every quotation, author count and participation claim/);

  const passiveChat = [
    { text: "Eldoron has the strongest capacity position.", sender: { id: "p1", name: "Red" } },
    { text: "Myloria has the strongest cost position.", sender: { id: "p1", name: "Red" } },
    { text: "The public table contains transport-capacity and total-cost columns.", sender: { id: "p1", name: "Red" } },
  ];
  const raw = need("INTEGRATE", "cross_option_evidence", {
    label: "Connect the capacity and cost rankings",
    messageIds: ["m0", "m1"],
    evidence: [
      { messageId: "m0", span: "Eldoron has the strongest capacity position" },
      { messageId: "m1", span: "Myloria has the strongest cost position" },
    ],
    optionLabels: ["Eldoron", "Myloria"],
    criteria: ["transport capacity"],
  });
  const checked = checkNeedAssessment(raw, { chat: passiveChat, activeParticipantNames: ["Red", "Pink"] });
  assert.equal(checked.need, "NONE");
  assert.equal(checked.role, null);
  assert.equal(checked.downgradedReason, "INSUFFICIENT_DISTINCT_PARTICIPANTS");
});

test("three qualifying messages across two participants can verify integration and its target", () => {
  const distributedChat = [
    { text: "Eldoron capacity is 9,000 visitors per hour.", sender: { id: "p1", name: "Red" } },
    { text: "Myloria cost is 24,000.", sender: { id: "p2", name: "Pink" } },
    { text: "Cragnio has high weather reliability.", sender: { id: "p1", name: "Red" } },
  ];
  const evidence = distributedChat.map((message, index) => ({ messageId: `m${index}`, span: message.text }));
  const raw = factors({
    integration_deficiency: {
      status: "present",
      strength: 0.8,
      message_ids: ["m0", "m1", "m2"],
      evidence,
    },
    cognitiveTargets: [{
      need: "fragmented_evidence",
      label: "Connect the three public contributions",
      messageIds: ["m0", "m1", "m2"],
      evidence,
      optionLabels: ["Eldoron", "Myloria", "Cragnio"],
      criteria: ["transport capacity", "total cost", "weather reliability"],
      status: "open",
    }],
  });

  const checked = checkEvidence(raw, { chat: distributedChat });
  assert.equal(checked.integration_deficiency.status, "present");
  assert.equal(checked.integration_deficiency.downgradedReason, undefined);
  assert.equal(checked.cognitiveTargets.length, 1);
  assert.equal(checked.cognitiveTargets[0].need, "fragmented_evidence");
});

test("schema-valid target quotations still require real public message IDs downstream", () => {
  const chat = world().game.get("chat_round_0");
  const raw = need("SCRUTINIZE", "unsupported_claim", {
    ...SCRUTINIZE_CITY_B.target,
    messageIds: ["m0", "m999"],
    evidence: [{ messageId: "m0", span: "I prefer City B." }, { messageId: "m999", span: "fabricated" }],
  });
  assert.equal(validateAgainstAssessorSchema(raw).ok, true, "JSON shape alone is schema-valid");
  const checked = checkNeedAssessment(raw, { chat, activeParticipantNames: ["Alex", "Casey", "Jordan"] });
  assert.equal(checked.need, "NONE");
  assert.equal(checked.downgradedReason, "INVALID_EVIDENCE");
});

test("Adaptive valid intervention traverses Assessor, evidence checking, Controller, Generator, Validator, publication, and audit", async () => {
  const { handleChat } = await getOfflineCallbacksHarness();
  const w = world();
  const phases = [];
  const assessor = SCRUTINIZE_CITY_B;

  await withFetch(async (_url, options) => {
    const body = JSON.parse(options.body);
    const system = body.messages[0].content;
    if (system.startsWith("# assessor.md")) {
      phases.push("assessor");
      return providerResponse(assessor);
    }
    if (system.startsWith("# validator.md")) {
      phases.push("validator");
      return providerResponse(validatorFlags());
    }
    phases.push("generator");
    assert.match(system, /# challenger\.md/);
    return providerResponse({
      role: "EVIDENCE_CHALLENGER",
      message: "What public evidence supports the stated preference for City B?",
      groundingMessageIds: ["m0"],
    });
  }, () => handleChat(undefined, { game: w.game }));

  assert.deepEqual(phases, ["assessor", "generator", "validator"]);
  assert.equal(published(w.game).length, 1);
  assert.equal(w.game.get("publishedThisRound"), 1);
  const audit = readAppendOnlyAttribute(w.game, "llmLog").at(-1);
  assert.equal(audit.gateDecision, "specialist");
  assert.equal(audit.selectedRole, "challenger");
  assert.equal(audit.checkedDetectorFactors.need, "SCRUTINIZE");
  assert.equal(audit.checkedDetectorFactors.operation, "unsupported_claim");
  assert.equal(audit.checkedDetectorFactors.downgradedReason, null);
  assert.deepEqual(audit.participationCounts, { Alex: 2, Casey: 2, Jordan: 2 });
  assert.equal(audit.validator.passed, true);
  assert.equal(audit.outcome, "PUBLISHED");
  assert.equal(audit.messageAdded, true);
  assert.equal(audit.publishedMessageId, published(w.game)[0].messageId);
});

// 2026-10-21: NONE no longer abstains; Adaptive publishes a Static-policy message.
test("Adaptive NONE result publishes a Static-policy message, not an abstention or detector failure", async () => {
  const { handleChat } = await getOfflineCallbacksHarness();
  const w = world();
  const phases = [];
  await withFetch(async (_url, options) => {
    const system = JSON.parse(options.body).messages[0].content;
    if (system.startsWith("# assessor.md")) { phases.push("assessor"); return providerResponse(NO_NEED); }
    if (system.startsWith("# validator.md")) { phases.push("validator"); return providerResponse(validatorFlags()); }
    phases.push("generator");
    assert.match(system, /# static\.md/);
    return providerResponse({ role: "STATIC", message: "What else from your notes should the group hear?", groundingMessageIds: [] });
  }, () => handleChat(undefined, { game: w.game }));

  assert.deepEqual(phases, ["assessor", "generator", "validator"]);
  assert.equal(published(w.game).length, 1);
  const audit = readAppendOnlyAttribute(w.game, "llmLog").at(-1);
  assert.equal(audit.gateDecision, "static_policy");
  assert.equal(audit.fallbackKind, "no_need");
  assert.equal(audit.routingDecision, "ADAPTIVE_STATIC_POLICY");
  assert.equal(audit.selectedRole, "STATIC");
  assert.equal(audit.detectorError, undefined);
  assert.equal(audit.outcome, "PUBLISHED");
  assert.equal(w.game.get("lastRole"), "STATIC");
  assert.equal(w.game.get("messagesSinceLastPublish"), 0, "a Static-policy publication resets the shared opportunity gate");
});

test("schema-invalid detector output never reaches a Specialist and falls back to the Static policy", async () => {
  const { handleChat } = await getOfflineCallbacksHarness();
  const w = world();
  const invalid = factors();   // legacy eight-factor shape is schema-invalid now
  const phases = [];
  await withFetch(async (_url, options) => {
    const system = JSON.parse(options.body).messages[0].content;
    if (system.startsWith("# assessor.md")) { phases.push("assessor"); return providerResponse(invalid); }
    if (system.startsWith("# validator.md")) { phases.push("validator"); return providerResponse(validatorFlags()); }
    phases.push("generator");
    assert.match(system, /# static\.md/, "no Specialist prompt may be used after a detector failure");
    return providerResponse({ role: "STATIC", message: "What else from your notes should the group hear?", groundingMessageIds: [] });
  }, () => handleChat(undefined, { game: w.game }));

  assert.deepEqual(phases, ["assessor", "generator", "validator"]);
  assert.equal(published(w.game).length, 1);
  const audit = readAppendOnlyAttribute(w.game, "llmLog").at(-1);
  assert.match(audit.detectorError, /^ASSESSOR_SCHEMA_FAILURE:/);
  assert.equal(audit.gateDecision, "static_policy");
  assert.equal(audit.fallbackKind, "detector_unavailable");
  assert.equal(audit.selectedRole, "STATIC");
});

test("invalid Generator output cannot reach participants", async () => {
  const { handleChat } = await getOfflineCallbacksHarness();
  const w = world();
  let validatorCalled = false;
  const assessor = SCRUTINIZE_CITY_B;
  await withFetch(async (_url, options) => {
    const system = JSON.parse(options.body).messages[0].content;
    if (system.startsWith("# assessor.md")) return providerResponse(assessor);
    if (system.startsWith("# validator.md")) {
      validatorCalled = true;
      return providerResponse(validatorFlags());
    }
    return providerResponse({ role: "GENERALIST", message: "City B is clearly best.", groundingMessageIds: ["m0"] });
  }, () => handleChat(undefined, { game: w.game }));

  assert.equal(validatorCalled, false, "deterministically invalid output is rejected before semantic validation");
  assert.equal(published(w.game).length, 0);
  const audit = readAppendOnlyAttribute(w.game, "llmLog").at(-1);
  assert.equal(audit.failureStage, "schema");
  assert.equal(audit.outcome, "SILENT");
});

test("schema-invalid Validator output cannot reach participants", async () => {
  const { handleChat } = await getOfflineCallbacksHarness();
  const w = world();
  const assessor = SCRUTINIZE_CITY_B;
  await withFetch(async (_url, options) => {
    const system = JSON.parse(options.body).messages[0].content;
    if (system.startsWith("# assessor.md")) return providerResponse(assessor);
    if (system.startsWith("# validator.md")) return providerResponse({ notGrounded: false });
    return providerResponse({
      role: "EVIDENCE_CHALLENGER",
      message: "What public evidence supports the stated preference for City B?",
      groundingMessageIds: ["m0"],
    });
  }, () => handleChat(undefined, { game: w.game }));

  assert.equal(published(w.game).length, 0);
  const audit = readAppendOnlyAttribute(w.game, "llmLog").at(-1);
  assert.equal(audit.failureStage, "validator_unavailable");
  assert.equal(audit.outcome, "SILENT_VALIDATOR_UNAVAILABLE");
});

test("a provider result cannot publish after the Game has ended even if an old Task reference remains", async () => {
  const { handleChat } = await getOfflineCallbacksHarness();
  const w = world("static");
  let ended = false;
  await withFetch(async (_url, options) => {
    const system = JSON.parse(options.body).messages[0].content;
    if (!ended && !system.startsWith("# validator.md")) {
      ended = true;
      w.game.set("endedAt", new Date().toISOString());
    }
    if (system.startsWith("# validator.md")) return providerResponse(validatorFlags());
    return providerResponse({
      role: "STATIC",
      message: "What public evidence should the group compare next?",
      groundingMessageIds: [],
    });
  }, () => handleChat(undefined, { game: w.game }));

  assert.equal(ended, true);
  assert.equal(published(w.game).length, 0);
  assert.match(readAppendOnlyAttribute(w.game, "llmLog").at(-1).reason, /stage ended|Game ended/i);
});

test("configured timeout covers a stalled response body, aborts the signal, releases in-flight state, and does not log credentials", async () => {
  const priorTimeout = process.env.LLM_REQUEST_TIMEOUT_MS;
  const priorKey = process.env.OPENAI_API_KEY;
  process.env.LLM_REQUEST_TIMEOUT_MS = "5";
  process.env.OPENAI_API_KEY = "integration-secret-must-not-log";
  const { handleChat } = await getOfflineCallbacksHarness();
  const w = world("static");
  let signal;
  try {
    await withFetch(async (_url, options) => {
      signal = options.signal;
      return {
        ok: true,
        status: 200,
        statusText: "OK",
        headers: { get: () => "application/json" },
        json: () => new Promise(() => {}),
        text: () => new Promise(() => {}),
      };
    }, async (errors) => {
      await handleChat(undefined, { game: w.game });
      assert.doesNotMatch(JSON.stringify(errors), /integration-secret-must-not-log/);
    });
  } finally {
    if (priorTimeout === undefined) delete process.env.LLM_REQUEST_TIMEOUT_MS;
    else process.env.LLM_REQUEST_TIMEOUT_MS = priorTimeout;
    if (priorKey === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = priorKey;
  }

  assert.equal(signal.aborted, true);
  assert.deepEqual(w.game.get("llmInFlight"), {});
  assert.equal(published(w.game).length, 0);
  const audit = readAppendOnlyAttribute(w.game, "llmLog").at(-1);
  assert.equal(audit.failureStage, "generator_api");
  assert.match(audit.reason, /timed out after 5ms/);
});
