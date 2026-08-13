// Probe what parameter disables reasoning on MiniMax-M3.
import dotenv from 'dotenv';
dotenv.config();

const endpoint = 'https://api.minimax.chat/v1/chat/completions';
const key = process.env.OPENAI_API_KEY;
const m = 'MiniMax-M3';
const sys = 'You are a careful classifier. '.repeat(40);

const tries = [
  { label: 'baseline (no flags)', payload: { model: m, messages: [{ role: 'system', content: sys }, { role: 'user', content: 'Count to 3 slowly.' }], max_tokens: 600 } },
  { label: 'reasoning_split: true', payload: { model: m, messages: [{ role: 'system', content: sys }, { role: 'user', content: 'Count to 3 slowly.' }], reasoning_split: true, max_completion_tokens: 4096 } },
  { label: 'reasoning: false', payload: { model: m, messages: [{ role: 'system', content: sys }, { role: 'user', content: 'Count to 3 slowly.' }], reasoning: false, max_tokens: 600 } },
  { label: 'enable_reasoning: false', payload: { model: m, messages: [{ role: 'system', content: sys }, { role: 'user', content: 'Count to 3 slowly.' }], enable_reasoning: false, max_tokens: 600 } },
  { label: 'disable_reasoning: true', payload: { model: m, messages: [{ role: 'system', content: sys }, { role: 'user', content: 'Count to 3 slowly.' }], disable_reasoning: true, max_tokens: 600 } },
  { label: 'reasoning_effort: none', payload: { model: m, messages: [{ role: 'system', content: sys }, { role: 'user', content: 'Count to 3 slowly.' }], reasoning_effort: 'none', max_tokens: 600 } },
  { label: 'reasoning_effort: 0', payload: { model: m, messages: [{ role: 'system', content: sys }, { role: 'user', content: 'Count to 3 slowly.' }], reasoning_effort: 0, max_tokens: 600 } },
  { label: 'reasoning_effort: minimal', payload: { model: m, messages: [{ role: 'system', content: sys }, { role: 'user', content: 'Count to 3 slowly.' }], reasoning_effort: 'minimal', max_tokens: 600 } },
  { label: 'reasoning_effort: low', payload: { model: m, messages: [{ role: 'system', content: sys }, { role: 'user', content: 'Count to 3 slowly.' }], reasoning_effort: 'low', max_tokens: 600 } },
];

for (const t of tries) {
  const t0 = Date.now();
  const r = await fetch(endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
    body: JSON.stringify(t.payload),
  });
  const j = await r.json();
  const ms = Date.now() - t0;
  const text = (j?.choices?.[0]?.message?.content || '').slice(0, 60);
  const finish = j?.choices?.[0]?.finish_reason;
  const usage = j?.usage || {};
  const hasThink = (j?.choices?.[0]?.message?.content || '').includes('<think>');
  console.log(`  [${t.label}]  ${ms}ms  finish=${finish}  prompt=${usage.prompt_tokens}  completion=${usage.completion_tokens}  reasoning=${usage.completion_tokens_details?.reasoning_tokens ?? 'n/a'}  has_think=${hasThink}  text=${JSON.stringify(text)}`);
}
