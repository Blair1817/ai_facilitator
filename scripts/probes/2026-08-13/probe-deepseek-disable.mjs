// Probe DeepSeek with various "no thinking" attempts + sanity check.
import dotenv from 'dotenv';
dotenv.config();
const endpoint = 'https://api.deepseek.com/v1/chat/completions';
const key = process.env.OPENAI_API_KEY;

const system = `You are the detector for a group-decision support system. Read the public discussion and score the semantic conditions below. Score 8 factors: breadth_deficiency, group_preference, justification_deficiency, integration_deficiency, unresolved_counterevidence, claim_evidence_linkage, self_correction, reasoning_uptake. Each factor: status (present/absent/uncertain), strength (0-1), message_ids, span. OUTPUT one JSON object only.`;
const chat = [
  '[m0] [Alex]: Eldoron has a large rail station, so transport should be easy.',
  '[m1] [Sam]: The Eldoron rail station sounds useful for arriving visitors.',
  '[m2] [Blue]: I think we should keep discussing Eldoron\'s transport.',
  '[m3] [Green]: Eldoron can probably move many people by train.',
].join('\n');

const tries = [
  { label: 'reasoning_effort:low, max=4096', payload: { model: 'deepseek-v4-flash', messages: [{ role: 'system', content: system }, { role: 'user', content: chat }], reasoning_effort: 'low', max_tokens: 4096 } },
  { label: 'reasoning_effort:medium, max=4096', payload: { model: 'deepseek-v4-flash', messages: [{ role: 'system', content: system }, { role: 'user', content: chat }], reasoning_effort: 'medium', max_tokens: 4096 } },
  { label: 'no flags, max=4096 (control)', payload: { model: 'deepseek-v4-flash', messages: [{ role: 'system', content: system }, { role: 'user', content: chat }], max_tokens: 4096 } },
];

for (const t of tries) {
  for (let i = 0; i < 2; i++) {
    const t0 = Date.now();
    const r = await fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
      body: JSON.stringify(t.payload),
    });
    const j = await r.json();
    const ms = Date.now() - t0;
    const text = (j?.choices?.[0]?.message?.content || '');
    const finish = j?.choices?.[0]?.finish_reason;
    const usage = j?.usage || {};
    const hasThink = text.includes('<think>');
    const isFenced = text.trim().startsWith('```');
    console.log(`  [${t.label}]  run ${i + 1}  ${ms}ms  finish=${finish}  completion=${usage.completion_tokens}  reasoning=${usage.completion_tokens_details?.reasoning_tokens ?? 'n/a'}  has_think=${hasThink}  is_fenced=${isFenced}  preview=${JSON.stringify(text.slice(0, 80))}`);
  }
  console.log();
}
