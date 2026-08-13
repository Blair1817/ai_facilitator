// Opt-in live regression for the participant-requested facilitator path.
// Uses one synthetic public message and never prints model or task content.

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const dirname = path.dirname(fileURLToPath(import.meta.url));
process.argv[1] = path.join(dirname, "dist", "index.js");

const envText = fs.readFileSync(path.join(dirname, ".env"), "utf8");
function envValue(name) {
  const match = envText.match(new RegExp(`^${name}=(.*)$`, "m"));
  return match?.[1]?.trim().replace(/^['"]|['"]$/g, "") || "";
}

const apiKey = envValue("OPENAI_API_KEY");
const configuredEndpoint = envValue("LLM_API_ENDPOINT") || "https://api.minimax.chat/v1";
const endpoint = configuredEndpoint.endsWith("/chat/completions")
  ? configuredEndpoint
  : `${configuredEndpoint.replace(/\/$/, "")}/chat/completions`;
const model = envValue("OPENAI_MODEL") || "MiniMax-Text-01";
assert.ok(apiKey, "OPENAI_API_KEY is required for the opt-in live smoke test");

const { getRequestedGeneralistPromptBundle } = await import("./src/prompts/promptLoader.js");
const { buildDynamicUserContext } = await import("./src/prompts/DynamicContext.mjs");
const { buildStaticSharedTaskOverview } = await import("./src/prompts/StaticContext.mjs");
const {
  parseGeneratorOutputStrict,
  validateAgainstGenerationSchema,
  runDeterministicValidation,
} = await import("./src/prompts/GeneratorContract.mjs");
const { validateCandidate } = await import("./src/SemanticValidator.js");
const { buildChatCompletionPayload, buildSuccessfulLLMResult } = await import("./src/LLMTransport.mjs");

async function callLLM(messages) {
  const response = await fetch(endpoint, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify(buildChatCompletionPayload({ model, messages, maxTokens: 500 })),
  });
  const body = await response.json();
  if (!response.ok) {
    return { success: false, error: body?.error?.message || `HTTP ${response.status}` };
  }
  return buildSuccessfulLLMResult(body?.choices?.[0]?.message?.content);
}

const config = JSON.parse(fs.readFileSync(path.join(dirname, "src", "HPTConfig.json"), "utf8"));
const task = config.tasks[0];
const publicTaskOverview = buildStaticSharedTaskOverview({
  generalInfo: task.generalInfo,
  decisionOptions: task.decisionOptions,
});
for (const privateProfile of task.playerConfig || []) {
  const privateText = typeof privateProfile === "string" ? privateProfile : JSON.stringify(privateProfile);
  assert.equal(publicTaskOverview.includes(privateText), false, "private profile leaked into shared overview");
}

const chat = [{
  content: "@[Facilitator] what are the criteria",
  timestamp: Date.now(),
  messageType: "human",
  speakerType: "human",
  sender: { id: "synthetic-p1", name: "Green" },
}];
const bundle = getRequestedGeneralistPromptBundle();
assert.equal(bundle.blocked, false, bundle.reason);
const context = buildDynamicUserContext({
  chat,
  checkpointDescriptor: "Participant-requested response during the active Discussion stage.",
  selectedRoleForDisplay: bundle.metadata.generationRole,
  generalInfo: publicTaskOverview,
  plan: null,
});

const generation = await callLLM([
  { role: "system", content: bundle.content },
  { role: "user", content: context.userContent },
]);
assert.equal(generation.success, true, generation.error);
const parsed = parseGeneratorOutputStrict(generation.rawText);
assert.equal(parsed.ok, true, parsed.error);
const schema = validateAgainstGenerationSchema(parsed.parsed, bundle.metadata.generationRole);
assert.equal(schema.ok, true, JSON.stringify(schema.errors));
const deterministic = runDeterministicValidation(parsed.parsed, {
  selectedRole: bundle.metadata.generationRole,
  eligibleMessageIds: context.eligibleMessageIds,
  aiOrSystemMessageIds: context.aiOrSystemMessageIds,
  recentAiMessageTexts: context.recentAiMessageTexts,
  allowedGroundingIds: context.allowedGroundingIds,
});
assert.equal(deterministic.passed, true, deterministic.failedCriteria.join(", "));

const validator = await validateCandidate({
  chat,
  candidate: parsed.parsed,
  selectedRole: bundle.metadata.generationRole,
  taskGeneralContext: publicTaskOverview,
  callLLM,
});
assert.equal(validator.success, true, `${validator.code}: ${validator.error}`);
assert.equal(validator.verdict.passed, true, validator.verdict.failedCriteria.join(", "));

console.log(JSON.stringify({
  liveRequestedFacilitator: "passed",
  providerEnvelopeWasFenced: generation.rawText.trimStart().startsWith("```"),
  generatorSchemaValid: schema.ok,
  deterministicValidationPassed: deterministic.passed,
  semanticValidatorPassed: validator.verdict.passed,
  privateTaskMaterialIncluded: false,
}));
