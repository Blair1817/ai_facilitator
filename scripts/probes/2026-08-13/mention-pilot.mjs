#!/usr/bin/env node

// mention-pilot.mjs
//
// 2026-08-13: focused pilot for the new `@[Name]` participant-mention
// capability. Runs a real LLM over 5 targeted scenarios and reports:
//   - LLM-generated `message` content (so you can read whether @ usage
//     matches what you'd write as a normal group member)
//   - Intervention strategy (which role the Controller chose, whether
//     it matches what the scenario is designed to elicit)
//   - Latency per stage (detector / generator / validator / total)
//
// Designed to be human-skim-friendly: prints a one-line summary per
// scenario, then a content section, then a latency section. No CI
// assertions -- this is a pilot, not a test.
//
// Usage: node mention-pilot.mjs
//   SCENARIO_IDS=expander_broad_silence node mention-pilot.mjs   # one
//   REPEAT_COUNT=3 node mention-pilot.mjs                        # each 3x
//
// No network mock. No LLM cache. Every run hits the real provider.

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
if (!apiKey) {
  console.error("OPENAI_API_KEY is missing from server/.env");
  process.exit(1);
}

const [
  { assessSemanticFactors },
  { checkEvidence },
  { evaluateGate, chooseRole, getRoleThreshold },
  { compilePlan },
  { llmSystemPrompts },
  { buildDynamicUserContext, withMessageIds, formatActiveParticipantNames },
  { buildStaticUserContext },
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
  import("./src/prompts/StaticContext.mjs"),
  import("./src/prompts/GeneratorContract.mjs"),
  import("./src/SemanticValidator.js"),
  import("./src/LLMTransport.mjs"),
]);

async function callLLM(messages, { modelOverride = model } = {}) {
  const t0 = Date.now();
  try {
    const response = await fetch(endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify(buildChatCompletionPayload({
        model: modelOverride,
        messages,
        maxTokens: process.env.LLM_MAX_OUTPUT_TOKENS || 1000,
      })),
    });
    const payload = await response.json();
    const latencyMs = Date.now() - t0;
    if (!response.ok) {
      return { success: false, error: payload?.error?.message || `HTTP ${response.status}`, latencyMs };
    }
    const rawText = payload?.choices?.[0]?.message?.content;
    if (typeof rawText !== "string" || rawText.length === 0) {
      return { success: false, error: "LLM response contained no message text", latencyMs };
    }
    return { ...buildSuccessfulLLMResult(rawText), latencyMs };
  } catch (error) {
    return { success: false, error: error.message, latencyMs: Date.now() - t0 };
  }
}

function makeChat(lines) {
  return lines.map(([name, text], index) => ({
    text,
    ts: 1_000 + index * 1_000,
    sender: { id: `human-${name.toLowerCase()}`, name },
  }));
}

// Participant roster: the live game's player list, used to populate
// [ACTIVE_PARTICIPANT_NAMES] in the dynamic context (callbacks.js
// passes this in production). Order here is the order participants
// appear in the chat (so the first two names are the only ones who
// have spoken in some scenarios).
const ROSTER_FIVE = ["Alex", "Sam", "Pat", "Jordan", "Kai"]; // 5-person
const ROSTER_THREE = ["Alex", "Sam", "Pat"];                 // 3-person

const generalInfo = [
  "A committee must choose one of three host cities: Eldoron, Myloria, or Cragnio.",
  "The public decision criteria are transport capacity, total cost, weather reliability, accessibility, and local community support.",
  "The group's goal is to use and compare all publicly shared information before deciding; no city is declared correct in advance.",
].join(" ");

// 5 scenarios. Each names which Adaptive role the scenario is designed
// to elicit (the Controller's choice is reported separately so the
// reader can see whether it actually picked that role), and what
// @-mention behaviour the scenario is probing.
//
// `expectedRole` is the role the test design expects the Controller
// to pick. `preferredMentionMode` is the "as a normal group member"
// behaviour the scenario wants the Generator to land on, used for
// qualitative review (the script does not assert it).
const scenarios = [
  {
    id: "expander_broad_silence",
    expectedRole: "expander",
    preferredMentionMode: "multi-@ nudge naming every silent participant",
    purpose: "5-person group, only 1 person (Alex) has spoken — broad participation imbalance, Expander should @ everyone else or use a group-level nudge.",
    roster: ROSTER_FIVE,
    chat: makeChat([
      ["Alex", "Eldoron has a large rail station, so transport should be easy."],
      ["Alex", "The Eldoron station is the main thing I have to share."],
      ["Alex", "Anyone else got info from your report?"],
    ]),
  },
  {
    id: "expander_single_silent",
    expectedRole: "expander",
    preferredMentionMode: "single @[Name] for the one clearly-silent person, OR a group-level invitation",
    purpose: "5-person group, 4 have spoken, only Kai is silent. Expander should invite Kai (or use a group invitation) — NOT a roll call.",
    roster: ROSTER_FIVE,
    chat: makeChat([
      ["Alex", "Eldoron has a large rail station."],
      ["Sam", "Myloria has low cost but a small venue."],
      ["Pat", "Cragnio has reliable weather for the event."],
      ["Jordan", "Myloria's accessibility support is strong."],
      ["Alex", "I think we should keep discussing the criteria more."],
      ["Sam", "Cost is a real issue for our budget."],
    ]),
  },
  {
    id: "synthesiser_two_source_comparison",
    expectedRole: "synthesiser",
    preferredMentionMode: "@[Name] for both sources of the two-sided comparison (Sam and Pat)",
    purpose: "Two participants gave opposite numbers for delivery time. Synthesiser should compare the two and may @ both sources.",
    roster: ROSTER_THREE,
    chat: makeChat([
      ["Alex", "I am not sure which option has the better delivery time."],
      ["Sam", "For delivery time, my report says Option A is 12 days."],
      ["Pat", "My report gives Option B as 18 days."],
      ["Alex", "So Option A is faster than Option B on this number."],
      ["Sam", "Yes, but cost was the other issue."],
      ["Pat", "And accessibility also matters for our attendees."],
    ]),
  },
  {
    id: "challenger_single_source_preference",
    expectedRole: "challenger",
    preferredMentionMode: "@[Name] for the participant whose grounded claim is the target of the clarification",
    purpose: "One person (Sam) states a preference for Option B with a reason; nobody else has supplied a supporting task fact. Challenger may @ Sam.",
    roster: ROSTER_THREE,
    chat: makeChat([
      ["Alex", "We have shared most of our information now."],
      ["Sam", "I think Option B is the best — the cost is more reasonable."],
      ["Pat", "I am not sure I agree but I have no strong feeling."],
      ["Alex", "We have not really compared B with A on cost yet."],
      ["Sam", "I would go with B for that reason."],
      ["Pat", "I can live with B too."],
    ]),
  },
  {
    id: "control_no_mention_needed",
    expectedRole: "generalist",
    preferredMentionMode: "no @ at all (group-level invitation, or pure facilitator prompt)",
    purpose: "3-person group with a healthy discussion. A Generalist prompt is expected; no @ needed.",
    roster: ROSTER_THREE,
    chat: makeChat([
      ["Alex", "I like Option A based on the transport capacity."],
      ["Sam", "I prefer Option B because of the cost."],
      ["Pat", "I am still undecided between A and B."],
      ["Alex", "What does the group think about comparing cost vs transport?"],
      ["Sam", "Both criteria are important but I lean toward cost."],
      ["Pat", "Could we quickly list the pros and cons we have so far?"],
    ]),
  },
];

function countMentions(text) {
  const matches = text.match(/@\[([^\[\]]+)\]/g) || [];
  return matches.map((m) => m.slice(2, -1));
}

async function runScenario(scenario) {
  const started = Date.now();
  const stageLatencyMs = {};

  // 1. Detector
  const detectorStarted = Date.now();
  const detectorCall = async (messages) => callLLM(messages, { modelOverride: process.env.DETECTOR_MODEL || model });
  const detector = await assessSemanticFactors({
    chat: scenario.chat,
    taskGeneralContext: generalInfo,
    callLLM: detectorCall,
  });
  stageLatencyMs.detector = Date.now() - detectorStarted;
  if (!detector.success) {
    return { id: scenario.id, stage: "detector", passed: false, error: detector.error, stageLatencyMs, elapsedMs: Date.now() - started };
  }

  // 2. Evidence check + Gate
  const checked = checkEvidence(detector.factors, { chat: scenario.chat });
  const gate = evaluateGate(checked, { remainingTime: 480_000, lastRole: null });

  // 3. If the Gate abstains, we still want a Generator call so the
  // pilot can show what the Generalist would have said (the live
  // pipeline would publish nothing on ABSTAIN, but for pilot
  // content-quality inspection a Generalist call is the most useful
  // thing to look at).
  let chosenRole = null;
  let plan = null;
  let useGeneralistFallback = false;
  if (gate.decision === "specialist") {
    const chosen = chooseRole(gate, { remainingTime: 480_000, lastRole: null, synthesiserFired: false });
    chosenRole = chosen.role;
    const ids = withMessageIds(scenario.chat).map((m) => m.messageId);
    plan = compilePlan(chosen.role, checked, {
      score: gate.scores[chosen.role],
      threshold: getRoleThreshold(chosen.role),
      eligibleMessageIds: ids,
    });
  } else {
    useGeneralistFallback = true;
    chosenRole = "generalist";
  }

  // 4. Prompt
  const prompt = llmSystemPrompts("adaptive", chosenRole);
  if (prompt.blocked) {
    return { id: scenario.id, stage: "prompt", passed: false, error: prompt.reason, stageLatencyMs, elapsedMs: Date.now() - started };
  }

  // 5. Build dynamic user content (with activeParticipantNames = roster)
  let dynamicUserContent;
  let eligibleMessageIds;
  let aiOrSystemMessageIds;
  let recentAiMessageTexts;
  let allowedGroundingIds;
  if (useGeneralistFallback) {
    // Generalist path: no plan, same dynamic context but no TARGET / REQUIRED_REASONING_ACT / etc.
    const dynamic = buildDynamicUserContext({
      chat: scenario.chat,
      checkpointDescriptor: `Pilot checkpoint after ${scenario.chat.length} human messages; 8 minutes remain.`,
      selectedRoleForDisplay: prompt.metadata.generationRole,
      generalInfo,
      activeParticipantNames: scenario.roster,
    });
    dynamicUserContent = dynamic.userContent;
    eligibleMessageIds = dynamic.eligibleMessageIds;
    aiOrSystemMessageIds = dynamic.aiOrSystemMessageIds;
    recentAiMessageTexts = dynamic.recentAiMessageTexts;
    allowedGroundingIds = dynamic.allowedGroundingIds;
  } else {
    const dynamic = buildDynamicUserContext({
      chat: scenario.chat,
      checkpointDescriptor: `Pilot checkpoint after ${scenario.chat.length} human messages; 8 minutes remain.`,
      selectedRoleForDisplay: prompt.metadata.generationRole,
      generalInfo,
      plan,
      activeParticipantNames: scenario.roster,
    });
    dynamicUserContent = dynamic.userContent;
    eligibleMessageIds = dynamic.eligibleMessageIds;
    aiOrSystemMessageIds = dynamic.aiOrSystemMessageIds;
    recentAiMessageTexts = dynamic.recentAiMessageTexts;
    allowedGroundingIds = dynamic.allowedGroundingIds;
  }

  // 6. Generator
  const generatorStarted = Date.now();
  const generation = await callLLM([
    { role: "system", content: prompt.content },
    { role: "user", content: dynamicUserContent },
  ], { modelOverride: process.env.GENERATOR_MODEL || model });
  stageLatencyMs.generator = Date.now() - generatorStarted;
  if (!generation.success) {
    return { id: scenario.id, stage: "generator", passed: false, error: generation.error, stageLatencyMs, elapsedMs: Date.now() - started };
  }

  // 7. Parse + schema + deterministic
  const parsed = parseGeneratorOutputStrict(generation.rawText);
  if (!parsed.ok) {
    return { id: scenario.id, stage: "generator_parse", passed: false, rawGeneration: generation.rawText, error: parsed.error, stageLatencyMs, elapsedMs: Date.now() - started };
  }
  const schema = validateAgainstGenerationSchema(parsed.parsed, prompt.metadata.generationRole);
  const deterministic = runDeterministicValidation(parsed.parsed, {
    selectedRole: prompt.metadata.generationRole,
    eligibleMessageIds,
    aiOrSystemMessageIds,
    recentAiMessageTexts,
    allowedGroundingIds,
    activeParticipantNames: scenario.roster,
  });

  // 8. Validator LLM
  let validatorRawText = null;
  const validatorCall = async (messages) => {
    const r = await callLLM(messages, { modelOverride: process.env.VALIDATOR_MODEL || model });
    validatorRawText = r.rawText || null;
    return r;
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

  const roleMatched = !useGeneralistFallback && chosenRole === scenario.expectedRole;
  const outputPassed = schema.ok && deterministic.passed && validator?.success && validator.verdict.passed;
  const finalMessage = parsed.parsed.message || "";
  const mentions = countMentions(finalMessage);

  return {
    id: scenario.id,
    stage: "complete",
    purpose: scenario.purpose,
    expectedRole: scenario.expectedRole,
    chosenRole,
    roleMatched,
    preferredMentionMode: scenario.preferredMentionMode,
    useGeneralistFallback,
    gateDecision: gate.decision,
    gateReason: gate.reason,
    topScores: gate.scores ? Object.fromEntries(Object.entries(gate.scores).map(([k, v]) => [k, Number(v?.toFixed?.(2) ?? v)])) : null,
    candidate: {
      role: parsed.parsed.role,
      message: finalMessage,
      messageLengthChars: finalMessage.length,
      groundingMessageIds: parsed.parsed.groundingMessageIds || [],
      mentionsFound: mentions,
    },
    checks: {
      schema: schema.ok,
      deterministic: deterministic.passed,
      deterministicFailures: deterministic.failedCriteria || [],
      validatorAvailable: validator?.success || false,
      validatorPassed: validator?.success ? validator.verdict.passed : false,
      validatorFailures: validator?.success ? validator.verdict.failedCriteria : [validator?.error || "validator unavailable"],
    },
    passed: roleMatched && outputPassed,
    stageLatencyMs,
    rawGeneration: generation.rawText,
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
    process.stderr.write(`Running ${scenario.id} (${repetition}/${repeatCount})...\n`);
    const t = Date.now();
    const r = await runScenario(scenario);
    r.repetition = repetition;
    r.wallMs = Date.now() - t;
    results.push(r);
  }
}

// ── print report ─────────────────────────────────────────────────────

const cyan = (s) => `\x1b[36m${s}\x1b[0m`;
const green = (s) => `\x1b[32m${s}\x1b[0m`;
const red = (s) => `\x1b[31m${s}\x1b[0m`;
const yellow = (s) => `\x1b[33m${s}\x1b[0m`;
const bold = (s) => `\x1b[1m${s}\x1b[0m`;
const dim = (s) => `\x1b[2m${s}\x1b[0m`;
const useColor = process.stdout.isTTY;
const C = useColor ? { cyan, green, red, yellow, bold, dim } : Object.fromEntries(["cyan", "green", "red", "yellow", "bold", "dim"].map((k) => [k, (s) => s]));

console.log(C.bold("\n════════════════════════════════════════════════════════════════════"));
console.log(C.bold("  @[Name] mention pilot — content quality, intervention strategy, latency"));
console.log(C.bold("════════════════════════════════════════════════════════════════════"));
console.log(C.dim(`model=${model}  detector=${process.env.DETECTOR_MODEL || model}  generator=${process.env.GENERATOR_MODEL || model}  validator=${process.env.VALIDATOR_MODEL || model}`));
console.log(C.dim(`${results.length} run(s) across ${selectedScenarios.length} scenario(s), ${repeatCount} repetition(s) each.`));

// ── per-scenario content + strategy ───────────────────────────────────

for (const r of results) {
  const headColor = r.passed ? C.green : (r.roleMatched ? C.yellow : C.red);
  const symbol = r.passed ? "✓" : (r.roleMatched ? "~" : "✗");
  console.log(C.bold(`\n── ${symbol} ${r.id}  (rep ${r.repetition})`));
  console.log(`   ${C.dim("purpose:")}  ${r.purpose}`);
  console.log(`   ${C.dim("expect:")}   role=${r.expectedRole}  mention=${C.cyan(r.preferredMentionMode)}`);
  console.log(`   ${C.dim("got:")}      role=${headColor(r.chosenRole)}  gate=${r.gateDecision}${r.gateReason ? ` (${r.gateReason})` : ""}${r.useGeneralistFallback ? C.dim("  [fallback: gate abstained]") : ""}`);
  if (r.topScores) {
    console.log(`   ${C.dim("scores:")}   ${Object.entries(r.topScores).map(([k, v]) => `${k}=${v}`).join("  ")}`);
  }
  if (r.candidate) {
    const msg = r.candidate.message.replace(/\n/g, " ");
    console.log(`   ${C.dim("message:")}  ${msg}`);
    console.log(`   ${C.dim("         ")}  ${C.dim(`(${r.candidate.messageLengthChars} chars, grounding=[${r.candidate.groundingMessageIds.join(",")}])`)}`);
    if (r.candidate.mentionsFound.length) {
      console.log(`   ${C.cyan("@-tags:")}   ${r.candidate.mentionsFound.map((m) => `@[${m}]`).join("  ")}  ${C.dim(`(${r.candidate.mentionsFound.length} mention${r.candidate.mentionsFound.length === 1 ? "" : "s"})`)}`);
    } else {
      console.log(`   ${C.cyan("@-tags:")}   ${C.dim("(none)")}`);
    }
  }
  const c = r.checks || {};
  const checkLine = [
    `schema=${c.schema ? C.green("✓") : C.red("✗")}`,
    `deterministic=${c.deterministic ? C.green("✓") : C.red("✗" + (c.deterministicFailures?.length ? " " + c.deterministicFailures.join(",") : ""))}`,
    `validator=${c.validatorAvailable ? (c.validatorPassed ? C.green("✓") : C.red("✗" + (c.validatorFailures?.length ? " " + c.validatorFailures.join(",") : ""))) : C.dim("n/a")}`,
  ].join("  ");
  console.log(`   ${C.dim("checks:")}   ${checkLine}`);
}

// ── latency summary ───────────────────────────────────────────────────

function percentile(values, proportion) {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * proportion) - 1));
  return sorted[idx];
}

const completedLatencies = results.filter((r) => Number.isFinite(r.elapsedMs));
const stages = ["detector", "generator", "validator", "total"];

console.log(C.bold("\n── Latency (ms, over all completed runs)"));
console.log("   " + "stage".padEnd(11) + "min".padStart(8) + "p50".padStart(8) + "p90".padStart(8) + "max".padStart(8) + "  n");
for (const stage of stages) {
  const values = completedLatencies
    .map((r) => stage === "total" ? r.elapsedMs : r.stageLatencyMs?.[stage])
    .filter(Number.isFinite);
  if (values.length === 0) {
    console.log("   " + stage.padEnd(11) + C.dim("(no completed runs)"));
    continue;
  }
  const min = Math.min(...values);
  const p50 = percentile(values, 0.5);
  const p90 = percentile(values, 0.9);
  const max = Math.max(...values);
  const fmt = (n) => String(n).padStart(8);
  console.log("   " + stage.padEnd(11) + fmt(min) + fmt(p50) + fmt(p90) + fmt(max) + "  " + values.length);
}

// ── per-stage wall time (detector / generator / validator / total) ──

const totalWallMs = results.reduce((sum, r) => sum + (r.wallMs || 0), 0);
console.log(C.dim(`\n   total wall across all ${results.length} run(s): ${(totalWallMs / 1000).toFixed(1)}s`));

// ── JSON dump for the machine ─────────────────────────────────────────

const outPath = process.env.PILOT_OUT || path.join(serverDir, ".mention-pilot-out.json");
fs.writeFileSync(outPath, JSON.stringify({ model, results }, null, 2));
console.log(C.dim(`\n   full JSON written to ${outPath}`));
