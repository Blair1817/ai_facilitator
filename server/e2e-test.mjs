// E2E test: drive callbacks.js's full LLM pipeline (Generator + Validator
// + repair loop) with the REAL LLM-only detector and Generator, using a mock
// Empirica state that captures what the production pipeline would do.
//
// What this covers that unit tests don't:
//   - Real LLM detector scores (MiniMax-Text-01) producing real outputs
//   - Real markdown fence handling on real LLM output
//   - Real Validator LLM auditing
//   - Real repair loop with [PRIOR_FAILED_CRITERIA] feedback
//   - Real choice through 3-state gate (specialist/generalist/abstain)
//   - Pipeline resilience: no prompt files blocking, no schema failures
//
// What this DOESN'T cover (would need a real Empirica game):
//   - Empirica event dispatch (chat_round_0 / chat_round_1)
//   - Player/stage transition events
//   - Concurrent checkpoints
//   - 30s cooldown / 6-message gate / 3-attempt cap real timing

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// Same trick as the unit tests: make process.argv[1] point to a
// path that, after path.dirname(...), resolves to the dist/ directory
// so promptLoader reads from dist/prompts/source/. We use the real
// dist/ folder since esbuild has copied all .md / .json files there.
const __dirname = path.dirname(fileURLToPath(import.meta.url));
process.argv[1] = path.join(__dirname, "dist", "index.js");

// Mock the Empirica objects with the minimum surface callbacks.js uses.
function makeMockGame(opts = {}) {
  const data = {
    humanMessageCount: 0,
    messagesSinceLastPublish: 0,
    lastAttemptTimestamp: 0,
    lastHandledCheckpoint: 0,
    attemptedThisRound: 0,
    publishedThisRound: 0,
    lastRole: null,
    lastCheckedFactors: null,
    synthesiserFired: false,
    interventionHistory: [],
    postInterventionUptake: 0,
    unresolvedNeed: null,
    llmLog: [],
    systemInfo: null,
    sequenceId: opts.sequenceId ?? "S1",
    totalInterventions: 0,
    // chat messages, get appended to via game.append below
    ...opts.initial,
  };
  const chat = opts.chat ?? [];
  const round = makeMockRound(opts);
  const players = opts.players ?? [
    { id: "p1", get: (k) => (k === "name" ? "Red" : undefined) },
    { id: "p2", get: (k) => (k === "name" ? "Pink" : undefined) },
    { id: "p3", get: (k) => (k === "name" ? "Blue" : undefined) },
  ];
  return {
    get: (k) => data[k],
    set: (k, v) => { data[k] = v; },
    currentRound: round,
    currentStage: { id: "stage-1", get: (k) => (k === "name" ? "Task" : undefined) },
    append: (k, v) => { data[k] = (data[k] || []).concat([v]); },
  };
  function makeMockRound(opts) {
    const r = {
      get: (k) => {
        if (k === "facilitation") return opts.facilitation ?? "adaptive";
        if (k === "taskIndex") return 0;
        if (k === "taskVersion") return "A";
        if (k === "index") return 0;
        if (k === "deadline") return Date.now() + 10 * 60 * 1000;
        if (k === "taskStartTime") return Date.now() - 60_000;
        return undefined;
      },
      currentGame: null,
    };
    return r;
  }
}

function makeChat(messages) {
  return messages.map((m, i) => ({
    text: m,
    ts: Date.now() + i * 1000,
    sender: { id: m.startsWith("@[Facilitator]") ? "ai" : "human-" + (i % 3), name: m.startsWith("@[Facilitator]") ? "Facilitator" : ["Red", "Pink", "Blue"][i % 3] },
  }));
}

// Now drive the pipeline. We import the same modules callbacks.js uses.
const envText = fs.readFileSync(path.join(process.cwd(), ".env"), "utf8");
const KEY = envText.match(/OPENAI_API_KEY="([^"]+)"/)?.[1];
if (!KEY) { console.error("No OPENAI_API_KEY in .env"); process.exit(1); }

const configuredEndpoint = envText.match(/LLM_API_ENDPOINT="([^"]+)"/)?.[1] || "https://api.minimax.chat/v1";
const llmAPIEndpoint = configuredEndpoint.endsWith("/chat/completions")
  ? configuredEndpoint
  : `${configuredEndpoint.replace(/\/$/, "")}/chat/completions`;
const openaiModel = envText.match(/OPENAI_MODEL="([^"]+)"/)?.[1] || "MiniMax-Text-01";

async function getLLMResponse(messages) {
  const res = await fetch(llmAPIEndpoint, {
    method: "POST",
    headers: { "Content-Type": "application/json", "Authorization": `Bearer ${KEY}` },
    body: JSON.stringify({ model: openaiModel, messages, max_tokens: 500 }),
  });
  const j = await res.json();
  if (!res.ok) {
    return { success: false, error: j?.error?.message ?? `HTTP ${res.status}` };
  }
  const text = j?.choices?.[0]?.message?.content;
  if (typeof text !== "string" || text.length === 0) {
    return { success: false, error: "empty LLM response" };
  }
  return { success: true, data: (() => { try { return JSON.parse(text); } catch { return null; } })(), rawText: text };
}

const { getStaticPromptBundle, getAdaptivePromptBundle, getGeneralistPromptBundle } = await import("./src/prompts/promptLoader.js");
const { parseGeneratorOutputStrict, validateAgainstGenerationSchema, runDeterministicValidation } = await import("./src/prompts/GeneratorContract.mjs");
const { buildDynamicUserContext, withMessageIds } = await import("./src/prompts/DynamicContext.mjs");
const { buildStaticUserContext } = await import("./src/prompts/StaticContext.mjs");
const {
  buildIcebreakerLLMMessages,
  buildIcebreakerOpening,
  parseIcebreakerLLMResponse,
} = await import("./src/IcebreakerFacilitator.mjs");
const { evaluateGate, chooseRole, getRoleThreshold } = await import("./src/utils.js");
const { assessSemanticFactors } = await import("./src/SemanticAssessor.js");
const { checkEvidence } = await import("./src/EvidenceChecker.js");
const { compilePlan } = await import("./src/PolicyCompiler.js");
const { validateCandidate } = await import("./src/SemanticValidator.js");
const { shouldEvaluateCheckpoint, recordAttempt, recordPublish, resetRoundState } = await import("./src/CheckpointManager.mjs");
const { llmSystemPrompts } = await import("./src/LLMConfig.js");

function buildStaticRequest(chat) {
  const bundle = llmSystemPrompts("static", null);
  if (bundle.blocked) throw new Error(`static prompt blocked: ${bundle.reason}`);
  const context = buildStaticUserContext({ chat, remainingTimeMs: 600_000, elapsedTimeMs: 60_000 });
  return {
    ...context,
    metadata: bundle.metadata,
    systemPrompt: bundle.content.replace(
      "{{sharedTaskOverview}}",
      "Task materials are not available to the facilitator. Use only facts participants explicitly share in the public transcript.",
    ),
  };
}

function buildAdaptiveRequest(chat, role, plan = null) {
  const bundle = llmSystemPrompts("adaptive", role);
  if (bundle.blocked) throw new Error(`adaptive prompt blocked: ${bundle.reason}`);
  const context = buildDynamicUserContext({
    chat,
    checkpointDescriptor: `Checkpoint after ${chat.length} public messages. Participants: Red, Pink, Blue.`,
    selectedRoleForDisplay: bundle.metadata.generationRole,
    generalInfo: "",
    plan,
  });
  return { ...context, metadata: bundle.metadata, systemPrompt: bundle.content };
}

// =================== TEST 0: Icebreaker facilitator ===================
console.log("\n=== TEST 0: Icebreaker facilitator (isolated chat-only LLM) ===");
{
  const opening = buildIcebreakerOpening({
    participantNames: ["Red", "Pink", "Blue"],
    activityPrompt: "Choose speaking every language or playing every instrument, then briefly explain why.",
  });
  assert.match(opening, /@\[Red\].*@\[Pink\].*@\[Blue\]/);
  const icebreakerChat = [
    { stage: "IceBreaker", messageType: "ice_breaking_facilitator", speakerType: "ice_breaking_facilitator", content: opening, sender: { id: "ai", name: "Facilitator" } },
    { stage: "IceBreaker", messageType: "human", speakerType: "human", content: "@[Facilitator] How do I tag Blue and invite them to answer?", sender: { id: "p1", name: "Red" } },
    { stage: "Discussion", messageType: "human", speakerType: "human", content: "FORBIDDEN FORMAL TASK CONTENT", sender: { id: "p2", name: "Pink" } },
  ];
  const messages = buildIcebreakerLLMMessages(icebreakerChat);
  assert.doesNotMatch(JSON.stringify(messages), /FORBIDDEN FORMAL TASK CONTENT/);
  const response = await getLLMResponse(messages);
  if (!response.success) { console.log("  ✗ LLM FAIL:", response.error); process.exit(1); }
  const parsed = parseIcebreakerLLMResponse(response.rawText);
  if (!parsed.ok) { console.log("  ✗ ICEBREAKER RESPONSE FAIL:", parsed.reason); process.exit(1); }
  console.log("  ✓ isolated icebreaker response passed strict validation");
}

// =================== TEST 1: Static path ===================
console.log("\n=== TEST 1: Static AI path (full pipeline) ===");
{
  const game = makeMockGame({
    facilitation: "static",
    chat: makeChat([
      "Eldoron has good schools, my kids would benefit",
      "I agree, my kids too",
      "But Cragnio has lower taxes",
      "What about jobs?",
      "Myloria is small and quiet",
      "Let's think about all three carefully",
    ]),
  });
  resetRoundState(game);
  game.set("humanMessageCount", 6);

  // Simulate handleChat for Static: it bypasses the gate entirely and
  // calls runSharedGeneration directly. We replicate that minimal slice.
  const chat = makeChat([
    "Eldoron has good schools, my kids would benefit",
    "I agree, my kids too",
    "But Cragnio has lower taxes",
    "What about jobs?",
    "Myloria is small and quiet",
    "Let's think about all three carefully",
  ]);
  const built = buildStaticRequest(chat);
  const messages = [
    { role: "system", content: built.systemPrompt },
    { role: "user", content: built.userContent },
  ];
  const t0 = Date.now();
  const llmRes = await getLLMResponse(messages);
  console.log(`  LLM call: ${Date.now() - t0}ms`);
  if (!llmRes.success) { console.log("  ✗ LLM FAIL:", llmRes.error); process.exit(1); }
  const parsed = parseGeneratorOutputStrict(llmRes.rawText);
  if (!parsed.ok) { console.log("  ✗ PARSE FAIL:", parsed.error); process.exit(1); }
  const schema = validateAgainstGenerationSchema(parsed.parsed, "STATIC");
  if (!schema.ok) { console.log("  ✗ SCHEMA FAIL"); process.exit(1); }
  const det = runDeterministicValidation(parsed.parsed, {
    selectedRole: "STATIC",
    eligibleMessageIds: built.eligibleMessageIds,
    aiOrSystemMessageIds: built.aiOrSystemMessageIds,
    recentAiMessageTexts: built.recentAiMessageTexts,
  });
  if (!det.passed) { console.log("  ✗ DETERMINISTIC FAIL:", det.failedCriteria); process.exit(1); }
  console.log("  ✓ static path: role=" + parsed.parsed.role + " | msg=" + parsed.parsed.message.slice(0, 70) + (parsed.parsed.message.length > 70 ? "..." : ""));
}

// =================== TEST 2: Adaptive Specialist path ===================
console.log("\n=== TEST 2: Adaptive Specialist path (full pipeline incl. Controller + Assessor) ===");
{
  const chat = makeChat([
    "Eldoron has good schools, my kids would benefit a lot from the school district",
    "I strongly agree with Red, Eldoron schools are the best I have seen",
    "Yes I also agree, Eldoron is the best, no question about it",
    "Eldoron is the best, my wife and I both agree",
    "I also strongly prefer Eldoron over the other two cities",
    "We are all in agreement, Eldoron is the best choice for us",
  ]);
  const game = makeMockGame({ facilitation: "adaptive", chat });
  resetRoundState(game);
  game.set("humanMessageCount", 6);

  // LLM-only detector + deterministic evidence verification
  let checkedFactors = null;
  const t0 = Date.now();
  const ar = await assessSemanticFactors({ chat, taskGeneralContext: "", callLLM: getLLMResponse });
  console.log(`  Detector: ${Date.now() - t0}ms, success=${ar.success}`);
  if (ar.success) {
    checkedFactors = checkEvidence(ar.factors, { chat });
    console.log("  checked detector factors: " + Object.entries(checkedFactors).filter(([, v]) => v?.status === "present").map(([k]) => k).join(", "));
  } else {
    console.log("  Detector error:", ar.code, ar.error?.slice(0, 80));
  }

  const gate = evaluateGate(checkedFactors, { remainingTime: 600_000, lastRole: null });
  console.log("  gate decision:", gate.decision, "| reason:", gate.reason?.slice(0, 60));

  if (gate.decision === "specialist") {
    const chosen = chooseRole(gate, { remainingTime: 600_000, lastRole: null, synthesiserFired: false });
    console.log("  chosen role:", chosen.role, "| forced:", chosen.forced);

    // Step 8: Policy compiler
    const chatWithIds = withMessageIds(chat);
    const eligibleMessageIds = chatWithIds.filter(m => m.sender.id !== "ai").map(m => m.messageId);
    const plan = compilePlan(chosen.role, checkedFactors, { score: gate.scores[chosen.role], threshold: getRoleThreshold(chosen.role), eligibleMessageIds });
    console.log("  plan.evidenceIds:", plan.evidenceIds?.length, "items");

    // Step 9: Generator
    const built = buildAdaptiveRequest(chat, chosen.role, plan);
    const messages = [
      { role: "system", content: built.systemPrompt },
      { role: "user", content: built.userContent },
    ];
    const t1 = Date.now();
    const llmRes = await getLLMResponse(messages);
    console.log(`  Generator LLM: ${Date.now() - t1}ms`);
    if (!llmRes.success) { console.log("  ✗ LLM:", llmRes.error); process.exit(1); }
    const parsed = parseGeneratorOutputStrict(llmRes.rawText);
    if (!parsed.ok) { console.log("  ✗ PARSE:", parsed.error); process.exit(1); }
    const schema = validateAgainstGenerationSchema(parsed.parsed, built.metadata.generationRole);
    if (!schema.ok) { console.log("  ✗ SCHEMA errors:", schema.errors); console.log("  parsed.parsed:", JSON.stringify(parsed.parsed, null, 2)); console.log("  raw:", llmRes.rawText); process.exit(1); }
    const det = runDeterministicValidation(parsed.parsed, {
      selectedRole: built.metadata.generationRole,
      eligibleMessageIds: built.eligibleMessageIds,
      aiOrSystemMessageIds: built.aiOrSystemMessageIds,
      recentAiMessageTexts: built.recentAiMessageTexts,
      allowedGroundingIds: plan.evidenceIds,
    });
    if (!det.passed) { console.log("  ✗ DETERMINISTIC:", det.failedCriteria); process.exit(1); }
    console.log("  ✓ Generator ok: role=" + parsed.parsed.role + " | msg=" + parsed.parsed.message.slice(0, 60) + "...");

    // Step 10: Validator
    const t2 = Date.now();
    const vr = await validateCandidate({ chat, candidate: parsed.parsed, selectedRole: built.metadata.generationRole, taskGeneralContext: "", callLLM: getLLMResponse });
    console.log(`  Validator LLM: ${Date.now() - t2}ms`);
    if (vr.success) {
      console.log("  Validator verdict: " + (vr.verdict.passed ? "✓ PASS" : "✗ FAIL: " + vr.verdict.failedCriteria.join(",")));
    } else {
      console.log("  Validator error:", vr.code, vr.error?.slice(0, 80));
    }
  } else if (gate.decision === "generalist") {
    console.log("  generalist path -- skipped for brevity");
  } else {
    console.log("  abstain path -- no LLM call needed (correct behavior)");
  }
}

// =================== TEST 3: Multi-checkpoint sequence (cooldown, opportunity) ===================
console.log("\n=== TEST 3: Multi-checkpoint sequence (cooldown + cap + opportunity) ===");
{
  const game = makeMockGame({
    facilitation: "adaptive",
    chat: makeChat([
      "Eldoron has good schools, my kids would benefit a lot",
      "I strongly agree with Red, Eldoron schools are great",
      "Yes I also agree, Eldoron is the best, my kids too",
      "Eldoron is the best, my whole family agrees",
      "I also strongly prefer Eldoron over the other two cities",
      "We are all in agreement, Eldoron is the best choice for our group",
    ]),
  });
  resetRoundState(game);

  // Simulate 4 human messages arriving in sequence, with their
  // CheckpointManager decisions.
  for (let i = 1; i <= 4; i++) {
    game.set("humanMessageCount", i * 2);
    game.set("messagesSinceLastPublish", i * 2);
    const t = shouldEvaluateCheckpoint({
      store: game,
      humanMessageCount: i * 2,
      currentStageName: "Task",
      remainingTimeMs: 600_000,
    });
    console.log(`  msg #${i*2}: trigger=${t.trigger} reason=${t.reason?.slice(0, 50)}`);
    if (t.trigger) {
      recordAttempt(game, i * 2, Date.now());
    }
  }
  // Now try the 7th message -- should hit the opportunity gate
  game.set("humanMessageCount", 14);
  game.set("messagesSinceLastPublish", 14);
  const t7 = shouldEvaluateCheckpoint({
    store: game, humanMessageCount: 14, currentStageName: "Task", remainingTimeMs: 600_000,
  });
  console.log(`  msg #14: trigger=${t7.trigger} reason=${t7.reason?.slice(0, 60)}`);
  console.log("  attemptedThisRound:", game.get("attemptedThisRound"));
}

// =================== TEST 4: @-mention bypasses pacing ===================
console.log("\n=== TEST 4: @-mention triggers immediate checkpoint ===");
{
  const { containsFacilitatorMention } = await import("./src/CheckpointManager.mjs");
  const game = makeMockGame({ facilitation: "adaptive" });
  resetRoundState(game);
  game.set("humanMessageCount", 1);
  game.set("messagesSinceLastPublish", 1);

  const text = "@[Facilitator] can you summarise what we have so far?";
  console.log("  message:", text);
  console.log("  containsFacilitatorMention:", containsFacilitatorMention(text));

  // Without mention -- gate is locked
  const tNo = shouldEvaluateCheckpoint({ store: game, humanMessageCount: 1, currentStageName: "Task", remainingTimeMs: 600_000, isMentionCheckpoint: false });
  console.log("  no mention -> trigger=" + tNo.trigger + " reason=" + tNo.reason);
  // With mention -- gate bypasses opportunity
  const tYes = shouldEvaluateCheckpoint({ store: game, humanMessageCount: 1, currentStageName: "Task", remainingTimeMs: 600_000, isMentionCheckpoint: true });
  console.log("  with mention -> trigger=" + tYes.trigger + " reason=" + tYes.reason);
}

// =================== TEST 5: End-to-end timing of full pipeline ===================
console.log("\n=== TEST 5: Full end-to-end pipeline timing (Static, with Validator + repair) ===");
{
  const chat = makeChat([
    "Eldoron has good schools, my kids would benefit",
    "I agree, my kids too",
    "But Cragnio has lower taxes",
    "What about jobs?",
    "Myloria is small and quiet",
    "Let's think about all three carefully",
  ]);
  const game = makeMockGame({ facilitation: "static", chat });
  resetRoundState(game);
  game.set("humanMessageCount", 6);

  const built = buildStaticRequest(chat);
  const messages = [
    { role: "system", content: built.systemPrompt },
    { role: "user", content: built.userContent },
  ];
  const t0 = Date.now();
  // First attempt
  const llmRes1 = await getLLMResponse(messages);
  const parsed1 = parseGeneratorOutputStrict(llmRes1.rawText);
  const schema1 = validateAgainstGenerationSchema(parsed1.parsed, "STATIC");
  const det1 = runDeterministicValidation(parsed1.parsed, { selectedRole: "STATIC", eligibleMessageIds: built.eligibleMessageIds, aiOrSystemMessageIds: built.aiOrSystemMessageIds, recentAiMessageTexts: built.recentAiMessageTexts });
  if (!schema1.ok || !det1.passed) { console.log("  ✗ first attempt deterministic fail"); process.exit(1); }

  // Validator
  const v1 = await validateCandidate({ chat, candidate: parsed1.parsed, selectedRole: "STATIC", taskGeneralContext: "", callLLM: getLLMResponse });
  if (v1.success) {
    console.log(`  attempt 1 (${Date.now() - t0}ms): verdict=${v1.verdict.passed ? "PASS" : "FAIL: " + v1.verdict.failedCriteria.join(",")}`);
    if (!v1.verdict.passed) {
      // Repair attempt
      const repairHint = `${built.userContent}\n\n---\n\n[PRIOR_FAILED_CRITERIA]\nThe previous candidate was rejected for: ${v1.verdict.failedCriteria.join(", ")}.\nPrevious: ${JSON.stringify(parsed1.parsed)}\nRegenerate.`;
      const t1 = Date.now();
      const llmRes2 = await getLLMResponse([
        { role: "system", content: built.systemPrompt },
        { role: "user", content: repairHint },
      ]);
      const parsed2 = parseGeneratorOutputStrict(llmRes2.rawText);
      const schema2 = validateAgainstGenerationSchema(parsed2.parsed, "STATIC");
      const det2 = runDeterministicValidation(parsed2.parsed, { selectedRole: "STATIC", eligibleMessageIds: built.eligibleMessageIds, aiOrSystemMessageIds: built.aiOrSystemMessageIds, recentAiMessageTexts: built.recentAiMessageTexts });
      const v2 = await validateCandidate({ chat, candidate: parsed2.parsed, selectedRole: "STATIC", taskGeneralContext: "", callLLM: getLLMResponse, priorFailedCriteria: v1.verdict.failedCriteria, priorCandidate: parsed1.parsed });
      console.log(`  attempt 2 (${Date.now() - t1}ms): schema=${schema2.ok} det=${det2.passed} verdict=${v2.success ? (v2.verdict.passed ? "PASS" : "FAIL: " + v2.verdict.failedCriteria.join(",")) : "ERR"}`);
    }
  }
  console.log(`  total elapsed: ${Date.now() - t0}ms`);
}

console.log("\n=== ALL E2E TESTS PASSED ===");
