// M3 on real detector prompt size: simulate a detector call.
import dotenv from 'dotenv';
dotenv.config();
const endpoint = 'https://api.minimax.chat/v1/chat/completions';
const key = process.env.OPENAI_API_KEY;

// Roughly the actual detector system prompt size.
const system = `You are the detector for a group-decision support system. Read the public discussion and score the semantic conditions below.
You do not write a participant-facing message and you do not select a facilitation role. Your 0–1 strength judgements are the only detector scores used by the Controller.
There are no lexical, embedding, participation, novelty, redundancy, agreement, or other hand-engineered features.

INPUT: TASK_GENERAL_CONTEXT (public task info), CUMULATIVE_PUBLIC_CONTEXT (all public messages with stable IDs), LOCAL_CONTEXT (last 6).

FACTORS (8 to score):
1. breadth_deficiency: a relevant option, criterion, or evidence area is missing or only mentioned in passing.
2. group_preference: at least two distinct participants lean toward the same option.
3. justification_deficiency: a stated preference lacks reasoning or evidence.
4. integration_deficiency: evidence is fragmented across messages and needs organising.
5. unresolved_counterevidence: a contradiction has been raised but not answered.
6. claim_evidence_linkage: claims/evidence are not explicitly connected.
7. self_correction: recent participants are already doing the work an intervention would request.
8. reasoning_uptake: participants take up another person's reasoning by evaluating or extending it.

SCORING RULES:
- present: assign strength 0–1 (0.1-0.3 weak, 0.4-0.6 moderate, 0.7-0.8 strong, 0.9-1.0 very strong and repeated).
- absent: strength must be 0.
- uncertain: strength must be 0.
- never use discussion length by itself as evidence of a deficiency.

For every present factor, copy one exact substring into span and provide its real message_ids.

OUTPUT: one JSON object matching assessor.schema.json with all 8 factor keys plus evidenceRelations. Each factor must contain exactly status, strength, message_ids, and span. Do not include markdown, explanations, or text outside the JSON object.
`;

// Realistic chat history (6 messages).
const chat = [
  '[m0] [Alex]: Eldoron has a large rail station, so transport should be easy.',
  '[m1] [Sam]: The Eldoron rail station sounds useful for arriving visitors.',
  '[m2] [Blue]: I think we should keep discussing Eldoron\'s transport.',
  '[m3] [Green]: Eldoron can probably move many people by train.',
  '[m4] [Orange]: The station makes Eldoron look promising.',
  '[m5] [Red]: So far Eldoron\'s transport is our main reason.',
].join('\n');

const tries = [
  { label: 'Text-01 (no flags)', payload: { model: 'MiniMax-Text-01', messages: [{ role: 'system', content: system }, { role: 'user', content: chat }], max_tokens: 1000 } },
  { label: 'M3 + reasoning_split + effort=low (current)', payload: { model: 'MiniMax-M3', messages: [{ role: 'system', content: system }, { role: 'user', content: chat }], reasoning_split: true, reasoning_effort: 'low', max_completion_tokens: 4096 } },
  { label: 'M3 + reasoning_split (no effort)', payload: { model: 'MiniMax-M3', messages: [{ role: 'system', content: system }, { role: 'user', content: chat }], reasoning_split: true, max_completion_tokens: 4096 } },
  { label: 'M3 no flags (raw)', payload: { model: 'MiniMax-M3', messages: [{ role: 'system', content: system }, { role: 'user', content: chat }], max_tokens: 1000 } },
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
    const isJson = text.trim().startsWith('{') || text.trim().startsWith('```');
    const isFenced = text.trim().startsWith('```');
    console.log(`  [${t.label}]  run ${i + 1}  ${ms}ms  finish=${finish}  prompt=${usage.prompt_tokens}  completion=${usage.completion_tokens}  reasoning=${usage.completion_tokens_details?.reasoning_tokens ?? 'n/a'}  has_think=${hasThink}  is_fenced=${isFenced}  text_preview=${JSON.stringify(text.slice(0, 100))}`);
  }
  console.log();
}
