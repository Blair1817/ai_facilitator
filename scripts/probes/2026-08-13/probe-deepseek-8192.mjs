// Probe DeepSeek with bigger budget
import dotenv from 'dotenv';
dotenv.config();
process.argv[1] = process.cwd() + '/src/index.js';

const [{ buildChatCompletionPayload }] = await Promise.all([import('./src/LLMTransport.mjs')]);

const system = `Score 8 factors for a group-decision transcript: breadth_deficiency, group_preference, justification_deficiency, integration_deficiency, unresolved_counterevidence, claim_evidence_linkage, self_correction, reasoning_uptake. Each: status, strength, message_ids, span. Output one JSON only.`;
const chat = `[m0] [Alex]: Eldoron has a large rail station.
[m1] [Sam]: The Eldoron rail station sounds useful for arriving visitors.
[m2] [Blue]: I think we should keep discussing Eldoron's transport.
[m3] [Green]: Eldoron can probably move many people by train.
[m4] [Orange]: The station makes Eldoron look promising.
[m5] [Red]: So far Eldoron's transport is our main reason.`;

for (const maxTokens of [4096, 8192, 16384]) {
  const payload = buildChatCompletionPayload({
    model: 'deepseek-v4-flash',
    messages: [{ role: 'system', content: system }, { role: 'user', content: chat }],
    maxTokens,
  });
  const t0 = Date.now();
  const r = await fetch('https://api.deepseek.com/v1/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + process.env.OPENAI_API_KEY },
    body: JSON.stringify(payload),
  });
  const j = await r.json();
  const ms = Date.now() - t0;
  const text = j?.choices?.[0]?.message?.content || '';
  const usage = j?.usage || {};
  const finish = j?.choices?.[0]?.finish_reason;
  const isJson = text.trim().startsWith('{');
  console.log(`  maxTokens=${maxTokens}  payload_budget=${payload.max_tokens}  ${ms}ms  finish=${finish}  completion=${usage.completion_tokens}  reasoning=${usage.completion_tokens_details?.reasoning_tokens ?? 'n/a'}  text_chars=${text.length}  is_json=${isJson}  preview=${JSON.stringify(text.slice(0, 60))}`);
}
