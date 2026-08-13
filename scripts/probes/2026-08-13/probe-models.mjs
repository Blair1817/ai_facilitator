import dotenv from 'dotenv';
dotenv.config();
const endpoint = 'https://api.minimax.chat/v1/chat/completions';
const key = process.env.OPENAI_API_KEY;
const body = (model) => ({
  method: 'POST',
  headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
  body: JSON.stringify({
    model,
    messages: [{ role: 'user', content: 'Reply with the single word OK.' }],
    max_tokens: 16,
  }),
});
for (const m of ['MiniMax-Text-01', 'MiniMax-M3', 'MiniMax-M2.7-highspeed', 'MiniMax-M2']) {
  const t0 = Date.now();
  const r = await fetch(endpoint, body(m));
  const j = await r.json();
  const ms = Date.now() - t0;
  const text = j?.choices?.[0]?.message?.content || '(none)';
  const usage = j?.usage || {};
  const finish = j?.choices?.[0]?.finish_reason;
  console.log(`model=${m}  status=${r.status}  ms=${ms}  finish=${finish}  usage=${JSON.stringify(usage)}  text=${JSON.stringify(text)}`);
}
