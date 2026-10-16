#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import dotenv from "dotenv";

dotenv.config();

const serverDir = process.cwd();
process.argv[1] = path.join(serverDir, "src", "index.js");

const endpointBase = process.env.LLM_API_ENDPOINT || "https://api.minimax.chat/v1";
const endpoint = endpointBase.endsWith("/chat/completions")
  ? endpointBase
  : `${endpointBase.replace(/\/$/, "")}/chat/completions`;
const model = process.env.OPENAI_MODEL || "MiniMax-Text-01";
const apiKey = process.env.OPENAI_API_KEY;
if (!apiKey) throw new Error("OPENAI_API_KEY is missing from the test process environment");

const diagnosticTask = process.env.LIVE_DIAGNOSTIC || "";
const diagnosticMode = diagnosticTask.length > 0;
const requestLimit = diagnosticMode ? 12 : 40;
const MAX_LIVE_REQUESTS = Math.min(requestLimit, Math.max(1, Number.parseInt(process.env.MAX_LIVE_REQUESTS || String(requestLimit), 10)));
const MAX_ESTIMATED_COST_USD = Math.min(5, Math.max(0.01, Number(process.env.MAX_ESTIMATED_COST_USD || "5")));
const INPUT_USD_PER_MILLION = 0.20;
const OUTPUT_USD_PER_MILLION = 1.20;
const accounting = { requests: 0, promptTokens: 0, completionTokens: 0, totalTokens: 0, estimatedCostUsd: 0 };

const [
  { assessSemanticFactors },
  { checkEvidence, FACTOR_KEYS },
  { evaluateGate, chooseRole, getRoleThreshold },
  { compilePlan },
  { llmSystemPrompts },
  { buildDynamicUserContext, withMessageIds },
  { parseGeneratorOutputStrict, validateAgainstGenerationSchema, runDeterministicValidation },
  { validateCandidate, parseValidatorResponse, validateAgainstValidatorSchema },
  { preflightPlan },
  { canPublishTestResult },
  { normalizeGeneratorCandidate },
  { buildChatCompletionPayload, buildSuccessfulLLMResult, extractChatCompletionResponseMetadata, withLLMRequestTimeout, resolveLLMRequestTimeoutMs },
] = await Promise.all([
  import("./src/SemanticAssessor.js"),
  import("./src/EvidenceChecker.js"),
  import("./src/utils.js"),
  import("./src/PolicyCompiler.js"),
  import("./src/LLMConfig.js"),
  import("./src/prompts/DynamicContext.mjs"),
  import("./src/prompts/GeneratorContract.mjs"),
  import("./src/SemanticValidator.js"),
  import("./src/PlanPreflight.mjs"),
  import("./src/TestControls.mjs"),
  import("../client/src/components/facilitatorPresentation.mjs"),
  import("./src/LLMTransport.mjs"),
]);

function estimateRequestCeiling(messages, maxTokens) {
  const inputTokens = Math.ceil(JSON.stringify(messages).length / 4);
  return inputTokens * INPUT_USD_PER_MILLION / 1_000_000 + maxTokens * OUTPUT_USD_PER_MILLION / 1_000_000;
}

async function callLLM(messages, { modelOverride = model, maxTokensOverride = null, stage = "unknown", scenarioId = "unknown" } = {}) {
  const maxTokens = Number.parseInt(maxTokensOverride ?? process.env.LLM_MAX_OUTPUT_TOKENS ?? "1000", 10);
  if (accounting.requests >= MAX_LIVE_REQUESTS) {
    return { success: false, code: "LIVE_REQUEST_LIMIT", error: `Live request limit ${MAX_LIVE_REQUESTS} reached` };
  }
  const ceiling = estimateRequestCeiling(messages, maxTokens);
  if (accounting.estimatedCostUsd + ceiling > MAX_ESTIMATED_COST_USD) {
    return { success: false, code: "LIVE_COST_LIMIT", error: `Estimated cost cap USD ${MAX_ESTIMATED_COST_USD} would be exceeded` };
  }
  accounting.requests += 1;
  const requestIndex = accounting.requests;
  const started = Date.now();
  try {
    const { response, payload } = await withLLMRequestTimeout(async (signal) => {
      const response = await fetch(endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
        body: JSON.stringify(buildChatCompletionPayload({ model: modelOverride, messages, maxTokens })),
        signal,
      });
      return { response, payload: await response.json() };
    }, resolveLLMRequestTimeoutMs(process.env.LLM_REQUEST_TIMEOUT_MS));
    const latencyMs = Date.now() - started;
    if (!response.ok) {
      return { success: false, code: "PROVIDER_HTTP_ERROR", error: payload?.error?.message || `HTTP ${response.status}`, requestIndex, latencyMs, stage, scenarioId };
    }
    const responseMetadata = extractChatCompletionResponseMetadata(payload);
    const usage = responseMetadata.usage || {};
    const promptTokens = usage.prompt_tokens || 0;
    const completionTokens = usage.completion_tokens || 0;
    const totalTokens = usage.total_tokens || promptTokens + completionTokens;
    const estimatedCostUsd = promptTokens * INPUT_USD_PER_MILLION / 1_000_000 + completionTokens * OUTPUT_USD_PER_MILLION / 1_000_000;
    accounting.promptTokens += promptTokens;
    accounting.completionTokens += completionTokens;
    accounting.totalTokens += totalTokens;
    accounting.estimatedCostUsd += estimatedCostUsd;
    const rawText = payload?.choices?.[0]?.message?.content;
    if (typeof rawText !== "string" || rawText.length === 0) {
      return { success: false, code: "PROVIDER_EMPTY_RESPONSE", error: "LLM response contained no message text", requestIndex, latencyMs, usage, estimatedCostUsd, stage, scenarioId };
    }
    return { ...buildSuccessfulLLMResult(rawText, responseMetadata), requestIndex, latencyMs, usage, estimatedCostUsd, stage, scenarioId };
  } catch (error) {
    return { success: false, code: error.code || "PROVIDER_TRANSPORT_ERROR", error: error.message, requestIndex, latencyMs: Date.now() - started, stage, scenarioId };
  }
}

function makeChat(lines) {
  return lines.map(([name, text], index) => ({
    text,
    ts: 1_000 + index * 1_000,
    sender: { id: `human-${name.toLowerCase()}`, name },
  }));
}

const generalInfo = [
  "A committee must choose one of three host cities: Eldoron, Myloria, or Cragnio.",
  "The public decision criteria are transport capacity, total cost, weather reliability, accessibility, and local community support.",
  "The group's goal is to use and compare all publicly shared information before deciding; no city is declared correct in advance.",
].join(" ");

const assessorScenarios = [
  { id: "unsupported_claim", chat: makeChat([["Red", "Eldoron is definitely the cheapest city."], ["Pink", "What public cost evidence supports that claim?"], ["Blue", "No cost figures have been shared yet."], ["Green", "We should not treat cheapest as established."], ["Orange", "The claim still needs support."], ["Red", "I do not have a public figure for it."]]) },
  { id: "missing_public_information", chat: makeChat([["Red", "We have only discussed Eldoron's rail station."], ["Pink", "No cost information has been shared."], ["Blue", "Accessibility has not been discussed either."], ["Green", "We also lack public information about the other cities."], ["Orange", "There is too little evidence to compare options."], ["Red", "We need more concrete public facts."]]) },
  { id: "mentioned_not_evaluated", chat: makeChat([["Red", "The public report says Eldoron can handle 9000 visitors per hour."], ["Pink", "I saw the 9000 visitors figure."], ["Blue", "Yes, that capacity number was mentioned."], ["Green", "We have not discussed whether it is reliable or sufficient."], ["Orange", "The figure is in our discussion but unevaluated."], ["Red", "We should examine what it means."]]) },
  { id: "explicit_cross_option_comparison", chat: makeChat([["Red", "Eldoron capacity is 9000 visitors per hour."], ["Pink", "Myloria capacity is 7000 visitors per hour."], ["Blue", "Eldoron's reported capacity is 2000 higher than Myloria's."], ["Green", "Myloria costs 24000 while Eldoron costs 31000."], ["Orange", "So Eldoron leads on capacity, while Myloria leads on cost."], ["Red", "Those are different trade-offs rather than one obvious winner."]]) },
  { id: "fragmented_across_participants", chat: makeChat([["Red", "Eldoron has 9000-per-hour transport capacity."], ["Pink", "Myloria costs 24000."], ["Blue", "Cragnio has reliable event-season weather."], ["Green", "Myloria has strong accessibility support."], ["Orange", "Cragnio has local volunteer support."], ["Red", "These facts have not yet been organised together."]]) },
  { id: "emerging_integration", chat: makeChat([["Red", "Eldoron has the largest transport capacity."], ["Pink", "Myloria has the lowest stated cost."], ["Blue", "Those facts suggest a capacity-versus-cost trade-off."], ["Green", "We should keep weather and accessibility separate too."], ["Orange", "Our choice may depend on which public criteria we prioritise."], ["Red", "We are beginning to combine the evidence without deciding yet."]]) },
  { id: "premature_group_preference", chat: makeChat([["Red", "I prefer Eldoron."], ["Pink", "I also prefer Eldoron."], ["Blue", "Eldoron feels right."], ["Green", "We have not compared its cost or accessibility."], ["Orange", "Agreement is forming before we examine the evidence."], ["Red", "We still need reasons for the preference."]]) },
  { id: "counterargument_handling", chat: makeChat([["Red", "Eldoron's capacity makes it the strongest option."], ["Pink", "But its reported cost is 31000, higher than Myloria's 24000."], ["Blue", "That cost concern challenges a capacity-only choice."], ["Green", "We need to decide how the cost evidence affects the claim."], ["Orange", "The counterargument remains unresolved."], ["Red", "I have not yet explained that trade-off."]]) },
  { id: "self_correction", chat: makeChat([["Red", "Eldoron is obviously best."], ["Pink", "That was unsupported; what evidence backs it?"], ["Red", "You're right. I retract 'obviously' and only claim its capacity is highest among the figures shared."], ["Blue", "We should compare that with cost and accessibility."], ["Green", "Let's avoid choosing before that comparison."], ["Orange", "The group is correcting its reasoning."]]) },
  { id: "multiple_evidence_relations", chat: makeChat([["Red", "Eldoron capacity is 9000 visitors per hour."], ["Pink", "Myloria costs 24000."], ["Blue", "The 9000 capacity figure supports Eldoron on transport."], ["Green", "The 24000 cost figure supports Myloria on cost."], ["Orange", "Comparing those facts shows a capacity-cost trade-off."], ["Red", "Neither fact alone determines the choice."]]) },
  { id: "ambiguous_insufficient", chat: makeChat([["Red", "Eldoron might be good."], ["Pink", "Maybe Myloria too."], ["Blue", "I am not sure what the evidence says."], ["Green", "We do not have enough detail here."], ["Orange", "It is difficult to draw any conclusion."], ["Red", "We should remain uncertain."]]) },
  { id: "genuine_no_actionable_need", chat: makeChat([["Red", "Eldoron capacity is 9000 and cost is 31000."], ["Pink", "Myloria capacity is 7000 and cost is 24000."], ["Blue", "Cragnio's public strength is weather reliability."], ["Green", "We compared capacity, cost, accessibility, weather and community support."], ["Orange", "We challenged unsupported claims and corrected them."], ["Red", "Our remaining disagreement is a transparent difference in criterion priorities."]]) },
];

const roleScenarios = [
  {
    id: "missing_information_expander",
    expectedRole: "expander",
    purpose: "The discussion remains narrowly focused on Eldoron's transport and omits the other options and criteria.",
    chat: makeChat([
      ["Red", "Eldoron has a large rail station, so transport should be easy."],
      ["Pink", "The Eldoron rail station sounds useful for arriving visitors."],
      ["Blue", "I think we should keep discussing Eldoron's transport."],
      ["Green", "Eldoron can probably move many people by train."],
      ["Orange", "The station makes Eldoron look promising."],
      ["Red", "So far Eldoron's transport is our main reason."],
    ]),
  },
  {
    id: "sparse_factual_information_expander",
    expectedRole: "expander",
    purpose: "The discussion explicitly contains only general impressions and too little concrete factual information to evaluate or compare the options.",
    chat: makeChat([
      ["Red", "We have mostly talked about transport in very general terms."],
      ["Pink", "So far we have not shared concrete cost or accessibility information."],
      ["Blue", "Most of our comments are broad impressions rather than specific facts."],
      ["Green", "We have named the cities but do not have much factual detail in the discussion."],
      ["Orange", "There is not enough concrete information here to compare the options yet."],
      ["Red", "At the moment our discussion is still general rather than evidence-based."],
    ]),
  },
  {
    id: "unsupported_consensus_challenger",
    expectedRole: "challenger",
    purpose: "Several people converge on Eldoron without giving evidence or comparing alternatives.",
    chat: makeChat([
      ["Red", "Eldoron is best."],
      ["Pink", "Yes, Eldoron is best."],
      ["Blue", "I vote Eldoron."],
      ["Green", "Eldoron feels like the obvious choice."],
      ["Orange", "We should just choose Eldoron."],
      ["Red", "It sounds like we all agree already."],
    ]),
  },
  {
    id: "fragmented_evidence_synthesiser",
    expectedRole: "synthesiser",
    purpose: "Different evidence is shared across cities and criteria, but nobody compares or integrates it.",
    chat: makeChat([
      ["Red", "Eldoron has the highest transport capacity."],
      ["Pink", "Myloria has the lowest total cost."],
      ["Blue", "Cragnio has the most reliable weather during the event."],
      ["Green", "Myloria has strong accessibility support for disabled visitors."],
      ["Orange", "Cragnio has enthusiastic local community volunteers."],
      ["Red", "Those are the facts I have seen so far."],
    ]),
  },
  {
    id: "unsupported_tradeoff_challenger",
    expectedRole: "challenger",
    purpose: "A public preference rests on an unexplained inference from one capacity fact.",
    chat: makeChat([
      ["Red", "Eldoron has capacity for 9000 visitors per hour."],
      ["Pink", "That means Eldoron must be our best choice."],
      ["Blue", "The capacity fact is public, but the conclusion has not been justified."],
      ["Green", "We have also mentioned cost and accessibility criteria."],
      ["Orange", "It is unclear how one capacity figure settles the whole choice."],
      ["Red", "The link between that fact and the final preference needs examination."],
    ]),
  },
  {
    id: "unintegrated_criteria_synthesiser",
    expectedRole: "synthesiser",
    purpose: "Several verified facts remain separated by criterion and option without a joint representation.",
    chat: makeChat([
      ["Red", "Eldoron capacity is 9000 visitors per hour."],
      ["Pink", "Eldoron cost is 31000."],
      ["Blue", "Myloria capacity is 7000 visitors per hour."],
      ["Green", "Myloria cost is 24000."],
      ["Orange", "Cragnio has the strongest public weather-reliability report."],
      ["Red", "We have not yet organised these facts by option and criterion."],
    ]),
  },
];

const diagnosticScenarios = [
  {
    ...assessorScenarios.find((scenario) => scenario.id === "counterargument_handling"),
    expectedRole: "challenger",
    purpose: "Recheck the previously schema-invalid counterargument case.",
  },
  {
    ...assessorScenarios.find((scenario) => scenario.id === "ambiguous_insufficient"),
    expectedRole: null,
    purpose: "Recheck the previously schema-invalid ambiguous-evidence case.",
  },
  {
    id: "clear_no_actionable_need",
    expectedRole: null,
    purpose: "A comprehensive, explicitly compared discussion has no unresolved public semantic need.",
    chat: makeChat([
      ["Red", "The public table reports transport capacity of 9000 for Eldoron, 7000 for Myloria, and 8000 for Cragnio."],
      ["Pink", "The same public table reports total cost of 31000 for Eldoron, 24000 for Myloria, and 28000 for Cragnio."],
      ["Blue", "The public notes cover weather reliability, accessibility, and community support for all three cities."],
      ["Green", "Comparing the figures, Eldoron leads on capacity, Myloria on cost, while Cragnio is between them on both measures."],
      ["Orange", "We checked whether capacity alone settled the choice and agreed it does not; cost, weather, accessibility, and community support remain relevant."],
      ["Red", "All public criteria and options have now been compared, and our remaining differences concern transparent priorities rather than missing evidence or unresolved claims."],
    ]),
  },
  {
    id: "clean_fragmented_evidence_synthesiser",
    expectedRole: "synthesiser",
    stopOnRoleMismatch: true,
    purpose: "Every criterion has a supported local comparison, but the criterion-level conclusions remain separate rather than globally integrated.",
    chat: makeChat([
      ["Red", "The public transport table reports 9000 visitors per hour for Eldoron, 8000 for Cragnio, and 7000 for Myloria. Higher throughput reduces arrival bottlenecks, so Eldoron has the strongest capacity position, followed by Cragnio and then Myloria."],
      ["Pink", "The public cost table reports 24000 for Myloria, 28000 for Cragnio, and 31000 for Eldoron. Lower total cost preserves more of the event budget, so Myloria has the strongest cost position, followed by Cragnio and then Eldoron."],
      ["Blue", "The public event-season weather report rates Cragnio high and both Eldoron and Myloria medium. More reliable weather reduces disruption risk, so Cragnio has the strongest weather position while Eldoron and Myloria are tied."],
      ["Green", "The public accessibility report rates Myloria high and both Eldoron and Cragnio medium. Better accessibility enables more disabled visitors to participate, so Myloria has the strongest accessibility position while Eldoron and Cragnio are tied."],
      ["Orange", "The public community-support report rates Cragnio high and both Eldoron and Myloria medium. Stronger community support provides more local help with event delivery, so Cragnio has the strongest community-support position while Eldoron and Myloria are tied."],
    ]),
  },
];

function factorSummary(factors) {
  return Object.fromEntries(FACTOR_KEYS.map((key) => [key, {
    status: factors?.[key]?.status ?? null,
    strength: factors?.[key]?.strength ?? null,
    messageIds: factors?.[key]?.message_ids || [],
  }]));
}

async function runAssessorScenario(scenario, phase = "A") {
  const started = Date.now();
  let provider = null;
  const detector = await assessSemanticFactors({
    chat: scenario.chat,
    contextScope: "complete_current_round",
    interventionHistory: [],
    activeParticipantNames: [...new Set(scenario.chat.map((message) => message.sender.name))],
    taskGeneralContext: generalInfo,
    callLLM: async (messages) => {
      provider = await callLLM(messages, {
        modelOverride: process.env.DETECTOR_MODEL || model,
        maxTokensOverride: Number.parseInt(process.env.LLM_MAX_OUTPUT_TOKENS || "1000", 10),
        stage: "assessor",
        scenarioId: scenario.id,
      });
      return provider;
    },
  });
  const base = {
    phase,
    id: scenario.id,
    success: detector.success,
    code: detector.code || null,
    providerCode: provider?.code || null,
    error: detector.error || provider?.error || null,
    latencyMs: Date.now() - started,
    providerLatencyMs: provider?.latencyMs ?? null,
    requestIndex: provider?.requestIndex ?? null,
    finishReason: provider?.responseMetadata?.finish_reason ?? null,
    usage: provider?.usage || null,
    estimatedCostUsd: provider?.estimatedCostUsd ?? 0,
  };
  if (!detector.success) return { ...base, schemaPassed: false, failClosed: true };

  const validIds = new Set(withMessageIds(scenario.chat).map((message) => message.messageId));
  const relations = detector.factors.evidenceRelations || [];
  const singularContract = relations.every((entry) => typeof entry.messageId === "string"
    && !("messageIds" in entry) && !("message_ids" in entry)
    && ["mentioned", "attributed", "evaluated", "compared", "countered", "integrated"].every((key) => typeof entry[key] === "boolean"));
  const checked = checkEvidence(detector.factors, { chat: scenario.chat });
  const invalidRawIds = relations.filter((entry) => !validIds.has(entry.messageId)).map((entry) => entry.messageId);
  const invalidAcceptedIds = (checked.evidenceRelations || []).filter((entry) => !validIds.has(entry.messageId)).map((entry) => entry.messageId);
  const evidenceCheckerPassed = FACTOR_KEYS.every((key) => detector.factors[key].status !== "present"
      || (checked[key].status === "present" && !checked[key].downgradedReason))
    && relations.length === checked.evidenceRelations.length
    && (detector.factors.cognitiveTargets?.length || 0) === checked.cognitiveTargets.length;
  return {
    ...base,
    schemaPassed: true,
    allEightFactors: FACTOR_KEYS.every((key) => detector.factors[key] && typeof detector.factors[key] === "object"),
    singularMessageIdContract: singularContract,
    rawFactors: factorSummary(detector.factors),
    checkedFactors: factorSummary(checked),
    rawEvidenceRelations: relations,
    checkedEvidenceRelations: checked.evidenceRelations || [],
    rawCognitiveTargetCount: detector.factors.cognitiveTargets?.length || 0,
    checkedCognitiveTargetCount: checked.cognitiveTargets?.length || 0,
    invalidRawIds,
    invalidAcceptedIds,
    evidenceCheckerPassed,
    passed: singularContract && invalidRawIds.length === 0 && invalidAcceptedIds.length === 0 && evidenceCheckerPassed,
    factors: detector.factors,
    checked,
  };
}

function simulatedPublicationGuard() {
  const stage = { id: "synthetic-task", get: (key) => ({ name: "Task", ended: false })[key] };
  const round = { id: "synthetic-round" };
  const values = new Map();
  const game = { currentStage: stage, currentRound: round, get: (key) => values.get(key) };
  const origin = { stageId: stage.id, roundId: round.id };
  const activeAllowed = canPublishTestResult(game, origin);
  values.set("endedAt", new Date().toISOString());
  const endedBlocked = !canPublishTestResult(game, origin);
  return { activeAllowed, endedBlocked, simulatedPublished: activeAllowed };
}

async function runScenario(scenario) {
  const started = Date.now();
  const stageLatencyMs = {};
  const stageUsage = {};
  const assessor = await runAssessorScenario(scenario, "B");
  stageLatencyMs.detector = assessor.providerLatencyMs;
  stageUsage.detector = assessor.usage;
  if (!assessor.schemaPassed) {
    return { id: scenario.id, expectedRole: scenario.expectedRole, stage: "detector", passed: false, error: assessor.error, code: assessor.code, finishReason: assessor.finishReason, stageLatencyMs, stageUsage, elapsedMs: Date.now() - started };
  }
  if (!assessor.passed) {
    return {
      id: scenario.id,
      expectedRole: scenario.expectedRole,
      stage: "evidence_checker",
      passed: false,
      finishReason: assessor.finishReason,
      evidenceCheckerPassed: assessor.evidenceCheckerPassed,
      invalidRawIds: assessor.invalidRawIds,
      invalidAcceptedIds: assessor.invalidAcceptedIds,
      stageLatencyMs,
      stageUsage,
      elapsedMs: Date.now() - started,
    };
  }

  const checked = assessor.checked;
  const gate = evaluateGate(checked, { remainingTime: 480_000, lastRole: null });
  const base = {
    id: scenario.id,
    purpose: scenario.purpose,
    expectedRole: scenario.expectedRole,
    assessor: {
      schemaPassed: assessor.schemaPassed,
      finishReason: assessor.finishReason,
      singularMessageIdContract: assessor.singularMessageIdContract,
      invalidAcceptedIds: assessor.invalidAcceptedIds,
      rawFactors: assessor.rawFactors,
      checkedFactors: assessor.checkedFactors,
      evidenceRelationCount: assessor.checkedEvidenceRelations.length,
      cognitiveTargetCount: assessor.checkedCognitiveTargetCount,
      evidenceRelations: assessor.checkedEvidenceRelations,
      cognitiveTargets: checked.cognitiveTargets,
      evidenceCheckerPassed: assessor.evidenceCheckerPassed,
    },
    gate: {
      decision: gate.decision,
      chosenRole: gate.chosenRole || null,
      scores: gate.scores,
      reason: gate.reason,
      perRole: gate.perRole,
    },
  };
  if (gate.decision !== "specialist") {
    return { ...base, stage: "classification", passed: false, safeAbstention: gate.decision === "abstain", abstention: gate.decision === "abstain", stageLatencyMs, stageUsage, elapsedMs: Date.now() - started };
  }

  const chosen = chooseRole(gate, { remainingTime: 480_000, lastRole: null, synthesiserFired: false });
  if (scenario.stopOnRoleMismatch && chosen.role !== scenario.expectedRole) {
    return {
      ...base,
      stage: "classification",
      chosenRole: chosen.role,
      roleMatched: false,
      passed: false,
      stageLatencyMs,
      stageUsage,
      elapsedMs: Date.now() - started,
    };
  }
  const ids = withMessageIds(scenario.chat).map((message) => message.messageId);
  const plan = compilePlan(chosen.role, checked, {
    score: gate.scores[chosen.role],
    threshold: getRoleThreshold(chosen.role),
    eligibleMessageIds: ids,
  });
  const activeParticipantNames = [...new Set(scenario.chat.map((message) => message.sender.name))];
  const planPreflight = preflightPlan(plan, {
    chat: scenario.chat,
    taskGeneralContext: generalInfo,
    activeParticipantNames,
    contextScope: "complete_current_round",
    interventionHistory: [],
  });
  if (planPreflight.status !== "passed") {
    return { ...base, stage: "plan_preflight", passed: false, chosenRole: chosen.role, plan, planPreflight, stageLatencyMs, stageUsage, elapsedMs: Date.now() - started };
  }
  const prompt = llmSystemPrompts("adaptive", chosen.role);
  if (prompt.blocked) {
    return { ...base, stage: "prompt", passed: false, error: prompt.reason, plan };
  }

  const dynamic = buildDynamicUserContext({
    chat: scenario.chat,
    checkpointDescriptor: `Synthetic evaluation checkpoint after ${scenario.chat.length} human messages; 8 minutes remain.`,
    selectedRoleForDisplay: prompt.metadata.generationRole,
    generalInfo,
    plan,
    planPreflight,
    activeParticipantNames,
    interventionHistory: [],
    contextScope: "complete_current_round",
  });
  const generatorStarted = Date.now();
  const generation = await callLLM([
    { role: "system", content: prompt.content },
    { role: "user", content: dynamic.userContent },
  ], {
    modelOverride: process.env.GENERATOR_MODEL || model,
    stage: "generator",
    scenarioId: scenario.id,
  });
  stageLatencyMs.generator = generation.latencyMs ?? Date.now() - generatorStarted;
  stageUsage.generator = generation.usage || null;
  if (!generation.success) {
    return { ...base, stage: "generator", passed: false, error: generation.error, plan };
  }
  const parsed = parseGeneratorOutputStrict(generation.rawText);
  if (!parsed.ok) {
    return { ...base, stage: "generator_parse", passed: false, rawGeneration: generation.rawText, error: parsed.error, plan };
  }
  const schema = validateAgainstGenerationSchema(parsed.parsed, prompt.metadata.generationRole);
  const candidate = normalizeGeneratorCandidate(parsed.parsed);
  const deterministic = runDeterministicValidation(candidate, {
    selectedRole: prompt.metadata.generationRole,
    eligibleMessageIds: dynamic.eligibleMessageIds,
    aiOrSystemMessageIds: dynamic.aiOrSystemMessageIds,
    recentAiMessageTexts: dynamic.recentAiMessageTexts,
    allowedGroundingIds: dynamic.allowedGroundingIds,
    maxWords: plan.maxWords,
    maxSentences: 3,
    maxSections: prompt.metadata.generationRole === "INFORMATION_SYNTHESISER" ? 2 : 0,
    enforcePlanGrounding: true,
    forbidInternalDisclosure: true,
    activeParticipantNames,
  });
  let validatorRawText = null;
  const validatorCall = async (messages) => {
    const response = await callLLM(messages, {
      modelOverride: process.env.VALIDATOR_MODEL || model,
      stage: "validator",
      scenarioId: scenario.id,
    });
    validatorRawText = response.rawText || null;
    stageUsage.validator = response.usage || null;
    return response;
  };
  const validatorStarted = Date.now();
  const validator = schema.ok && deterministic.passed
    ? await validateCandidate({
        chat: scenario.chat,
        candidate,
        selectedRole: prompt.metadata.generationRole,
        taskGeneralContext: generalInfo,
        callLLM: validatorCall,
        interventionPlan: plan,
        planPreflight,
        interventionHistory: [],
        recentAiMessages: [],
        activeParticipantNames,
        contextScope: "complete_current_round",
        triggerType: "AUTOMATIC_CHECKPOINT",
      })
    : null;
  stageLatencyMs.validator = schema.ok && deterministic.passed ? Date.now() - validatorStarted : 0;

  const roleMatched = chosen.role === scenario.expectedRole;
  const outputPassed = schema.ok && deterministic.passed && validator?.success && validator.verdict.passed;
  const publication = outputPassed ? simulatedPublicationGuard() : { activeAllowed: false, endedBlocked: true, simulatedPublished: false };
  const flattenedMessage = candidate.message || "";
  const wordCount = flattenedMessage.trim() ? flattenedMessage.trim().split(/\s+/).filter(Boolean).length : 0;
  const sentenceCount = flattenedMessage.trim()
    ? [...new Intl.Segmenter("en", { granularity: "sentence" }).segment(flattenedMessage)].filter((entry) => entry.segment.trim()).length
    : 0;
  return {
    ...base,
    stage: "complete",
    chosenRole: chosen.role,
    roleMatched,
    plan,
    planPreflight,
    candidate: process.env.REDACT_CONTENT === "1"
      ? {
          role: candidate.role,
          messageChars: candidate.message?.length || 0,
          wordCount,
          sentenceCount,
          groundingCount: candidate.groundingMessageIds?.length || 0,
        }
      : { ...candidate, wordCount, sentenceCount },
    checks: {
      schema: schema.ok,
      deterministic: deterministic.passed,
      deterministicFailures: deterministic.failedCriteria || [],
      validatorAvailable: validator?.success || false,
      validatorPassed: validator?.success ? validator.verdict.passed : false,
      validatorFailures: validator?.success ? validator.verdict.failedCriteria : [validator?.error || "validator unavailable"],
      validatorRawText: validator?.success || process.env.REDACT_CONTENT === "1" ? undefined : validatorRawText,
    },
    passed: roleMatched && outputPassed,
    publication,
    stageLatencyMs,
    stageUsage,
    elapsedMs: Date.now() - started,
  };
}

async function runValidatorOnlyDiagnostic() {
  const scenario = diagnosticScenarios.find((entry) => entry.id === "clean_fragmented_evidence_synthesiser");
  const chatWithIds = withMessageIds(scenario.chat);
  const evidence = chatWithIds.map((message) => ({
    messageId: message.messageId,
    span: message.text.slice(message.text.indexOf("so ") + 3),
  }));
  const checked = Object.fromEntries(FACTOR_KEYS.map((key) => [key, { status: "absent", strength: 0, message_ids: [], evidence: [] }]));
  checked.integration_deficiency = {
    status: "present",
    strength: 0.8,
    message_ids: chatWithIds.map((message) => message.messageId),
    evidence,
  };
  checked.cognitiveTargets = [{
    need: "fragmented_evidence",
    label: "Connect and compare the five criterion rankings across Eldoron, Myloria, and Cragnio.",
    messageIds: chatWithIds.map((message) => message.messageId),
    evidence,
    optionLabels: ["Eldoron", "Myloria", "Cragnio"],
    criteria: ["transport capacity", "total cost", "weather reliability", "accessibility", "local community support"],
    status: "open",
  }];
  checked.evidenceRelations = [];

  const plan = compilePlan("synthesiser", checked, {
    score: 0.8,
    threshold: getRoleThreshold("synthesiser"),
    eligibleMessageIds: chatWithIds.map((message) => message.messageId),
  });
  const activeParticipantNames = [...new Set(scenario.chat.map((message) => message.sender.name))];
  const planPreflight = preflightPlan(plan, {
    chat: scenario.chat,
    taskGeneralContext: generalInfo,
    activeParticipantNames,
    contextScope: "complete_current_round",
    interventionHistory: [],
  });
  const candidate = {
    role: "INFORMATION_SYNTHESISER",
    message: "Capacity ranks Eldoron, Cragnio, then Myloria; cost ranks Myloria, Cragnio, then Eldoron. Myloria leads accessibility, while Cragnio leads weather and community support; the remaining ratings are tied at medium.",
    groundingMessageIds: chatWithIds.map((message) => message.messageId),
  };
  const generationSchema = validateAgainstGenerationSchema(candidate, candidate.role);
  const deterministic = runDeterministicValidation(candidate, {
    selectedRole: candidate.role,
    eligibleMessageIds: chatWithIds.map((message) => message.messageId),
    aiOrSystemMessageIds: [],
    recentAiMessageTexts: [],
    allowedGroundingIds: plan.evidenceIds,
    maxWords: plan.maxWords,
    maxSentences: 3,
    maxSections: 2,
    enforcePlanGrounding: true,
    forbidInternalDisclosure: true,
    activeParticipantNames,
  });
  if (!generationSchema.ok || !deterministic.passed || planPreflight.status !== "passed") {
    return { attempted: false, generationSchema: generationSchema.ok, deterministic, planPreflight };
  }

  let provider = null;
  const started = Date.now();
  const result = await validateCandidate({
    chat: scenario.chat,
    candidate,
    selectedRole: candidate.role,
    taskGeneralContext: generalInfo,
    callLLM: async (messages) => {
      provider = await callLLM(messages, { stage: "validator_only", scenarioId: scenario.id });
      return provider;
    },
    interventionPlan: plan,
    planPreflight,
    interventionHistory: [],
    recentAiMessages: [],
    activeParticipantNames,
    contextScope: "complete_current_round",
  });
  const parsed = parseValidatorResponse(provider?.rawText);
  const schema = parsed.ok ? validateAgainstValidatorSchema(parsed.parsed) : { ok: false };
  return {
    attempted: true,
    finishReason: provider?.responseMetadata?.finish_reason ?? null,
    usage: provider?.usage || null,
    estimatedCostUsd: provider?.estimatedCostUsd ?? 0,
    latencyMs: provider?.latencyMs ?? Date.now() - started,
    generationSchema: generationSchema.ok,
    deterministic: deterministic.passed,
    planPreflight: planPreflight.status,
    parsePassed: parsed.ok,
    schemaPassed: schema.ok,
    returnedFields: parsed.ok ? Object.keys(parsed.parsed) : [],
    semanticValidationAvailable: result.success,
    semanticPassed: result.success ? result.verdict.passed : false,
    failedCriteria: result.success ? result.verdict.failedCriteria : [],
    code: result.code || null,
    error: result.error || null,
  };
}

async function runGeneratorOnlyDiagnostic() {
  const scenario = diagnosticScenarios.find((entry) => entry.id === "clean_fragmented_evidence_synthesiser");
  const chatWithIds = withMessageIds(scenario.chat);
  const evidence = chatWithIds.map((message) => ({
    messageId: message.messageId,
    span: message.text.slice(message.text.indexOf("so ") + 3),
  }));
  const checked = Object.fromEntries(FACTOR_KEYS.map((key) => [key, { status: "absent", strength: 0, message_ids: [], evidence: [] }]));
  checked.integration_deficiency = {
    status: "present",
    strength: 0.8,
    message_ids: chatWithIds.map((message) => message.messageId),
    evidence,
  };
  checked.cognitiveTargets = [{
    need: "fragmented_evidence",
    label: "Connect and compare the five criterion rankings across Eldoron, Myloria, and Cragnio.",
    messageIds: chatWithIds.map((message) => message.messageId),
    evidence,
    optionLabels: ["Eldoron", "Myloria", "Cragnio"],
    criteria: ["transport capacity", "total cost", "weather reliability", "accessibility", "local community support"],
    status: "open",
  }];
  checked.evidenceRelations = [];

  const ids = chatWithIds.map((message) => message.messageId);
  const plan = compilePlan("synthesiser", checked, {
    score: 0.8,
    threshold: getRoleThreshold("synthesiser"),
    eligibleMessageIds: ids,
  });
  const activeParticipantNames = [...new Set(scenario.chat.map((message) => message.sender.name))];
  const planPreflight = preflightPlan(plan, {
    chat: scenario.chat,
    taskGeneralContext: generalInfo,
    activeParticipantNames,
    contextScope: "complete_current_round",
    interventionHistory: [],
  });
  if (planPreflight.status !== "passed") return { attempted: false, planPreflight };

  const prompt = llmSystemPrompts("adaptive", "synthesiser");
  if (prompt.blocked) return { attempted: false, code: "PROMPT_BLOCKED", error: prompt.reason };
  const dynamic = buildDynamicUserContext({
    chat: scenario.chat,
    checkpointDescriptor: `Synthetic evaluation checkpoint after ${scenario.chat.length} human messages; 8 minutes remain.`,
    selectedRoleForDisplay: prompt.metadata.generationRole,
    generalInfo,
    plan,
    planPreflight,
    activeParticipantNames,
    interventionHistory: [],
    contextScope: "complete_current_round",
  });
  const provider = await callLLM([
    { role: "system", content: prompt.content },
    { role: "user", content: dynamic.userContent },
  ], { stage: "generator_only", scenarioId: scenario.id });
  const parsed = provider.success ? parseGeneratorOutputStrict(provider.rawText) : { ok: false };
  const schema = parsed.ok ? validateAgainstGenerationSchema(parsed.parsed, prompt.metadata.generationRole) : { ok: false };
  const candidate = schema.ok ? normalizeGeneratorCandidate(parsed.parsed) : null;
  const deterministic = candidate ? runDeterministicValidation(candidate, {
    selectedRole: prompt.metadata.generationRole,
    eligibleMessageIds: dynamic.eligibleMessageIds,
    aiOrSystemMessageIds: dynamic.aiOrSystemMessageIds,
    recentAiMessageTexts: dynamic.recentAiMessageTexts,
    allowedGroundingIds: dynamic.allowedGroundingIds,
    maxWords: plan.maxWords,
    maxSentences: 3,
    maxSections: 2,
    enforcePlanGrounding: true,
    forbidInternalDisclosure: true,
    activeParticipantNames,
  }) : null;
  const message = candidate?.message || "";
  return {
    attempted: true,
    finishReason: provider.responseMetadata?.finish_reason ?? null,
    usage: provider.usage || null,
    estimatedCostUsd: provider.estimatedCostUsd ?? 0,
    latencyMs: provider.latencyMs ?? null,
    parsePassed: parsed.ok,
    schemaPassed: schema.ok,
    role: candidate?.role || null,
    groundingMessageIds: candidate?.groundingMessageIds || [],
    groundingPassed: deterministic ? !deterministic.failedCriteria.some((criterion) => criterion.includes("GROUNDING")) : false,
    wordCount: message.trim() ? message.trim().split(/\s+/).filter(Boolean).length : 0,
    sentenceCount: message.trim() ? [...new Intl.Segmenter("en", { granularity: "sentence" }).segment(message)].filter((entry) => entry.segment.trim()).length : 0,
    deterministicPassed: deterministic?.passed || false,
    deterministicFailures: deterministic?.failedCriteria || [],
    code: provider.code || null,
    error: provider.error || parsed.error || schema.error || null,
  };
}

function percentile(values, proportion) {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * proportion) - 1)];
}

function withoutInternalAssessorState(result) {
  const { factors: _factors, checked: _checked, ...safe } = result;
  return safe;
}

const assessorResults = [];
let fatalProviderFailure = false;
let validatorOnlyResult = null;
let generatorOnlyResult = null;
if (diagnosticTask === "generator_contract") {
  console.error("Diagnostic: INFORMATION_SYNTHESISER Generator length contract...");
  generatorOnlyResult = await runGeneratorOnlyDiagnostic();
  fatalProviderFailure = ["PROVIDER_HTTP_ERROR", "PROVIDER_TRANSPORT_ERROR", "LLM_REQUEST_TIMEOUT", "LIVE_REQUEST_LIMIT", "LIVE_COST_LIMIT"].includes(generatorOnlyResult.code);
} else if (diagnosticTask === "validator_contract") {
  console.error("Diagnostic: Specialist Validator contract...");
  validatorOnlyResult = await runValidatorOnlyDiagnostic();
  fatalProviderFailure = ["VALIDATOR_API_ERROR", "LIVE_REQUEST_LIMIT", "LIVE_COST_LIMIT"].includes(validatorOnlyResult.code);
} else if (diagnosticTask === "counterargument_ceiling") {
  console.error("Diagnostic ceiling: counterargument_handling...");
  const scenario = assessorScenarios.find((entry) => entry.id === "counterargument_handling");
  const result = await runAssessorScenario(scenario, "diagnostic");
  assessorResults.push(withoutInternalAssessorState(result));
  fatalProviderFailure = ["PROVIDER_HTTP_ERROR", "PROVIDER_TRANSPORT_ERROR", "LLM_REQUEST_TIMEOUT", "LIVE_REQUEST_LIMIT", "LIVE_COST_LIMIT"].includes(result.providerCode);
} else if (!diagnosticMode) {
  for (const scenario of assessorScenarios) {
    console.error(`Phase A assessor: ${scenario.id}...`);
    const result = await runAssessorScenario(scenario, "A");
    assessorResults.push(withoutInternalAssessorState(result));
    if (["PROVIDER_HTTP_ERROR", "PROVIDER_TRANSPORT_ERROR", "LLM_REQUEST_TIMEOUT", "LIVE_REQUEST_LIMIT", "LIVE_COST_LIMIT"].includes(result.providerCode)) {
      fatalProviderFailure = true;
      break;
    }
  }
}

const roleResults = [];
const selectedRoleScenarios = diagnosticTask === "synthesiser_clean"
  ? diagnosticScenarios.filter((scenario) => scenario.id === "clean_fragmented_evidence_synthesiser")
  : diagnosticMode ? diagnosticScenarios : roleScenarios;
if (!fatalProviderFailure && !["counterargument_ceiling", "validator_contract", "generator_contract"].includes(diagnosticTask) && (diagnosticMode || assessorResults.length === assessorScenarios.length)) {
  for (const scenario of selectedRoleScenarios) {
    console.error(`${diagnosticMode ? "Diagnostic" : "Phase B adaptive"}: ${scenario.id}...`);
    const result = await runScenario(scenario);
    roleResults.push(result);
    if (["LIVE_REQUEST_LIMIT", "LIVE_COST_LIMIT"].includes(result.code)) break;
  }
}

const completedLatencies = roleResults.filter((result) => Number.isFinite(result.elapsedMs));
const latencySummaryMs = Object.fromEntries(
  ["detector", "generator", "validator", "total"].map((stage) => {
    const values = completedLatencies
      .map((result) => stage === "total" ? result.elapsedMs : result.stageLatencyMs?.[stage])
      .filter(Number.isFinite);
    return [stage, {
      min: values.length ? Math.min(...values) : null,
      median: percentile(values, 0.5),
      p90: percentile(values, 0.9),
      max: values.length ? Math.max(...values) : null,
    }];
  }),
);

const summary = {
  mode: diagnosticTask || "full",
  model,
  endpoint,
  maxOutputTokens: Number.parseInt(process.env.LLM_MAX_OUTPUT_TOKENS || "1000", 10),
  stageModels: {
    detector: process.env.DETECTOR_MODEL || model,
    generator: process.env.GENERATOR_MODEL || model,
    validator: process.env.VALIDATOR_MODEL || model,
  },
  limits: { maxRequests: MAX_LIVE_REQUESTS, maxEstimatedCostUsd: MAX_ESTIMATED_COST_USD, timeoutMs: resolveLLMRequestTimeoutMs(process.env.LLM_REQUEST_TIMEOUT_MS) },
  pricing: { inputUsdPerMillionTokens: INPUT_USD_PER_MILLION, outputUsdPerMillionTokens: OUTPUT_USD_PER_MILLION },
  accounting: { ...accounting, estimatedCostUsd: Number(accounting.estimatedCostUsd.toFixed(6)) },
  generatorOnly: generatorOnlyResult,
  validatorOnly: validatorOnlyResult,
  phaseA: {
    attempted: assessorResults.length,
    schemaPassed: assessorResults.filter((result) => result.schemaPassed).length,
    singularMessageIdPassed: assessorResults.filter((result) => result.singularMessageIdContract).length,
    allEightFactorsPassed: assessorResults.filter((result) => result.allEightFactors).length,
    invalidEvidenceIdsAccepted: assessorResults.flatMap((result) => result.invalidAcceptedIds || []).length,
    failures: assessorResults.filter((result) => !result.passed).map((result) => ({ id: result.id, code: result.code, providerCode: result.providerCode, error: result.error })),
    results: assessorResults,
  },
  phaseB: {
    attempted: roleResults.length,
    passed: roleResults.filter((result) => result.passed).length,
    roleMatches: roleResults.filter((result) => result.roleMatched).length,
    abstentions: roleResults.filter((result) => result.abstention).length,
    results: roleResults,
  },
  latencySummaryMs,
  failureStages: roleResults.filter((result) => !result.passed).map((result) => ({
    id: result.id,
    stage: result.stage,
    error: result.error || null,
    chosenRole: result.chosenRole || null,
    roleMatched: result.roleMatched ?? null,
    schemaPassed: result.checks?.schema ?? null,
    deterministicPassed: result.checks?.deterministic ?? null,
    validatorAvailable: result.checks?.validatorAvailable ?? null,
    validatorPassed: result.checks?.validatorPassed ?? null,
    validatorFailures: result.checks?.validatorFailures || [],
  })),
};
process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
if (diagnosticTask === "generator_contract") {
  process.exitCode = fatalProviderFailure || !generatorOnlyResult?.parsePassed || !generatorOnlyResult?.schemaPassed || !generatorOnlyResult?.deterministicPassed ? 2 : 0;
} else if (diagnosticTask === "validator_contract") {
  process.exitCode = fatalProviderFailure || !validatorOnlyResult?.schemaPassed || !validatorOnlyResult?.semanticPassed ? 2 : 0;
} else if (diagnosticTask === "counterargument_ceiling") {
  const result = assessorResults[0];
  process.exitCode = fatalProviderFailure || !result?.schemaPassed || !result?.passed ? 2 : 0;
} else if (diagnosticMode) {
  const byId = Object.fromEntries(roleResults.map((result) => [result.id, result]));
  const schemaPassed = (id) => byId[id]?.assessor?.schemaPassed === true;
  const noNeedPassed = byId.clear_no_actionable_need?.gate?.decision === "abstain";
  const synthesiserPassed = byId.clean_fragmented_evidence_synthesiser?.chosenRole === "synthesiser"
    && byId.clean_fragmented_evidence_synthesiser?.passed === true;
  if (diagnosticTask === "synthesiser_clean") {
    process.exitCode = fatalProviderFailure || !synthesiserPassed ? 2 : 0;
  } else {
    process.exitCode = fatalProviderFailure
      || !schemaPassed("counterargument_handling")
      || !schemaPassed("ambiguous_insufficient")
      || !noNeedPassed
      || !synthesiserPassed ? 2 : 0;
  }
} else {
  process.exitCode = fatalProviderFailure || assessorResults.length !== 12 || summary.phaseA.schemaPassed !== 12 || summary.phaseA.singularMessageIdPassed !== 12 || summary.phaseA.invalidEvidenceIdsAccepted !== 0
    ? 2
    : roleResults.some((result) => result.stage === "detector" && result.code)
      ? 1
      : 0;
}
