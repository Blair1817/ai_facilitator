import { strictParseJsonObject } from "./prompts/GeneratorContract.mjs";

export const MINIMAX_REASONING_COMPLETION_FLOOR = 4096;

export function isMiniMaxReasoningModel(model) {
  return typeof model === "string" && /^MiniMax-M2(?:$|[.\-])/i.test(model.trim());
}

/**
 * MiniMax M2 models spend completion tokens on hidden/returned reasoning before
 * producing the final answer. The legacy max_tokens caps used for Text-01 can
 * therefore truncate the JSON answer entirely. Use MiniMax's documented
 * reasoning envelope and completion-token field for M2, while preserving the
 * legacy request shape for non-reasoning models.
 */
export function buildChatCompletionPayload({
  model,
  messages,
  maxTokens,
  reasoningCompletionFloor = MINIMAX_REASONING_COMPLETION_FLOOR,
}) {
  const parsedMax = Number.parseInt(maxTokens, 10);
  const safeMax = Number.isFinite(parsedMax) && parsedMax > 0 ? parsedMax : 1000;
  if (isMiniMaxReasoningModel(model)) {
    return {
      model,
      messages,
      reasoning_split: true,
      max_completion_tokens: Math.max(safeMax, reasoningCompletionFloor),
    };
  }
  return { model, messages, max_tokens: safeMax };
}

function stripLeadingMiniMaxThinking(rawText) {
  const trimmed = rawText.trim();
  if (!trimmed.startsWith("<think>")) return rawText;
  const closingIndex = trimmed.indexOf("</think>");
  if (closingIndex === -1) return rawText;
  return trimmed.slice(closingIndex + "</think>".length).trimStart();
}

/**
 * Preserve provider text for the schema-specific downstream parser. Some
 * OpenAI-compatible providers wrap otherwise valid JSON in one Markdown code
 * fence. That envelope is not a transport failure and must not be rejected
 * before Generator/Assessor/Validator parsing and schema validation run.
 */
export function buildSuccessfulLLMResult(rawText) {
  if (typeof rawText !== "string" || rawText.length === 0) {
    return { success: false, error: "LLM response missing message content" };
  }
  // `reasoning_split` should keep thinking out of `content`. This exact,
  // anchored fallback protects strict downstream JSON parsing if a compatible
  // gateway ignores that extension; arbitrary prose is deliberately retained
  // and rejected by the schema-owning parser as before.
  const finalText = stripLeadingMiniMaxThinking(rawText);
  if (finalText.length === 0) {
    return { success: false, error: "LLM response contained reasoning but no final message content" };
  }
  const bestEffort = strictParseJsonObject(finalText);
  return {
    success: true,
    data: bestEffort.ok ? bestEffort.parsed : null,
    rawText: finalText,
    providerEnvelopeNormalized: finalText !== rawText,
  };
}
