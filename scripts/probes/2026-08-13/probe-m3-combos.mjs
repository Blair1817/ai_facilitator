// Probe M3 combos: reasoning_split + reasoning_effort to minimize reasoning.
import dotenv from 'dotenv';
dotenv.config();
const endpoint = 'https://api.minimax.chat/v1/chat/completions';
const key = process.env.OPENAI_API_KEY;
const m = 'MiniMax-M3';
const sys = 'You are a careful classifier. '.repeat(40);
const tries = [
  { label: 'reasoning_split + effort=low', payload: { model: m, messages: [{ role: 'system', content: sys }, { role: 'user', content: 'Count to 3 slowly.' }], reasoning_split: true, reasoning_effort: 'low', max_completion_tokens: 4096 } },
  { label: 'reasoning_split + effort=minimal', payload: { model: m, messages: [{ role: 'system', content: sys }, { role: 'user', content: 'Count to 3 slowly.' }], reasoning_split: true, reasoning_effort: 'minimal', max_completion_tokens: 4096 } },
  { label: 'reasoning_split + effort=none', payload: { model: m, messages: [{ role: 'system', content: sys }, { role: 'user', content: 'Count to 3 slowly.' }], reasoning_split: true, reasoning_effort: 'none', max_completion_tokens: 4096 } },
  { label: 'reasoning_split only (no effort)', payload: { model: m, messages: [{ role: 'system', content: sys }, { role: 'user', content: 'Count to 3 slowly.' }], reasoning_split: true, max_completion_tokens: 4096 } },
];
for (const t of tries) {
  // 3 runs each for stability
  const times = [];
  let lastText = '';
  let lastUsage = {};
  let hasThink = false;
  for (let i = 0; i < 3; i++) {
    const t0 = Date.now();
    const r = await fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
      body: JSON.stringify(t.payload),
    });
    const j = await r.json();
    times.push(Date.now() - t0);
    lastText = (j?.choices?.[0]?.message?.content || '');
    lastUsage = j?.usage || {};
    hasThink = lastText.includes('<think>');
  }
  const sorted = [...times].sort((a, b) => a - b);
  console.log(`[${t.label}]  min=${sorted[0]}  med=${sorted[1]}  max=${sorted[2]}  completion=${lastUsage.completion_tokens}  reasoning=${lastUsage.completion_tokens_details?.reasoning_tokens ?? 'n/a'}  has_think=${hasThink}  text=${JSON.stringify(lastText.slice(0, 60))}`);
}
