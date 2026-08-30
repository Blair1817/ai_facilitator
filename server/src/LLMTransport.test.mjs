import assert from "node:assert/strict";
import test from "node:test";
import {
  buildChatCompletionPayload,
  buildSuccessfulLLMResult,
  isMiniMaxReasoningModel,
} from "./LLMTransport.mjs";

test("request policy uses split reasoning and a sufficient completion budget for MiniMax M2", () => {
  assert.equal(isMiniMaxReasoningModel("MiniMax-M2.7-highspeed"), true);
  const payload = buildChatCompletionPayload({
    model: "MiniMax-M2.7-highspeed",
    messages: [{ role: "user", content: "test" }],
    maxTokens: 500,
  });
  assert.equal(payload.reasoning_split, true);
  assert.equal(payload.max_completion_tokens, 4096);
  assert.equal("max_tokens" in payload, false);
});

test("request policy preserves the legacy request shape for non-reasoning models", () => {
  const payload = buildChatCompletionPayload({ model: "MiniMax-Text-01", messages: [], maxTokens: 500 });
  assert.equal(payload.max_tokens, 500);
  assert.equal("reasoning_split" in payload, false);
  assert.equal("max_completion_tokens" in payload, false);
});

for (const model of ["gpt-5.6-luna", "gpt-5.6-sol", "gpt-5.6-terra"]) {
  test(`request policy uses max_completion_tokens for ${model}`, () => {
    const payload = buildChatCompletionPayload({ model, messages: [], maxTokens: 500 });
    assert.equal(payload.max_completion_tokens, 500);
    assert.equal("max_tokens" in payload, false);
    assert.equal("reasoning_split" in payload, false);
  });
}

test("request policy still uses max_tokens for a legacy OpenAI model", () => {
  const payload = buildChatCompletionPayload({ model: "gpt-4o", messages: [], maxTokens: 500 });
  assert.equal(payload.max_tokens, 500);
  assert.equal("max_completion_tokens" in payload, false);
});

test("transport preserves plain JSON for downstream validation", () => {
  const rawText = JSON.stringify({ role: "GENERALIST", message: "What criteria should the group compare?", groundingMessageIds: [] });
  const result = buildSuccessfulLLMResult(rawText);
  assert.equal(result.success, true);
  assert.equal(result.rawText, rawText);
  assert.equal(result.data.role, "GENERALIST");
});

test("transport does not reject a provider fenced-JSON envelope", () => {
  const rawText = "```json\n" + JSON.stringify({ role: "GENERALIST", message: "What criteria should the group compare?", groundingMessageIds: [] }) + "\n```";
  const result = buildSuccessfulLLMResult(rawText);
  assert.equal(result.success, true);
  assert.equal(result.rawText, rawText);
  assert.equal(result.data.role, "GENERALIST");
});

test("transport preserves non-JSON text so the owning parser can report the failure", () => {
  const result = buildSuccessfulLLMResult("provider explanation only");
  assert.equal(result.success, true);
  assert.equal(result.data, null);
  assert.equal(result.rawText, "provider explanation only");
});

test("transport removes only an exact leading MiniMax think envelope", () => {
  const json = JSON.stringify({ role: "GENERALIST", message: "What criteria should the group compare?", groundingMessageIds: [] });
  const result = buildSuccessfulLLMResult(`<think>private reasoning</think>\n${json}`);
  assert.equal(result.success, true);
  assert.equal(result.rawText, json);
  assert.equal(result.providerEnvelopeNormalized, true);
});

test("transport rejects a reasoning-only response", () => {
  const result = buildSuccessfulLLMResult("<think>unfinished final answer</think>");
  assert.equal(result.success, false);
});

test("transport rejects genuinely missing content", () => {
  assert.equal(buildSuccessfulLLMResult("").success, false);
  assert.equal(buildSuccessfulLLMResult(null).success, false);
});
