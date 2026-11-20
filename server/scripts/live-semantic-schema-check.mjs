// Live check of the per-checkpoint strict detector schema (2026-11-20).
// Replays one logged Adaptive checkpoint from an exported bundle against the
// real OpenAI Chat Completions endpoint and reports whether the provider
// accepts the schema, whether every candidate compares every reference, and
// the detector latency. Read-only: nothing is written to any game.
//
//   OPENAI_API_KEY=... node scripts/live-semantic-schema-check.mjs \
//     <llm-audit.jsonl> <auditRequestId substring> [runs=3]
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const server = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
process.argv[1] = path.join(server, "src", "fake-entry.js"); // prompt runtime resolves from the entry dir
const [file, match] = [process.argv[2], process.argv[3]];
const runs = Number(process.argv[4] || 3);
if (!file || !match) { console.error("usage: node scripts/live-semantic-schema-check.mjs <llm-audit.jsonl> <auditRequestId substring> [runs]"); process.exit(2); }
if (!process.env.OPENAI_API_KEY) { console.error("OPENAI_API_KEY is not set"); process.exit(2); }
const model = process.env.OPENAI_MODEL || "gpt-5.6-luna";
const endpoint = process.env.LLM_API_ENDPOINT || "https://api.openai.com/v1/chat/completions";

const { assessSemanticFactors, semanticCoverageErrors } = await import("../src/SemanticAssessor.js");
const { semanticReferences, verifySemanticTarget } = await import("../src/AdaptiveEvidence.mjs");
const { buildChatCompletionPayload, buildSuccessfulLLMResult, isOfficialOpenAIChatEndpoint } = await import("../src/LLMTransport.mjs");
const { buildStaticSharedTaskOverview } = await import("../src/prompts/StaticContext.mjs");

const entries = fs.readFileSync(file, "utf8").split("\n").filter(Boolean).map(l => JSON.parse(l)).map(e => e.entry ?? e);
const target = entries.find(e => String(e.auditRequestId ?? e.id).includes(match));
if (!target?.agentState) { console.error(`no entry with agentState matching ${match}`); process.exit(2); }
const state = target.agentState;
const chat = state.cumulativeContext;
const roundPrefix = String(target.auditRequestId).split(":").slice(0, 2).join(":") + ":";
const targetTs = Number(String(target.auditRequestId).split(":")[3]);

// Rebuild cognitiveInterventionHistory from the plans published earlier in this round.
const history = entries
  .filter(e => String(e.auditRequestId).startsWith(roundPrefix) && e.outcome === "PUBLISHED" && e.plan?.planId)
  .filter(e => Number(e.auditCompletedAt ?? e.timestamp) < targetTs)
  .map(e => {
    const publishedAt = Number(e.auditCompletedAt ?? e.timestamp);
    return { planId: e.plan.planId, role: e.selectedRole, target: e.plan.target, evidence: e.plan.evidence,
      semanticKey: e.plan.semanticReview?.key ?? e.plan.target?.label,
      publicMessageBoundary: chat.filter(m => Number(m.timestamp ?? m.ts) < publishedAt).length };
  });
const references = semanticReferences(history, []);
const optionLabels = Object.keys(target.optionMentionCounts || {});
const taskGeneralContext = buildStaticSharedTaskOverview({ generalInfo: state.generalInfo, decisionOptions: optionLabels.map(label => ({ label })) });

console.log(`model=${model} endpoint=${endpoint} strictSchema=${isOfficialOpenAIChatEndpoint(endpoint)}`);
console.log(`checkpoint=${target.auditRequestId} chat=${chat.length} references=${JSON.stringify(references.map(r => r.id))}`);

let failures = 0;
for (let run = 1; run <= runs; run++) {
  const calls = [];
  const callLLM = async (messages, options) => {
    const start = Date.now();
    const data = buildChatCompletionPayload({ model, messages, maxTokens: 4096, endpoint, responseSchema: options?.responseSchema, reasoningEffort: "low" });
    const res = await fetch(endpoint, { method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${process.env.OPENAI_API_KEY}` }, body: JSON.stringify(data) });
    const body = await res.json().catch(() => ({}));
    calls.push({ ms: Date.now() - start, status: res.status, repair: !!options?.structureRepair });
    if (!res.ok) return { success: false, error: `HTTP ${res.status}: ${body?.error?.message ?? "unknown"}` };
    const text = body?.choices?.[0]?.message?.content;
    return text ? buildSuccessfulLLMResult(text) : { success: false, error: `no content (finish_reason=${body?.choices?.[0]?.finish_reason})` };
  };
  const result = await assessSemanticFactors({
    chat, taskGeneralContext, callLLM, interventionHistory: history,
    activeParticipantNames: Object.keys(target.participationCounts || {}),
    participationCounts: target.participationCounts, quietParticipants: target.quietParticipants || [],
    optionMentionCounts: target.optionMentionCounts, scheduling: { remainingTimeMs: target.remainingTime, triggerSource: "message", closeoutOpportunity: false, evaluateEarlyCloseout: true },
    allowStructureRepair: true,
  });
  const line = [`run ${run}: calls=${calls.length} ${calls.map(c => `${c.ms}ms/HTTP${c.status}${c.repair ? "/repair" : ""}`).join(", ")}`];
  if (!result.success) { failures++; console.log(`${line} FAILED ${result.code}: ${result.error}`); continue; }
  const coverage = semanticCoverageErrors(result.factors, references);
  if (coverage.length) failures++;
  line.push(`coverageErrors=${coverage.length}`);
  for (const [name, c] of Object.entries(result.factors.candidates || {})) {
    if (!c) { line.push(`${name}=null`); continue; }
    const v = verifySemanticTarget(c.semanticReview, { chat, references });
    line.push(`${name}=${v.ok ? "ok" : v.reason}[${(c.semanticReview?.matches || []).length}/${references.length}]`);
  }
  console.log(line.join(" "));
}
console.log(failures ? `${failures}/${runs} runs failed or incomplete` : `all ${runs} runs complete`);
process.exit(failures ? 1 : 0);
