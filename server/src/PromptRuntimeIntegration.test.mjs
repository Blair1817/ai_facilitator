import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { FakeGame, FakeRound, FakeStage, FakeScope, makeFakePlayer } from "../test/participant_sim/fakes/fakeStore.mjs";
import { buildCanonicalMessage } from "./ExperimentPolicies.mjs";
import { readAppendOnlyAttribute } from "./AppendOnlyAttribute.mjs";
const dirname = path.dirname(fileURLToPath(import.meta.url));
process.argv[1] = path.join(dirname, "fake-entry.js");
const { getOfflineHandleChat } = await import("../test/participant_sim/fakes/loadCallbacks.mjs");
const { FACTOR_KEYS } = await import("./EvidenceChecker.js");
const { VALIDATOR_CRITERIA } = await import("./SemanticValidator.js");
const { runDeterministicValidation, buildRuntimeGenerationSchema } = await import("./prompts/GeneratorContract.mjs");
const { validatorRuntimePath, runtimeGeneratorBundle, AUTOMATIC_MAX_WORDS } = await import("./prompts/PromptRuntime.mjs");
function world(facilitation = "adaptive") {
  const players = ["Alex", "Casey", "Jordan"].map((name, i) => makeFakePlayer({ id: `synthetic-${i}`, name, hexCode: "ffffff" }));
  const game = new FakeGame({}, players);
  const round = new FakeRound({ index: 0, taskIndex: 0, facilitation, generalInfo: "Choose City A or City B using transport and cost.", decisionOptions: [{ id: "a", label: "City A" }, { id: "b", label: "City B" }] }, game);
  const stage = new FakeStage({ name: "Task" }, round);stage.currentGame = game;
  game.currentRound = round;game.currentStage = stage;
  for (const player of players) { player.currentGame = game;player.round = new FakeScope("playerRound");player.stage = new FakeScope("playerStage"); }
  game.set("deadline", Date.now() + 400000);game.set("taskStartTime", Date.now() - 100000);
  game.set("humanMessageCount", 5);game.set("messagesSinceLastPublish", 5);
  const lines = ["I prefer City B.", "City A transport is 12 minutes.", "City B transport is 18 minutes.", "City A cost is 25000.", "City B cost is 32000.", "Those are my reported figures."];
  game.set("chat_round_0", lines.map((text, i) => buildCanonicalMessage({ messageId: `fixture-${i}`, groupId: game.id, participantId: players[i % 3].id, roundIndex: 0, stage: "Discussion", messageType: "human", speakerType: "human", timestamp: Date.now() + i, sequencePosition: i + 1, content: text, sender: { id: players[i % 3].id, name: players[i % 3].get("name") } })));
  return { game, round, stage };
}
function factors(w, invalidComparison) {
  const all = Object.fromEntries(FACTOR_KEYS.map(k => [k, { status: "absent", strength: 0, message_ids: [], evidence: [] }]));
  const chat = w.game.get("chat_round_0");
  const indices = invalidComparison ? [1, 2, 3] : [0];
  const evidence = indices.map(i => ({ messageId: `m${i}`, span: chat[i].text }));
  const factor = invalidComparison ? "integration_deficiency" : "justification_deficiency";
  all[factor] = { status: "present", strength: .95, message_ids: evidence.map(e => e.messageId), evidence };
  all.evidenceRelations = [];
  all.cognitiveTargets = [{ need: invalidComparison ? "cross_option_evidence" : "unsupported_claim", label: invalidComparison ? "City A transport" : "Alex's preference for City B", messageIds: invalidComparison ? ["m1"] : ["m0"], evidence: invalidComparison ? [evidence[0]] : evidence, optionLabels: invalidComparison ? ["City A"] : ["City B"], criteria: invalidComparison ? ["transport"] : [], status: "open" }];
  return all;
}
async function run(w, { invalidComparison = false, skipDuringValidation = false, rejectSpecialist = false, overlongFirstSpecialist = false } = {}) {
  const handleChat = await getOfflineHandleChat();
  const priorFetch = globalThis.fetch;
  const originalSetTimeout = globalThis.setTimeout;
  const timers = [];
  globalThis.setTimeout = (...args) => { const timer = originalSetTimeout(...args);timers.push(timer);return timer; };
  const requests = [];
  const originalError = console.error;const originalWarn = console.warn;
  console.error = () => {};console.warn = () => {};
  globalThis.fetch = async (_url, options) => {
    const body = JSON.parse(options.body);requests.push(body);
    const system = body.messages[0].content;let data;
    if (system.startsWith("# assessor.md")) data = factors(w, invalidComparison);
    else if (system.startsWith("# validator.md")) {
      data = Object.fromEntries(VALIDATOR_CRITERIA.map(k => [k, false]));
      if (rejectSpecialist && body.messages[1].content.includes("[INTERVENTION_PLAN]")) data.requiredReasoningActMissing = true;
      if (skipDuringValidation) {
        const { handleTestControl } = await import("./TestControls.mjs");
        const skip = handleTestControl(w.game.players[0], { requestId: crypto.randomUUID(), action: "next_stage", gameId: w.game.id, roundId: w.round.id, stageId: w.stage.id, index: 0, version: 0, stageVersion: 0 });
        assert.equal(skip.status, "accepted");
      }
    } else {
      const role = system.includes("# challenger.md") ? "EVIDENCE_CHALLENGER" : system.includes("# generalist.md") ? "GENERALIST" : "STATIC";
      data = { role, message: role === "EVIDENCE_CHALLENGER" ? "Which task facts support the stated preference for City B?" : "What public information would help the group move forward?", groundingMessageIds: role === "EVIDENCE_CHALLENGER" ? ["m0"] : [] };
      if (overlongFirstSpecialist && role === "EVIDENCE_CHALLENGER" && requests.filter(r => r.messages[0].content.includes("# challenger.md")).length === 1) data.message = Array(51).fill("word").join(" ");
    }
    return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(data) }, finish_reason: "stop" }], usage: { total_tokens: 10 } }), { headers: { "content-type": "application/json" } });
  };
  try { await handleChat(undefined, { game: w.game }); }
  finally { globalThis.fetch = priorFetch;globalThis.setTimeout = originalSetTimeout;timers.forEach(clearTimeout);console.error = originalError;console.warn = originalWarn; }
  return { requests, log: readAppendOnlyAttribute(w.game, "llmLog"), published: w.game.get("chat_round_0").filter(m => m.sender?.id === "ai") };
}
test("real callbacks execute v3.2 Assessor -> quoted target -> Challenger plan -> Validator -> publication", async () => {
  const w = world();const r = await run(w);
  assert.equal(r.published.length, 1);
  assert.equal(r.requests.length, 3);
  assert.ok(r.requests[0].max_tokens >= 4096);
  assert.match(r.requests[1].messages[0].content, /# specialist_common.md/);
  assert.match(r.requests[1].messages[1].content, /EVIDENCE_AUDIT/);
  assert.match(r.requests[1].messages[1].content, /\[PLAN_PREFLIGHT\]/);
  assert.match(r.requests[2].messages[1].content, /\[INTERVENTION_PLAN\]/);
  assert.match(r.requests[2].messages[1].content, /\[RECENT_AI_MESSAGES\]/);
  assert.equal(w.round.get("cognitiveInterventionHistory").length, 1);
  assert.equal(r.log.at(-1).visibleWordCount, 10);
});
test("real callbacks send impossible comparison to Generalist before any Specialist Generator call", async () => {
  const r = await run(world(), { invalidComparison: true });
  assert.equal(r.published.length, 1);
  assert.equal(r.requests.length, 3);
  assert.match(r.requests[1].messages[0].content, /# generalist.md/);
  assert.doesNotMatch(r.requests[1].messages[1].content, /\[PLAN_PREFLIGHT\]|\[TARGET\]/);
  assert.doesNotMatch(r.requests[2].messages[1].content, /\[INTERVENTION_PLAN\]/);
  assert.equal(r.log.at(-1).fallbackRoute, "SPECIALIST_TO_GENERALIST");
});
test("real callbacks repair once then use control Generalist without Specialist plan/history leakage", async () => {
  const r = await run(world(), { rejectSpecialist: true });
  assert.equal(r.published.length, 1);
  assert.equal(r.requests.length, 7);
  assert.match(r.requests[4].messages[1].content, /re-audit all thirteen/);
  assert.match(r.requests[5].messages[0].content, /# generalist.md/);
  assert.doesNotMatch(r.requests[6].messages[1].content, /\[INTERVENTION_PLAN\]|\[PLAN_PREFLIGHT\]/);
});
test("test-mode stage skip during real Validator await prevents stale AI publication", async () => {
  const w = world();w.game.set("testControlsEnabled", true);w.game.set("treatment", { testMode: true });w.game.set("treatmentName", "test");
  const r = await run(w, { skipDuringValidation: true });
  assert.equal(r.published.length, 0);
  assert.equal(w.round.get("cognitiveInterventionHistory"), undefined);
});
test("Static real callbacks bypass the Adaptive Assessor and use the 50-word control bundle", async () => {
  const r = await run(world("static"));
  assert.equal(r.requests.length, 2);
  assert.equal(r.published.length, 1);
  assert.match(r.requests[0].messages[0].content, /50 English words/);
  assert.doesNotMatch(r.requests[0].messages[0].content, /# specialist_common.md/);
});
test("automatic vs participant-requested Generalist have separate validator and budget routes", () => {
  assert.equal(validatorRuntimePath("GENERALIST", null), "control_50/validator.md");
  assert.equal(validatorRuntimePath("GENERALIST", "PARTICIPANT_REQUEST"), "frozen_control/validator.md");
  assert.equal(runtimeGeneratorBundle("requested_generalist").metadata.maxWords, null);
  for (const role of ["STATIC", "GENERALIST", "INFORMATION_EXPANDER", "EVIDENCE_CHALLENGER", "INFORMATION_SYNTHESISER"]) {
    for (const count of [49, 50, 51]) {
      const result = runDeterministicValidation({ role, message: Array(count).fill("word").join(" "), groundingMessageIds: [] }, { selectedRole: role, maxWords: AUTOMATIC_MAX_WORDS });
      assert.equal(result.passed, count <= 50);
    }
  }
});
test("Specialist internal labels, excessive sections and out-of-plan IDs cannot pass mechanical publication checks", () => {
  const role = "EVIDENCE_CHALLENGER";
  const bad = runDeterministicValidation({ role, message: "I chose EVIDENCE_AUDIT for your group.", groundingMessageIds: ["m1"] }, { selectedRole: role, eligibleMessageIds: ["m0", "m1"], allowedGroundingIds: ["m0"], enforcePlanGrounding: true, forbidInternalDisclosure: true });
  assert.ok(bad.failedCriteria.includes("INTERNAL_FACILITATION_DISCLOSURE"));
  assert.ok(bad.failedCriteria.includes("GROUNDING_ID_OUTSIDE_PLAN_EVIDENCE"));
});

test("missing or forged Specialist preflight cannot reach an external Validator call", async () => {
  const { validateCandidate } = await import("./SemanticValidator.js");
  const { compilePlan } = await import("./PolicyCompiler.js");
  const { checkEvidence } = await import("./EvidenceChecker.js");
  const { preflightPlan } = await import("./PlanPreflight.mjs");
  const w = world();const chat = w.game.get("chat_round_0");
  const plan = compilePlan("challenger", checkEvidence(factors(w, false), { chat }), { eligibleMessageIds: ["m0"] });
  const marker = preflightPlan(plan, { chat, taskGeneralContext: "City A City B" });
  for (const candidateMarker of [null, { ...marker, checks: { ...marker.checks, evidenceCoverageVerified: false } }, { ...marker, planId: "wrong" }]) {
    const result = await validateCandidate({ chat, candidate: { role: "EVIDENCE_CHALLENGER", message: "What supports B?", groundingMessageIds: ["m0"] }, selectedRole: "EVIDENCE_CHALLENGER", taskGeneralContext: "City A City B", interventionPlan: plan, planPreflight: candidateMarker, callLLM: () => assert.fail("No external call for invalid input") });
    assert.equal(result.verdict.passed, false);
    assert.ok(result.verdict.failedCriteria.includes("requiredReasoningActMissing"));
  }
});

test("schemas resolve from the active versioned route, not stale root descriptions", () => {
  assert.match(buildRuntimeGenerationSchema("STATIC").title, /Automatic Control/);
  assert.match(buildRuntimeGenerationSchema("EVIDENCE_CHALLENGER").title, /Specialist/);
  assert.equal(buildRuntimeGenerationSchema("GENERALIST", "PARTICIPANT_REQUEST").title, "Generator Output Schema");
});

test("word-limit repair and semantic repair share a two-attempt budget before Generalist", async () => {
  const r = await run(world(), { rejectSpecialist: true, overlongFirstSpecialist: true });
  assert.equal(r.requests.filter(r => r.messages[0].content.includes("# challenger.md")).length, 2);
  assert.equal(r.requests.length, 6);
  assert.equal(r.published.length, 1);
  assert.equal(r.log.at(-1).totalGeneratorAttempts, 3);
});
