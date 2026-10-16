import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { FakeGame, FakeRound, FakeStage, FakeScope, makeFakePlayer } from "../test/participant_sim/fakes/fakeStore.mjs";
import { getOfflineCallbacksHarness } from "../test/participant_sim/fakes/loadCallbacks.mjs";
import { buildCanonicalMessage } from "./ExperimentPolicies.mjs";
import { checkEvidence, FACTOR_KEYS } from "./EvidenceChecker.js";
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

  const schema = JSON.parse(fs.readFileSync(path.join(dirname, "prompts/source/runtime/specialist/assessor.schema.json"), "utf8"));
  assert.deepEqual(Object.keys(schema.definitions.evidenceRelation.properties), RELATION_KEYS);
  assert.deepEqual(schema.definitions.evidenceRelation.required, RELATION_KEYS);
  assert.equal(schema.definitions.evidenceRelation.additionalProperties, false);
  assert.deepEqual(Object.keys(schema.properties).filter((key) => FACTOR_KEYS.includes(key)), FACTOR_KEYS);

  const valid = factors({ evidenceRelations: [relation("m0"), relation("m1", { compared: true })] });
  assert.equal(validateAgainstAssessorSchema(valid).ok, true, "separate singular messageId relations are accepted");

  const alias = factors({ evidenceRelations: [{ ...relation("m0"), messageIds: ["m0"] }] });
  delete alias.evidenceRelations[0].messageId;
  assert.equal(validateAgainstAssessorSchema(alias).ok, false, "messageIds is rejected inside evidenceRelations");

  const nestedRelations = factors({
    breadth_deficiency: { ...absentFactor(), evidenceRelations: [] },
  });
  assert.equal(validateAgainstAssessorSchema(nestedRelations).ok, false, "evidenceRelations is rejected inside factor objects");

  const emptyTarget = factors({
    cognitiveTargets: [{
      need: "unsupported_claim",
      label: "Unsupported claim",
      messageIds: [],
      evidence: [],
      optionLabels: [],
      criteria: [],
      status: "open",
    }],
  });
  assert.equal(validateAgainstAssessorSchema(emptyTarget).ok, false, "empty target evidence arrays are rejected");

  for (const key of RELATION_KEYS.slice(1)) {
    const incomplete = relation("m0");
    delete incomplete[key];
    assert.equal(validateAgainstAssessorSchema(factors({ evidenceRelations: [incomplete] })).ok, false, `${key} is required`);
  }
});

test("schema-valid evidence relations still require real public message IDs downstream", () => {
  const chat = world().game.get("chat_round_0");
  const raw = factors({ evidenceRelations: [relation("m0"), relation("m999")] });
  assert.equal(validateAgainstAssessorSchema(raw).ok, true, "JSON shape alone is schema-valid");
  const checked = checkEvidence(raw, { chat });
  assert.deepEqual(checked.evidenceRelations.map((entry) => entry.messageId), ["m0"]);
});

test("Adaptive valid intervention traverses Assessor, evidence checking, Controller, Generator, Validator, publication, and audit", async () => {
  const { handleChat } = await getOfflineCallbacksHarness();
  const w = world();
  const phases = [];
  const assessor = factors({
    justification_deficiency: {
      status: "present",
      strength: 0.8,
      message_ids: ["m0"],
      evidence: [{ messageId: "m0", span: "I prefer City B." }],
    },
    evidenceRelations: [relation("m0")],
  });

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
  assert.equal(audit.checkedDetectorFactors.justification_deficiency.status, "present");
  assert.equal(audit.validator.passed, true);
  assert.equal(audit.outcome, "PUBLISHED");
  assert.equal(audit.messageAdded, true);
  assert.equal(audit.publishedMessageId, published(w.game)[0].messageId);
});

test("Adaptive valid no-need result is a genuine abstention, not detector failure", async () => {
  const { handleChat } = await getOfflineCallbacksHarness();
  const w = world();
  let requests = 0;
  await withFetch(async () => {
    requests += 1;
    return providerResponse(factors());
  }, () => handleChat(undefined, { game: w.game }));

  assert.equal(requests, 1);
  assert.equal(published(w.game).length, 0);
  const audit = readAppendOnlyAttribute(w.game, "llmLog").at(-1);
  assert.equal(audit.gateDecision, "abstain");
  assert.equal(audit.abstentionKind, "no_semantic_need");
  assert.equal(audit.detectorError, undefined);
  assert.equal(audit.outcome, "SILENT");
});

test("messageIds inside evidenceRelations causes Assessor schema failure and fail-closed detector abstention", async () => {
  const { handleChat } = await getOfflineCallbacksHarness();
  const w = world();
  const invalid = factors({ evidenceRelations: [{ ...relation("m0"), messageIds: ["m0"] }] });
  delete invalid.evidenceRelations[0].messageId;
  let requests = 0;
  await withFetch(async () => {
    requests += 1;
    return providerResponse(invalid);
  }, () => handleChat(undefined, { game: w.game }));

  assert.equal(requests, 1, "Generator and Validator must not run");
  assert.equal(published(w.game).length, 0);
  const audit = readAppendOnlyAttribute(w.game, "llmLog").at(-1);
  assert.match(audit.detectorError, /^ASSESSOR_SCHEMA_FAILURE:/);
  assert.equal(audit.gateDecision, "abstain");
  assert.equal(audit.abstentionKind, "detector_unavailable");
});

test("invalid Generator output cannot reach participants", async () => {
  const { handleChat } = await getOfflineCallbacksHarness();
  const w = world();
  let validatorCalled = false;
  const assessor = factors({
    justification_deficiency: {
      status: "present", strength: 0.8, message_ids: ["m0"],
      evidence: [{ messageId: "m0", span: "I prefer City B." }],
    },
  });
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
  const assessor = factors({
    justification_deficiency: {
      status: "present", strength: 0.8, message_ids: ["m0"],
      evidence: [{ messageId: "m0", span: "I prefer City B." }],
    },
  });
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
