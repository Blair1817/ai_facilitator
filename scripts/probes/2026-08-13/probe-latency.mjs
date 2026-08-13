// Realistic latency probe: simulates a detector-size call (~4-6K input tokens,
// 600 output tokens) and measures wall time for each model.
import dotenv from 'dotenv';
dotenv.config();

const endpoint = 'https://api.minimax.chat/v1/chat/completions';
const key = process.env.OPENAI_API_KEY;

// ~5K-token fake system prompt: this matches the rough size of the detector
// prompt in our pipeline (system + small chat).
const bigSystem = 'You are a careful classifier. '.repeat(80);
const bigSystemFinal = bigSystem + '\n' + 'Additional context: '.repeat(200);

const models = ['MiniMax-Text-01', 'MiniMax-M3', 'MiniMax-M2.7-highspeed', 'MiniMax-M2'];
const outTokens = 600;

for (const m of models) {
  // Try the request that LLMTransport would build for each model.
  const useReasoningEnvelope = /^MiniMax-M2(?:$|[.\-])/i.test(m);
  const payload = useReasoningEnvelope
    ? { model: m, messages: [{ role: 'system', content: bigSystemFinal }, { role: 'user', content: 'Count to 3 slowly.' }], reasoning_split: true, max_completion_tokens: 4096 }
    : { model: m, messages: [{ role: 'system', content: bigSystemFinal }, { role: 'user', content: 'Count to 3 slowly.' }], max_tokens: outTokens };

  // Run 3 times for a stable median.
  const times = [];
  for (let i = 0; i < 3; i++) {
    const t0 = Date.now();
    const r = await fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
      body: JSON.stringify(payload),
    });
    const j = await r.json();
    times.push(Date.now() - t0);
    const text = (j?.choices?.[0]?.message?.content || '').slice(0, 100);
    const finish = j?.choices?.[0]?.finish_reason;
    const usage = j?.usage || {};
    console.log(`  ${m} run ${i + 1}: ${Date.now() - t0}ms  finish=${finish}  prompt=${usage.prompt_tokens}  completion=${usage.completion_tokens}  reasoning=${usage.completion_tokens_details?.reasoning_tokens ?? 'n/a'}  text=${JSON.stringify(text)}`);
  }
  const sorted = [...times].sort((a, b) => a - b);
  console.log(`${m}  min=${sorted[0]}  median=${sorted[1]}  max=${sorted[2]}ms\n`);
}
