import { strictParseJsonObject } from "./prompts/GeneratorContract.mjs";

export const MINIMAX_REASONING_COMPLETION_FLOOR = 4096;
export const DEFAULT_LLM_REQUEST_TIMEOUT_MS = 90_000;

export function resolveLLMRequestTimeoutMs(value) {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_LLM_REQUEST_TIMEOUT_MS;
}

export class LLMRequestTimeoutError extends Error {
  constructor(timeoutMs) {
    super(`LLM request timed out after ${timeoutMs}ms`);
    this.name = "LLMRequestTimeoutError";
    this.code = "LLM_REQUEST_TIMEOUT";
    this.timeoutMs = timeoutMs;
  }
}

/**
 * Bound the complete provider operation, including response-body parsing.
 * Aborting the supplied signal stops a compliant fetch implementation; the
 * Promise race still enforces the deadline if a provider or test double
 * ignores AbortSignal.
 */
export async function withLLMRequestTimeout(operation, timeoutMs = DEFAULT_LLM_REQUEST_TIMEOUT_MS, parentSignal) {
  const effectiveTimeoutMs = resolveLLMRequestTimeoutMs(timeoutMs);
  const controller = new AbortController();
  let timer;
  let abortParent;
  const cancelled = new Promise((_, reject) => {
    abortParent = () => { controller.abort(); reject(new LLMRequestTimeoutError(0)); };
    if (parentSignal?.aborted) abortParent();
    else parentSignal?.addEventListener("abort", abortParent, { once: true });
  });
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(new LLMRequestTimeoutError(effectiveTimeoutMs));
    }, effectiveTimeoutMs);
  });
  try {
    return await Promise.race([Promise.resolve().then(() => {
      if (controller.signal.aborted) throw new LLMRequestTimeoutError(0);
      return operation(controller.signal);
    }), timeout, cancelled]);
  } finally {
    clearTimeout(timer);
    parentSignal?.removeEventListener("abort", abortParent);
  }
}

export function isMiniMaxReasoningModel(model) {
  return typeof model === "string" && /^MiniMax-M2(?:$|[.\-])/i.test(model.trim());
}

function isOpenAIGpt56Model(model) {
  return typeof model === "string" && /^gpt-5\.6(?:$|[.\-])/i.test(model.trim());
}

export function isOfficialOpenAIChatEndpoint(endpoint) {
  try {
    const url = new URL(endpoint);
    return url.origin === "https://api.openai.com" && url.pathname === "/v1/chat/completions";
  } catch { return false; }
}

/**
 * MiniMax M2 models spend completion tokens on hidden/returned reasoning before
 * producing the final answer. The legacy max_tokens caps used for Text-01 can
 * therefore truncate the JSON answer entirely. Use MiniMax's documented
 * reasoning envelope and completion-token field for M2, while preserving the
 * legacy request shape for models that still accept max_tokens. OpenAI GPT-5.6
 * Chat Completions models use max_completion_tokens and explicitly disable
 * reasoning, without MiniMax's reasoning_split extension or reasoning floor.
 */
export function buildChatCompletionPayload({
  model,
  messages,
  maxTokens,
  reasoningCompletionFloor = MINIMAX_REASONING_COMPLETION_FLOOR,
  endpoint = null,
  responseSchema = null,
  reasoningEffort = null,
}) {
  const parsedMax = Number.parseInt(maxTokens, 10);
  const safeMax = Number.isFinite(parsedMax) && parsedMax > 0 ? parsedMax : 1000;
  let payload;
  if (isMiniMaxReasoningModel(model)) {
    payload = {
      model,
      messages,
      reasoning_split: true,
      max_completion_tokens: Math.max(safeMax, reasoningCompletionFloor),
    };
  } else if (isOpenAIGpt56Model(model)) {
    payload = {
      model,
      messages,
      reasoning_effort: "none",
      max_completion_tokens: safeMax,
    };
  } else {
    payload = { model, messages, max_tokens: safeMax };
  }
  // Opt in only for the official API. Compatible gateways (including the
  // study's MiniMax deployment) do not necessarily support strict schemas.
  if (endpoint && (responseSchema || reasoningEffort)) {
    if (isOfficialOpenAIChatEndpoint(endpoint)) {
      if (responseSchema) {
        payload.response_format = {
          type: "json_schema",
          json_schema: { name: responseSchema.name, schema: responseSchema.schema, strict: true },
        };
      }
      if (isOpenAIGpt56Model(model) && reasoningEffort) {
        if (!["none", "low", "medium", "high", "xhigh", "max"].includes(reasoningEffort)) throw new Error("Unsupported GPT-5.6 reasoning effort");
        payload.reasoning_effort = reasoningEffort;
        // Completion budgets include hidden reasoning, not only visible JSON.
        if (reasoningEffort !== "none") payload.max_completion_tokens = Math.max(safeMax, 4096);
      }
    }
  }
  return payload;
}

function finiteNumberOrNull(value) {
  return Number.isFinite(value) ? value : null;
}

/**
 * Extract the small, non-sensitive subset of a Chat Completions response used
 * for operational diagnosis and token accounting. The raw provider response
 * is deliberately not retained.
 */
export function extractChatCompletionResponseMetadata(responseBody) {
  const usage = responseBody?.usage;
  return {
    finish_reason: typeof responseBody?.choices?.[0]?.finish_reason === "string"
      ? responseBody.choices[0].finish_reason
      : null,
    usage: {
      prompt_tokens: finiteNumberOrNull(usage?.prompt_tokens),
      completion_tokens: finiteNumberOrNull(usage?.completion_tokens),
      total_tokens: finiteNumberOrNull(usage?.total_tokens),
      reasoning_tokens: finiteNumberOrNull(usage?.completion_tokens_details?.reasoning_tokens),
    },
  };
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
export function buildSuccessfulLLMResult(rawText, responseMetadata = null) {
  if (typeof rawText !== "string" || rawText.length === 0) {
    return { success: false, error: "LLM response missing message content", responseMetadata };
  }
  // `reasoning_split` should keep thinking out of `content`. This exact,
  // anchored fallback protects strict downstream JSON parsing if a compatible
  // gateway ignores that extension; arbitrary prose is deliberately retained
  // and rejected by the schema-owning parser as before.
  const finalText = stripLeadingMiniMaxThinking(rawText);
  if (finalText.length === 0) {
    return { success: false, error: "LLM response contained reasoning but no final message content", responseMetadata };
  }
  const bestEffort = strictParseJsonObject(finalText);
  return {
    success: true,
    data: bestEffort.ok ? bestEffort.parsed : null,
    rawText: finalText,
    providerEnvelopeNormalized: finalText !== rawText,
    responseMetadata,
  };
}
