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
if (!apiKey) throw new Error("OPENAI_API_KEY is missing from server/.env");

const [
  { assessSemanticFactors },
  { checkEvidence },
  { evaluateGate, chooseRole, getRoleThreshold },
  { compilePlan },
  { llmSystemPrompts },
  { buildDynamicUserContext, withMessageIds },
  { parseGeneratorOutputStrict, validateAgainstGenerationSchema, runDeterministicValidation },
  { validateCandidate },
  { buildChatCompletionPayload, buildSuccessfulLLMResult },
] = await Promise.all([
  import("./src/SemanticAssessor.js"),
  import("./src/EvidenceChecker.js"),
  import("./src/utils.js"),
  import("./src/PolicyCompiler.js"),
  import("./src/LLMConfig.js"),
  import("./src/prompts/DynamicContext.mjs"),
  import("./src/prompts/GeneratorContract.mjs"),
  import("./src/SemanticValidator.js"),
  import("./src/LLMTransport.mjs"),
]);

async function callLLM(messages, { modelOverride = model } = {}) {
  try {
    const response = await fetch(endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify(buildChatCompletionPayload({
        model: modelOverride,
        messages,
        maxTokens: process.env.LLM_MAX_OUTPUT_TOKENS || 4096,
      })),
    });
    const payload = await response.json();
    if (!response.ok) {
      return { success: false, error: payload?.error?.message || `HTTP ${response.status}` };
    }
    const rawText = payload?.choices?.[0]?.message?.content;
    if (typeof rawText !== "string" || rawText.length === 0) {
      return { success: false, error: "LLM response contained no message text" };
    }
    return buildSuccessfulLLMResult(rawText);
  } catch (error) {
    return { success: false, error: error.message };
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

const scenarios = [
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
];

async function runScenario(scenario) {
  const started = Date.now();
  const stageLatencyMs = {};
  const responseChars = {};
  const detectorStarted = Date.now();
  const detectorCall = async (messages) => {
    const detectorModel = process.env.DETECTOR_MODEL || model;
    const response = await callLLM(messages, {
      modelOverride: detectorModel,
    });
    responseChars.detector = response.rawText?.length || 0;
    return response;
  };
  const detector = await assessSemanticFactors({
    chat: scenario.chat,
    taskGeneralContext: generalInfo,
    callLLM: detectorCall,
  });
  stageLatencyMs.detector = Date.now() - detectorStarted;
  if (!detector.success) {
    return { id: scenario.id, expectedRole: scenario.expectedRole, stage: "detector", passed: false, error: detector.error, stageLatencyMs, responseChars, elapsedMs: Date.now() - started };
  }

  const checked = checkEvidence(detector.factors, { chat: scenario.chat });
  const gate = evaluateGate(checked, { remainingTime: 480_000, lastRole: null });
  const base = {
    id: scenario.id,
    purpose: scenario.purpose,
    expectedRole: scenario.expectedRole,
    rawFactors: detector.factors,
    checkedFactors: checked,
    gate: {
      decision: gate.decision,
      chosenRole: gate.chosenRole || null,
      scores: gate.scores,
      reason: gate.reason,
      perRole: gate.perRole,
    },
  };
  if (gate.decision !== "specialist") {
    return { ...base, stage: "classification", passed: false, elapsedMs: Date.now() - started };
  }

  const chosen = chooseRole(gate, { remainingTime: 480_000, lastRole: null, synthesiserFired: false });
  const ids = withMessageIds(scenario.chat).map((message) => message.messageId);
  const plan = compilePlan(chosen.role, checked, {
    score: gate.scores[chosen.role],
    threshold: getRoleThreshold(chosen.role),
    eligibleMessageIds: ids,
  });
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
  });
  const generatorStarted = Date.now();
  const generation = await callLLM([
    { role: "system", content: prompt.content },
    { role: "user", content: dynamic.userContent },
  ], {
    modelOverride: process.env.GENERATOR_MODEL || model,
  });
  stageLatencyMs.generator = Date.now() - generatorStarted;
  responseChars.generator = generation.rawText?.length || 0;
  if (!generation.success) {
    return { ...base, stage: "generator", passed: false, error: generation.error, plan };
  }
  const parsed = parseGeneratorOutputStrict(generation.rawText);
  if (!parsed.ok) {
    return { ...base, stage: "generator_parse", passed: false, rawGeneration: generation.rawText, error: parsed.error, plan };
  }
  const schema = validateAgainstGenerationSchema(parsed.parsed, prompt.metadata.generationRole);
  const deterministic = runDeterministicValidation(parsed.parsed, {
    selectedRole: prompt.metadata.generationRole,
    eligibleMessageIds: dynamic.eligibleMessageIds,
    aiOrSystemMessageIds: dynamic.aiOrSystemMessageIds,
    recentAiMessageTexts: dynamic.recentAiMessageTexts,
    allowedGroundingIds: dynamic.allowedGroundingIds,
  });
  let validatorRawText = null;
  const validatorCall = async (messages) => {
    const response = await callLLM(messages, {
      modelOverride: process.env.VALIDATOR_MODEL || model,
    });
    validatorRawText = response.rawText || null;
    responseChars.validator = response.rawText?.length || 0;
    return response;
  };
  const validatorStarted = Date.now();
  const validator = schema.ok && deterministic.passed
    ? await validateCandidate({
        chat: scenario.chat,
        candidate: parsed.parsed,
        selectedRole: prompt.metadata.generationRole,
        taskGeneralContext: generalInfo,
        callLLM: validatorCall,
      })
    : null;
  stageLatencyMs.validator = schema.ok && deterministic.passed ? Date.now() - validatorStarted : 0;

  const roleMatched = chosen.role === scenario.expectedRole;
  const outputPassed = schema.ok && deterministic.passed && validator?.success && validator.verdict.passed;
  return {
    ...base,
    stage: "complete",
    chosenRole: chosen.role,
    roleMatched,
    plan,
    candidate: process.env.REDACT_CONTENT === "1"
      ? {
          role: parsed.parsed.role,
          messageChars: parsed.parsed.message?.length || 0,
          groundingCount: parsed.parsed.groundingMessageIds?.length || 0,
        }
      : parsed.parsed,
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
    stageLatencyMs,
    responseChars,
    elapsedMs: Date.now() - started,
  };
}

const selectedIds = (process.env.SCENARIO_IDS || process.env.SCENARIO_ID || "")
  .split(",")
  .map((value) => value.trim())
  .filter(Boolean);
const selectedScenarios = selectedIds.length
  ? scenarios.filter((scenario) => selectedIds.includes(scenario.id))
  : scenarios;
const repeatCount = Math.max(1, Number.parseInt(process.env.REPEAT_COUNT || "1", 10));
const results = [];
for (let repetition = 1; repetition <= repeatCount; repetition += 1) {
  for (const scenario of selectedScenarios) {
    console.error(`Running ${scenario.id} (${repetition}/${repeatCount})...`);
    results.push({ repetition, ...(await runScenario(scenario)) });
  }
}

function percentile(values, proportion) {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * proportion) - 1)];
}

const completedLatencies = results.filter((result) => Number.isFinite(result.elapsedMs));
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
  model,
  stageModels: {
    detector: process.env.DETECTOR_MODEL || model,
    generator: process.env.GENERATOR_MODEL || model,
    validator: process.env.VALIDATOR_MODEL || model,
  },
  scenarioCount: results.length,
  uniqueScenarioCount: selectedScenarios.length,
  repeatCount,
  passed: results.filter((result) => result.passed).length,
  roleMatches: results.filter((result) => result.roleMatched).length,
  latencySummaryMs,
  failureStages: results.filter((result) => !result.passed).map((result) => ({
    id: result.id,
    repetition: result.repetition,
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
  results: process.env.SUMMARY_ONLY === "1" ? undefined : results,
};
process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
process.exitCode = summary.passed === summary.scenarioCount ? 0 : 1;
