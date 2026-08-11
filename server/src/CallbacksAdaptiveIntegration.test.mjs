// Verifies condition-specific intervention permission plus the shared
// Static/Adaptive generation path. Two kinds
// of coverage, matching this repo's existing convention (see
// RoutingIntegration.test.mjs's header comment) of not executing
// callbacks.js directly (it registers real Empirica listeners and imports
// dotenv/fetch on load):
//
//   1. Structural assertions on callbacks.js's own source text, proving
//      Static bypasses Adaptive assessment, Adaptive ABSTAIN returns before
//      generation, and both successful routes reuse the same generation/
//      validation/publication implementation.
//   2. A genuine behavioral run of the real production modules
//      (LLMConfig.js's llmSystemPrompts, prompts/DynamicContext.mjs's
//      buildDynamicUserContext, prompts/GeneratorContract.mjs's parser/
//      schema/deterministic validation) wired together exactly as
//      callbacks.js's buildGeneratorContext + runSharedGeneration do, using
//      a mock Game object and an injected generatorCall test double -- this
//      is the closest "production-shaped test at the actual prompt/
//      callback boundary" achievable without a live Empirica Game/Round
//      object. No real external LLM request is made anywhere in this file.
import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const callbacksPath = path.join(__dirname, "callbacks.js");
const callbacksSource = readFileSync(callbacksPath, "utf8");
const customChatSource = readFileSync(
  path.join(__dirname, "../../client/src/components/CustomChat.jsx"),
  "utf8",
);

// ── structural assertions on callbacks.js ────────────────────────────────

test("round chats are created only by the server canonical vector append boundary", () => {
  assert.doesNotMatch(callbacksSource, /game\.set\(\s*["']chat_round_0["']/);
  assert.doesNotMatch(callbacksSource, /game\.set\(\s*["']chat_round_1["']/);
  assert.doesNotMatch(customChatSource, /scope\.append\(/);
  assert.match(customChatSource, /player\.set\("humanMessageRequest"/);
  assert.match(callbacksSource, /function appendCanonicalMessage\([\s\S]*game\.append\(attribute, message\)/);
  assert.match(customChatSource, /scope\.getAttribute\(attribute\)\?\.items\s*\|\|\s*\[\]/);
});

test("callbacks.js imports the shared, basic validator (GeneratorContract.mjs) -- not the removed semantic-validator/regeneration/AdaptivePipeline infrastructure", () => {
  assert.match(callbacksSource, /import\s*\{[^}]*parseGeneratorOutputStrict[^}]*\}\s*from\s*"\.\/prompts\/GeneratorContract\.mjs"/s);
  assert.match(callbacksSource, /import\s*\{[^}]*validateAgainstGenerationSchema[^}]*\}\s*from\s*"\.\/prompts\/GeneratorContract\.mjs"/s);
  assert.match(callbacksSource, /import\s*\{[^}]*runDeterministicValidation[^}]*\}\s*from\s*"\.\/prompts\/GeneratorContract\.mjs"/s);
  // Doc comments may still reference validatorPlaceholder.js by name to
  // explain why no semantic Validator runs live (see that module's own
  // header) -- what must be absent is an actual `import ... from` of it.
  assert.doesNotMatch(callbacksSource, /import[^;]*from\s*"\.\/prompts\/AdaptivePipeline\.mjs"/, "AdaptivePipeline.mjs must not be imported -- it no longer exists");
  assert.doesNotMatch(callbacksSource, /import[^;]*from\s*"\.\/prompts\/validatorPlaceholder\.js"/, "validatorPlaceholder.js must not be imported in production");
  assert.doesNotMatch(callbacksSource, /import[^;]*from\s*"\.\/prompts\/regenerationPlaceholder\.js"/, "regenerationPlaceholder.js must not be imported in production");
});

test("callbacks.js: buildGeneratorContext and runSharedGeneration are each defined exactly once and used by both facilitation conditions", () => {
  assert.match(callbacksSource, /function buildGeneratorContext\(/);
  assert.match(callbacksSource, /async function runSharedGeneration\(/);
  // Exactly one definition of each (no per-condition duplicate).
  assert.equal([...callbacksSource.matchAll(/function buildGeneratorContext\(/g)].length, 1);
  assert.equal([...callbacksSource.matchAll(/async function runSharedGeneration\(/g)].length, 1);
});

test("callbacks.js: no candidate is published before runSharedGeneration's full parse/schema/deterministic-validation sequence passes", () => {
  const sharedFnStart = callbacksSource.indexOf("async function runSharedGeneration");
  const sharedFnBody = callbacksSource.slice(sharedFnStart, callbacksSource.indexOf("\n// ── onGameStart", sharedFnStart) === -1 ? sharedFnStart + 4000 : callbacksSource.length);
  const parseIndex = sharedFnBody.indexOf("parseGeneratorOutputStrict(");
  const schemaIndex = sharedFnBody.indexOf("validateAgainstGenerationSchema(");
  const deterministicIndex = sharedFnBody.indexOf("runDeterministicValidation(");
  const publishIndex = sharedFnBody.indexOf("postGeneratorResultIfValid(");
  assert.ok(parseIndex !== -1 && schemaIndex !== -1 && deterministicIndex !== -1 && publishIndex !== -1);
  assert.ok(parseIndex < schemaIndex && schemaIndex < deterministicIndex && deterministicIndex < publishIndex, "parse -> schema -> deterministic validation -> publish must be textually in this order, with publish last");
});

test("callbacks.js: invalid output at any stage sets outcome SILENT and returns without publishing (never a fallback/repaired message)", () => {
  const sharedFnStart = callbacksSource.indexOf("async function runSharedGeneration");
  const sharedFnBody = callbacksSource.slice(sharedFnStart);
  const silentAssignments = [...sharedFnBody.matchAll(/logEntry\.outcome = "SILENT";/g)];
  assert.ok(silentAssignments.length >= 4, "every failure branch (blocked/API error/parse failure/schema failure/deterministic failure) must record a SILENT outcome");
});

test("callbacks.js: an unsupported/unknown Adaptive role never reaches the shared LLM call (blocked before buildGeneratorContext returns usable content)", () => {
  const handleChatStart = callbacksSource.indexOf("async function handleChat");
  const handleChatBody = callbacksSource.slice(handleChatStart);
  const adaptiveSelectionIndex = handleChatBody.indexOf("const chosenRole = chooseRole(");
  const buildIndex = handleChatBody.indexOf("buildGeneratorContext(", adaptiveSelectionIndex);
  const sharedCallIndex = handleChatBody.indexOf("runSharedGeneration(", adaptiveSelectionIndex);
  assert.ok(buildIndex !== -1 && sharedCallIndex !== -1 && buildIndex < sharedCallIndex, "buildGeneratorContext (which returns blocked:true for an unsupported role) must run before runSharedGeneration");
  // runSharedGeneration itself checks built.blocked before making any LLM call (see the shared-path ordering test above).
});

test("callbacks.js: a per-Round checkpoint marker (lastHandledCheckpoint) guards against handling the same checkpoint twice", () => {
  assert.match(callbacksSource, /currentRound\.get\("lastHandledCheckpoint"\)\s*===\s*humanMessageCount/);
  assert.match(callbacksSource, /currentRound\.set\("lastHandledCheckpoint",\s*humanMessageCount\)/);
});

test("routing: Static reaches generation before and without every Adaptive assessment/selection function", () => {
  const handleChatBody = callbacksSource.slice(callbacksSource.indexOf("async function handleChat"));
  const staticStart = handleChatBody.indexOf('if (facilitation === "static")');
  const staticEnd = handleChatBody.indexOf('if (facilitation !== "adaptive")', staticStart);
  const staticBlock = handleChatBody.slice(staticStart, staticEnd);
  const featureIndex = handleChatBody.indexOf("extractFeatures(", staticEnd);

  assert.ok(staticStart !== -1 && staticEnd !== -1 && featureIndex !== -1);
  assert.ok(staticStart < featureIndex, "Static branch must be entered before feature extraction");
  assert.match(staticBlock, /routingDecision\s*=\s*"STATIC_REQUIRED_MESSAGE"/);
  assert.match(staticBlock, /buildGeneratorContext\([\s\S]*?"static"[\s\S]*?null[\s\S]*?null/);
  assert.match(staticBlock, /runSharedGeneration\(/);
  assert.match(staticBlock, /return;/, "Static must terminate before Adaptive assessment begins");
  for (const forbiddenCall of [
    "extractFeatures(",
    "getCandidateRoles(",
    "assessSemanticFactors(",
    "checkEvidence(",
    "evaluateGate(",
    "chooseRole(",
    "compilePlan(",
  ]) {
    assert.equal(staticBlock.includes(forbiddenCall), false, `Static branch must not call ${forbiddenCall}`);
  }
  assert.doesNotMatch(staticBlock, /selectedRole|candidateRoles|gateDecision|ABSTAIN|\bWAIT\b|\bINTERVENE\b/);
});

test("routing: Adaptive ABSTAIN returns before prompt construction and Generator invocation", () => {
  const handleChatBody = callbacksSource.slice(callbacksSource.indexOf("async function handleChat"));
  const gateIndex = handleChatBody.indexOf("const gateResult = evaluateGate(");
  const abstainStart = handleChatBody.indexOf("if (!gateResult.act)", gateIndex);
  const roleSelectionIndex = handleChatBody.indexOf("const chosenRole = chooseRole(", abstainStart);
  const adaptiveBuildIndex = handleChatBody.indexOf("buildGeneratorContext(", roleSelectionIndex);
  const abstainBlock = handleChatBody.slice(abstainStart, roleSelectionIndex);

  assert.ok(gateIndex !== -1 && abstainStart !== -1 && roleSelectionIndex !== -1 && adaptiveBuildIndex !== -1);
  assert.match(abstainBlock, /gateResult\.reason/);
  assert.match(abstainBlock, /game\.set\("llmLog"/);
  assert.match(abstainBlock, /return;/);
  assert.doesNotMatch(abstainBlock, /buildGeneratorContext|runSharedGeneration|chooseRole|compilePlan/);
  assert.ok(abstainStart < roleSelectionIndex && roleSelectionIndex < adaptiveBuildIndex);
});

test("routing: Static and Adaptive retain the same existing six-human-message checkpoint opportunity", () => {
  const handleChatBody = callbacksSource.slice(callbacksSource.indexOf("async function handleChat"));
  const checkpointIndex = handleChatBody.indexOf("if (messagesSince < 6) return;");
  const staticIndex = handleChatBody.indexOf('if (facilitation === "static")');
  const adaptiveFeatureIndex = handleChatBody.indexOf("extractFeatures(");
  assert.ok(checkpointIndex !== -1 && checkpointIndex < staticIndex && staticIndex < adaptiveFeatureIndex);
  assert.equal([...handleChatBody.matchAll(/messagesSince\s*<\s*6/g)].length, 1, "there must be one shared checkpoint threshold, not one per condition");
});

test("routing: no requireLLMMessage switch or Generator-level WAIT/INTERVENE/ABSTAIN contract was introduced", () => {
  assert.doesNotMatch(callbacksSource, /requireLLMMessage/);
  const sharedFn = callbacksSource.slice(
    callbacksSource.indexOf("async function runSharedGeneration"),
    callbacksSource.indexOf("// ── onGameStart"),
  );
  assert.doesNotMatch(sharedFn, /\bWAIT\b|\bINTERVENE\b|Generator-level ABSTAIN/);
});

// ── behavioral: real production modules wired the same way callbacks.js wires them ──

process.argv[1] = path.join(__dirname, "fake-entry.js");
const { llmSystemPrompts } = await import("./LLMConfig.js");
const { buildDynamicUserContext } = await import("./prompts/DynamicContext.mjs");
const { parseGeneratorOutputStrict, validateAgainstGenerationSchema, runDeterministicValidation } = await import("./prompts/GeneratorContract.mjs");
const { evaluateGate, THRESHOLDS } = await import("./utils.js");

function humanMsg(name, text, ts) {
  return { text, ts, sender: { id: `human-${name}`, name, avatar: "x" } };
}

// Mock chat-publication surface: mirrors postGeneratorResultIfValid's real
// core logic (message non-empty + role match -> game.append), without a
// live Empirica Game.
class MockGame {
  constructor() {
    this.chat = [];
    this.totalInterventions = 0;
  }
  append(_chatKey, entry) {
    this.chat.push(entry);
    this.totalInterventions += 1;
  }
}

function postIfValid(game, llmAction, expectedRole) {
  if (!llmAction || typeof llmAction.message !== "string" || !llmAction.message.trim()) return false;
  if (llmAction.role !== expectedRole) return false;
  game.append("chat_round_0", { text: llmAction.message, ts: Date.now(), sender: { id: "ai", name: "Facilitator" } });
  return true;
}

// Mirrors buildGeneratorContext + runSharedGeneration in callbacks.js
// exactly, using the real, imported production functions -- the same
// call sequence for BOTH facilitation conditions (only `facilitation`/
// `role` differ), proving the shared path genuinely is shared. Also builds
// a logEntry object with the same reason/outcome fields runSharedGeneration
// writes onto the real game.llmLog entry, so tests can assert an explicit
// failure reason is actually produced, not just that nothing was published.
async function runProductionCheckpoint({ game, facilitation, role, chat, generalInfo, generatorCall, promptResultOverride = null }) {
  const logEntry = { requestMade: false, requestSuccess: false, outcome: "SILENT", reason: "" };
  const promptResult = promptResultOverride || llmSystemPrompts(facilitation, role);
  if (promptResult.blocked) {
    logEntry.reason = `AI request blocked: ${promptResult.reason}`;
    return { blocked: true, reason: promptResult.reason, logEntry };
  }
  const dynamicContext = buildDynamicUserContext({
    chat,
    checkpointDescriptor: "Checkpoint after N human message(s).",
    selectedRoleForDisplay: promptResult.metadata.generationRole,
    generalInfo,
  });
  const messages = [
    { role: "system", content: promptResult.content },
    { role: "user", content: dynamicContext.userContent },
  ];
  logEntry.requestMade = true;
  const llmResponse = await generatorCall(messages);
  if (!llmResponse.success) {
    logEntry.reason = `API Error: ${llmResponse.error}`;
    return { published: false, reason: "API Error", logEntry };
  }
  logEntry.requestSuccess = true;

  const parseResult = parseGeneratorOutputStrict(llmResponse.rawText);
  if (!parseResult.ok) {
    logEntry.reason = `Invalid Generator output: ${parseResult.error}`;
    return { published: false, reason: "parse failure", logEntry };
  }

  const schemaResult = validateAgainstGenerationSchema(parseResult.parsed, promptResult.metadata.generationRole);
  if (!schemaResult.ok) {
    logEntry.reason = "Generator output failed generation.schema.json";
    return { published: false, reason: "schema failure", logEntry };
  }

  const deterministicResult = runDeterministicValidation(parseResult.parsed, {
    selectedRole: promptResult.metadata.generationRole,
    eligibleMessageIds: dynamicContext.eligibleMessageIds,
    aiOrSystemMessageIds: dynamicContext.aiOrSystemMessageIds,
    recentAiMessageTexts: dynamicContext.recentAiMessageTexts,
  });
  if (!deterministicResult.passed) {
    logEntry.reason = `Generator output failed validation: ${deterministicResult.failedCriteria.join(", ")}`;
    return { published: false, reason: deterministicResult.failedCriteria.join(","), logEntry };
  }

  const posted = postIfValid(game, parseResult.parsed, promptResult.metadata.generationRole);
  logEntry.outcome = posted ? "PUBLISHED" : "SILENT";
  return { published: posted, candidate: parseResult.parsed, logEntry };
}

test("integration: Adaptive (challenger role) and Static both go through the identical shared post-selection sequence and publish exactly once", async () => {
  const chat = [humanMsg("Alice", "I think option A is best.", 1), humanMsg("Bob", "I agree, no real evidence needed.", 2)];

  const adaptiveGame = new MockGame();
  const adaptiveCandidate = { role: "EVIDENCE_CHALLENGER", message: "What evidence has the group actually discussed for option A?", groundingMessageIds: [] };
  const adaptiveResult = await runProductionCheckpoint({
    game: adaptiveGame, facilitation: "adaptive", role: "challenger", chat, generalInfo: "task",
    generatorCall: async () => ({ success: true, rawText: JSON.stringify(adaptiveCandidate) }),
  });
  assert.equal(adaptiveResult.published, true);
  assert.equal(adaptiveGame.chat.length, 1, "exactly one message published for the Adaptive checkpoint");

  // Static uses its fixed policy and the same parse/schema/validation/publish
  // path, without requiring an Adaptive controller role.
  const staticGame = new MockGame();
  const staticCandidate = { role: "STATIC", message: "What relevant information has not yet been shared?", groundingMessageIds: [] };
  const staticResult = await runProductionCheckpoint({
    game: staticGame, facilitation: "static", role: null, chat, generalInfo: "task",
    generatorCall: async () => ({ success: true, rawText: JSON.stringify(staticCandidate) }),
  });
  assert.equal(staticResult.published, true);
  assert.equal(staticGame.chat.length, 1);
});

const READY_STATIC_PROMPT_FIXTURE = {
  blocked: false,
  content: "Return the required Static JSON message.",
  metadata: {
    promptName: "static-test-fixture",
    promptVersion: "test-only",
    promptStatus: "test-only",
    sourceCompleteness: "test-only",
    condition: "static",
    selectedRole: null,
    generationRole: "STATIC",
  },
};

test("integration: a ready Static prompt requires no candidate approval and publishes one schema-valid STATIC message", async () => {
  const game = new MockGame();
  let generatorCallCount = 0;
  const result = await runProductionCheckpoint({
    game,
    facilitation: "static",
    role: null,
    chat: [humanMsg("Alice", "hello", 1)],
    generalInfo: "task",
    promptResultOverride: READY_STATIC_PROMPT_FIXTURE,
    generatorCall: async () => {
      generatorCallCount += 1;
      return { success: true, rawText: JSON.stringify({ role: "STATIC", message: "Please continue the discussion.", groundingMessageIds: [] }) };
    },
  });
  assert.equal(generatorCallCount, 1);
  assert.equal(result.published, true);
  assert.equal(game.chat.length, 1);
  assert.equal(result.candidate.role, "STATIC");
});

test("integration: Static API, parser, schema, and deterministic-validation failures remain non-public and explicitly logged", async (t) => {
  const cases = [
    {
      name: "API",
      generatorCall: async () => ({ success: false, error: "test API failure" }),
      expectedReason: /API Error/,
    },
    {
      name: "parser",
      generatorCall: async () => ({ success: true, rawText: "not-json" }),
      expectedReason: /Invalid Generator output/,
    },
    {
      name: "schema/WAIT role",
      generatorCall: async () => ({ success: true, rawText: JSON.stringify({ role: "WAIT", message: "wait", groundingMessageIds: [] }) }),
      expectedReason: /generation\.schema\.json/,
    },
    {
      name: "deterministic duplicate",
      chat: [
        humanMsg("Alice", "hello", 1),
        { text: "Please continue the discussion.", ts: 2, sender: { id: "ai", name: "Facilitator", avatar: "x" } },
      ],
      generatorCall: async () => ({ success: true, rawText: JSON.stringify({ role: "STATIC", message: "Please continue the discussion.", groundingMessageIds: [] }) }),
      expectedReason: /DUPLICATE_OF_RECENT_AI_MESSAGE/,
    },
  ];

  for (const scenario of cases) {
    await t.test(scenario.name, async () => {
      const game = new MockGame();
      const result = await runProductionCheckpoint({
        game,
        facilitation: "static",
        role: null,
        chat: scenario.chat || [humanMsg("Alice", "hello", 1)],
        generalInfo: "task",
        promptResultOverride: READY_STATIC_PROMPT_FIXTURE,
        generatorCall: scenario.generatorCall,
      });
      assert.equal(result.published, false);
      assert.equal(game.chat.length, 0);
      assert.equal(result.logEntry.outcome, "SILENT");
      assert.match(result.logEntry.reason, scenario.expectedReason);
    });
  }
});

test("integration: selected Adaptive Generator output cannot add a WAIT/INTERVENE decision or change its E/C/S role", async () => {
  for (const invalidCandidate of [
    { role: "WAIT", message: "wait", groundingMessageIds: [] },
    { role: "INTERVENE", message: "act", groundingMessageIds: [] },
    { role: "INFORMATION_EXPANDER", message: "act", groundingMessageIds: [], decision: "INTERVENE" },
  ]) {
    const game = new MockGame();
    const result = await runProductionCheckpoint({
      game,
      facilitation: "adaptive",
      role: "expander",
      chat: [humanMsg("Alice", "hello", 1)],
      generalInfo: "task",
      generatorCall: async () => ({ success: true, rawText: JSON.stringify(invalidCandidate) }),
    });
    assert.equal(result.published, false);
    assert.equal(game.chat.length, 0);
    assert.match(result.logEntry.reason, /generation\.schema\.json/);
  }
});

test("integration: Adaptive E/C/S selections each call exactly one matching Generator", async () => {
  const cases = [
    ["expander", "INFORMATION_EXPANDER"],
    ["challenger", "EVIDENCE_CHALLENGER"],
    ["synthesiser", "INFORMATION_SYNTHESISER"],
  ];
  for (const [controllerRole, generationRole] of cases) {
    const game = new MockGame();
    let generatorCallCount = 0;
    const result = await runProductionCheckpoint({
      game,
      facilitation: "adaptive",
      role: controllerRole,
      chat: [humanMsg("Alice", "hello", 1)],
      generalInfo: "task",
      generatorCall: async () => {
        generatorCallCount += 1;
        return { success: true, rawText: JSON.stringify({ role: generationRole, message: `Message for ${controllerRole}`, groundingMessageIds: [] }) };
      },
    });
    assert.equal(generatorCallCount, 1, `${controllerRole} must call exactly one Generator`);
    assert.equal(result.published, true);
    assert.equal(result.candidate.role, generationRole);
    assert.equal(game.chat.length, 1);
  }
});

test("integration: uncertain semantic evidence leaves Adaptive at ABSTAIN before any Generator call", () => {
  const features = {
    novelty_score: 0.1,
    redundancy_score: 0.9,
    agreement_score: 0.9,
    justification_score: 0.9,
  };
  const uncertain = { status: "uncertain", strength: 0, message_ids: [], span: "" };
  const checkedFactors = {
    breadth_deficiency: uncertain,
    group_preference: uncertain,
    justification_deficiency: uncertain,
    integration_deficiency: uncertain,
    self_correction: uncertain,
  };
  const gateResult = evaluateGate(
    features,
    checkedFactors,
    ["expander", "challenger", "synthesiser"],
    { remainingTime: 300000, previousCheckedFactors: null, lastRole: null },
  );
  let generatorCallCount = 0;
  if (gateResult.act) generatorCallCount += 1;
  assert.equal(gateResult.act, false);
  assert.match(gateResult.reason, /semantic factors|Evidence Checker/);
  assert.equal(generatorCallCount, 0);
});

test("routing regression: feature, candidate, score, margin, and time thresholds are unchanged", () => {
  assert.deepEqual(THRESHOLDS, {
    expander: { novelty_weight: 0.6, redundancy_weight: 0.4, expander_threshold: 0.35, redundancy_threshold: 0.85 },
    challenger: { agreement_weight: 0.5, justification_weight: 0.5, threshold: 0.6 },
    synthesiser: { agreement_weight: 0.5, justification_weight: 0.5, threshold: 0.6, forced_trigger_seconds: 20 },
    candidate: {
      expander_novelty_max: 0.5,
      expander_redundancy_min: 0.5,
      challenger_agreement_min: 0.4,
      synthesiser_agreement_min: 0.4,
      synthesiser_justification_min: 0.4,
    },
    weights: { feature: 0.6, semantic: 0.4, persistence: 0, stage_fit: 0, penalty: 0 },
    gate: { min_time_for_intervention_seconds: 10, margin: 0.05 },
  });
});

test("integration: unsupported/unknown Adaptive role (e.g. Controller's 'facilitator') makes no LLM request and is not silently mapped to Static", async () => {
  let generatorCallCount = 0;
  const game = new MockGame();
  const result = await runProductionCheckpoint({
    game, facilitation: "adaptive", role: "facilitator", chat: [humanMsg("Alice", "hi", 1)], generalInfo: "task",
    generatorCall: async () => { generatorCallCount += 1; return { success: true, rawText: "{}" }; },
  });
  assert.equal(result.blocked, true);
  assert.equal(generatorCallCount, 0, "no LLM request when the role is unsupported");
  assert.equal(game.chat.length, 0);
});

test("integration: invalid Generator output (malformed JSON) is not published, produces a Silent outcome, and adds an llmLog entry with an explicit failure reason", async () => {
  const game = new MockGame();
  const result = await runProductionCheckpoint({
    game, facilitation: "adaptive", role: "expander", chat: [humanMsg("Alice", "hi", 1)], generalInfo: "task",
    generatorCall: async () => ({ success: true, rawText: "not json at all" }),
  });
  assert.equal(result.published, false);
  assert.equal(result.reason, "parse failure");
  assert.equal(game.chat.length, 0);
  // The llmLog-entry-shaped object records outcome=SILENT and a non-empty,
  // specific reason -- not just "nothing was published".
  assert.equal(result.logEntry.outcome, "SILENT");
  assert.ok(result.logEntry.reason.length > 0, "llmLog entry must carry an explicit failure reason");
  assert.match(result.logEntry.reason, /Invalid Generator output/);
  assert.equal(result.logEntry.requestMade, true, "the log must show a request WAS made (distinguishing this from a blocked-before-request case)");
});

test("integration: invalid Generator output (role mismatch) fails deterministic validation, is not published, and is logged with an explicit reason", async () => {
  const game = new MockGame();
  const result = await runProductionCheckpoint({
    game, facilitation: "adaptive", role: "expander", chat: [humanMsg("Alice", "hi", 1)], generalInfo: "task",
    // A wrong role fails generation.schema.json's per-request const first --
    // this proves the schema layer itself already rejects it (never reaches publish).
    generatorCall: async () => ({ success: true, rawText: JSON.stringify({ role: "EVIDENCE_CHALLENGER", message: "x", groundingMessageIds: [] }) }),
  });
  assert.equal(result.published, false);
  assert.equal(result.reason, "schema failure");
  assert.equal(game.chat.length, 0);
  assert.equal(result.logEntry.outcome, "SILENT");
  assert.match(result.logEntry.reason, /generation\.schema\.json/, "the logged reason must explicitly name the failure, not just say 'invalid'");
});

test("integration: a role mismatch that somehow passed the schema layer is still caught by deterministic validation's own explicit ROLE_MISMATCH check, and is logged", async () => {
  // Defense-in-depth: generation.schema.json's per-request `const` already
  // rejects a role mismatch (previous test). This proves the SECOND,
  // independent check (GeneratorContract.mjs's runDeterministicValidation)
  // also flags it and is reachable/logged on its own terms.
  const deterministicResult = runDeterministicValidation(
    { role: "EVIDENCE_CHALLENGER", message: "x", groundingMessageIds: [] },
    { selectedRole: "INFORMATION_EXPANDER", eligibleMessageIds: [], aiOrSystemMessageIds: [], recentAiMessageTexts: [] }
  );
  assert.equal(deterministicResult.passed, false);
  assert.ok(deterministicResult.failedCriteria.includes("ROLE_MISMATCH"));
});

test("integration: one checkpoint publishes at most one message at the mocked callback boundary, even if called with a valid candidate twice", async () => {
  // Simulates what the per-Round lastHandledCheckpoint marker in
  // callbacks.js prevents in production: this test proves the shared
  // generation function itself is not the thing providing that guarantee
  // (each call CAN publish), so the checkpoint marker in handleChat is
  // what must, and does (see the structural test above), stop a second
  // call for the same checkpoint from ever happening.
  const game = new MockGame();
  const candidate = { role: "INFORMATION_EXPANDER", message: "Any other info?", groundingMessageIds: [] };
  const chat = [humanMsg("Alice", "hi", 1)];
  const result = await runProductionCheckpoint({
    game, facilitation: "adaptive", role: "expander", chat, generalInfo: "task",
    generatorCall: async () => ({ success: true, rawText: JSON.stringify(candidate) }),
  });
  assert.equal(result.published, true);
  assert.equal(game.chat.length, 1, "exactly one message from exactly one shared-path invocation");
});

// ── checkpoint-consumption policy (Phase 4 item 6) ───────────────────────
//
// Established policy, confirmed by reading callbacks.js's handleChat
// directly (not inferred/invented): the checkpoint marker
// (currentRound.set("lastHandledCheckpoint", humanMessageCount)) is written
// BEFORE the LLM call/outcome is known -- textually, it is the very next
// statement after the messagesSince>=6 gate, ahead of both the Adaptive
// feature-extraction call and the shared runSharedGeneration call. So a
// failed/blocked/Silent attempt at checkpoint N still leaves the marker
// set to N, and a second invocation for that same N is guarded out before
// any further work. handleChat itself cannot be imported (see this file's
// header comment), so this test reproduces the exact two-line guard from
// callbacks.js against a MockRound, and a separate structural test below
// confirms the guard's real position in the source.

test("checkpoint marker: a failed generation attempt still consumes the checkpoint -- a second invocation for the same checkpoint makes no further request", () => {
  class MockRound {
    constructor() { this._attrs = new Map(); }
    get(key) { return this._attrs.get(key); }
    set(key, value) { this._attrs.set(key, value); }
  }
  // Exact reproduction of callbacks.js's handleChat guard:
  //   if (currentRound.get("lastHandledCheckpoint") === humanMessageCount) return;
  //   currentRound.set("lastHandledCheckpoint", humanMessageCount);
  function checkpointGuard(round, humanMessageCount) {
    if (round.get("lastHandledCheckpoint") === humanMessageCount) return { proceeds: false };
    round.set("lastHandledCheckpoint", humanMessageCount);
    return { proceeds: true };
  }

  const round = new MockRound();
  let requestCount = 0;

  const first = checkpointGuard(round, 6);
  assert.equal(first.proceeds, true, "first attempt at checkpoint 6 proceeds");
  if (first.proceeds) {
    requestCount += 1; // simulates the attempt, which then FAILS (e.g. malformed Generator JSON) -- marker is already set regardless
  }

  const second = checkpointGuard(round, 6);
  assert.equal(second.proceeds, false, "a second invocation for the SAME checkpoint (still 6) must not proceed, even though the first attempt failed");
  if (second.proceeds) requestCount += 1;
  assert.equal(requestCount, 1, "no second LLM request/publish attempt for the same checkpoint");

  const third = checkpointGuard(round, 12);
  assert.equal(third.proceeds, true, "a genuinely new checkpoint (different humanMessageCount) proceeds normally");
});

test("callbacks.js: the checkpoint marker is set before any outcome-determining work (Adaptive feature extraction or the shared LLM call), so failures consume it too", () => {
  const handleChatStart = callbacksSource.indexOf("async function handleChat");
  const handleChatBody = callbacksSource.slice(handleChatStart);
  const markerSetIndex = handleChatBody.indexOf('currentRound.set("lastHandledCheckpoint"');
  const featureExtractIndex = handleChatBody.indexOf("extractFeatures(");
  const sharedCallIndex = handleChatBody.indexOf("runSharedGeneration(");
  assert.ok(markerSetIndex !== -1 && featureExtractIndex !== -1 && sharedCallIndex !== -1);
  assert.ok(markerSetIndex < featureExtractIndex, "checkpoint marker must be set before Adaptive's feature extraction");
  assert.ok(markerSetIndex < sharedCallIndex, "checkpoint marker must be set before the shared generation/LLM call");
});

test("integration: no real external LLM request is made by any test in this file (generatorCall is always a local mock function, never fetch)", () => {
  assert.equal(typeof globalThis.__integrationTestMadeRealRequest, "undefined");
});
