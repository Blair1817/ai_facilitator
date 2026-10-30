import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { completeSynthesisPlan, checkSynthesisCoverage, synthesisOutputTokens } from "./SynthesisCoverage.mjs";
import { compilePlan } from "./PolicyCompiler.js";
import { preflightPlan } from "./PlanPreflight.mjs";
process.argv[1] = path.join(path.dirname(fileURLToPath(import.meta.url)), "fake-entry.js");
const { validateCandidate, VALIDATOR_CRITERIA } = await import("./SemanticValidator.js");
const chat = [
  { text: "A has a 12-minute shuttle and 600 seats.", sender: { id: "a", name: "Alex" } },
  { text: "A may have covered walkways in winter.", sender: { id: "b", name: "Blair" } },
  { text: "A's app cannot send alerts.", sender: { id: "c", name: "Casey" } },
  { text: "B has a bus stop nearby.", sender: { id: "a", name: "Alex" } },
  { text: "Hello!", sender: { id: "b", name: "Blair" } },
];
const ids = ["m0", "m1", "m2"];
const seed = compilePlan("synthesiser", { cognitiveTargets: [{ need: "fragmented_evidence", label: "A points need connecting", status: "open", messageIds: ids,
  evidence: ids.map((messageId, i) => ({ messageId, span: chat[i].text })), optionLabels: ["A"], criteria: [] }] }, { eligibleMessageIds: ids });
const plan = completeSynthesisPlan(seed, { chat, optionLabels: ["A", "B"] });
const candidate = { role: "INFORMATION_SYNTHESISER", message: "A: 12-minute shuttle; 600 seats; may have covered walkways in winter; app cannot send alerts. B: bus stop nearby. How do you weigh these points?", groundingMessageIds: ["m0", "m1", "m2", "m3"] };
const entry = (i, pairs) => ({ messageId: `m${i}`, status: "covered", reason: "All task facts represented", mappings: pairs.map(([sourceQuote, summaryQuote]) => ({ sourceQuote, summaryQuote })) });
const ledger = () => [
  entry(0, [["12-minute shuttle", "12-minute shuttle"], ["600 seats", "600 seats"]]),
  entry(1, [["may have covered walkways in winter", "may have covered walkways in winter"]]),
  entry(2, [["app cannot send alerts", "app cannot send alerts"]]),
  entry(3, [["bus stop nearby", "bus stop nearby"]]),
  { messageId: "m4", status: "no_task_information", reason: "Greeting only", mappings: [] },
];
const check = entries => checkSynthesisCoverage(entries, { chat, candidate, plan });

test("round synthesis expands beyond detector seed quotes, covers all options, and excludes AI/private data", () => {
  assert.deepEqual(plan.evidenceIds, ["m0", "m1", "m2", "m3", "m4"]);
  assert.deepEqual(plan.target.optionLabels, ["A", "B"]);
  assert.equal(plan.maxWords, null);
  const mixed = completeSynthesisPlan(seed, { chat: [...chat, { text: "AI text is not factual grounding", sender: { id: "ai" } }], optionLabels: ["A", "B"] });
  assert.deepEqual(mixed.evidenceIds, plan.evidenceIds);
  assert.equal(seed.target.optionLabels.length, 1, "seed remains unchanged");
  const partial = preflightPlan(plan, { chat, taskGeneralContext: "A B", contextScope: "partial_recent_window" });
  assert.ok(partial.failureReasons.includes("SCOPE_INSUFFICIENT"));
});

test("multi-fact sources preserve distinct facts, units, conditions, uncertainty and the other option", () => {
  assert.equal(check(ledger()).passed, true);
  assert.equal(ledger()[0].mappings.length, 2);
  const missing = ledger(); missing[0] = { ...missing[0], status: "missing", reason: "600 seats omitted" };
  assert.deepEqual(check(missing).missingIds, ["m0"]);
});

test("missing/duplicate ledger entries, fabricated quotes, omitted citations and round-scope exclusions fail closed", () => {
  for (const value of [undefined, [null], ledger().slice(1), [ledger()[0], ...ledger().slice(0, 4)]]) assert.equal(check(value).passed, false);
  for (const mutate of [
    x => x[0].mappings[0].sourceQuote = "invented source",
    x => x[0].mappings[0].summaryQuote = "invented summary",
    x => x[0].mappings = [],
    x => Object.assign(x[3], { status: "out_of_scope", reason: "Selected seed did not mention B", mappings: [] }),
  ]) { const x = ledger(); mutate(x); assert.equal(check(x).passed, false); }
  assert.equal(checkSynthesisCoverage(ledger(), { chat, candidate: { ...candidate, groundingMessageIds: ["m0", "m1", "m2"] }, plan }).passed, false);
});

test("focused discrepancy can exclude unrelated messages without dropping either disputed report", () => {
  const focused = { ...seed, requiredReasoningAct: "DISCREPANCY_REPRESENTATION" };
  const p = completeSynthesisPlan(focused, { chat, optionLabels: ["A", "B"] });
  assert.equal(p.synthesisCoverage.scope, "complete_target_discrepancy");
  assert.deepEqual(p.target.optionLabels, ["A"]);
});

test("output budget scales with public input and does not use private/AI text", () => {
  assert.ok(synthesisOutputTokens(chat) >= 8192);
  const large = [{ text: "a".repeat(30000), sender: { name: "Alex" } }];
  assert.ok(synthesisOutputTokens(large) > synthesisOutputTokens(chat));
  assert.equal(synthesisOutputTokens([...chat, { text: "a".repeat(30000), sender: { id: "ai" } }]), synthesisOutputTokens(chat));
});

const validatorArgs = { chat, candidate, selectedRole: "INFORMATION_SYNTHESISER", interventionPlan: plan,
  taskGeneralContext: "Available alternatives: A, B.", activeParticipantNames: ["Alex", "Blair", "Casey"] };
validatorArgs.planPreflight = preflightPlan(plan, validatorArgs);
const flags = () => Object.fromEntries(VALIDATOR_CRITERIA.map(k => [k, false]));

test("semantic Validator requires a full quote-backed ledger even when all thirteen flags claim success", async () => {
  for (const coverage of [undefined, ledger().slice(0, 3)]) {
    const result = await validateCandidate({ ...validatorArgs, callLLM: async () => ({ success: true, rawText: JSON.stringify({ ...flags(), ...(coverage ? { synthesisCoverage: coverage } : {}) }) }) });
    assert.equal(result.success, true);
    assert.equal(result.verdict.passed, false);
    assert.ok(result.verdict.failedCriteria.some(c => c.startsWith("SYNTHESIS_COVERAGE_INCOMPLETE")));
  }
});

test("complete audit passes; same-message factual omission flagged by auditor fails; truncated audit never passes", async () => {
  const missing = ledger(); missing[0].status = "missing"; missing[0].reason = "Only shuttle represented; seats omitted";
  for (const [coverage, passed] of [[ledger(), true], [missing, false]]) {
    const result = await validateCandidate({ ...validatorArgs, callLLM: async (messages, options) => {
      assert.ok(options.responseSchema.schema.required.includes("synthesisCoverage"));
      assert.match(messages[0].content, /ALL distinct task/);
      return { success: true, rawText: JSON.stringify({ ...flags(), synthesisCoverage: coverage }) };
    } });
    assert.equal(result.verdict.passed, passed);
  }
  const truncated = await validateCandidate({ ...validatorArgs, callLLM: async () => ({ success: true,
    rawText: JSON.stringify({ ...flags(), synthesisCoverage: ledger() }), responseMetadata: { finish_reason: "length" } }) });
  assert.equal(truncated.success, false);
  assert.equal(truncated.code, "VALIDATOR_TRUNCATED");
});
