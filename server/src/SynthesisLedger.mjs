import { withMessageIds, formatMessagesWithIds } from "./prompts/DynamicContext.mjs";
import { isPublicParticipantMessage } from "./CognitiveOperations.mjs";
import { readRuntimeFile } from "./prompts/PromptRuntime.mjs";
import { strictParseJsonObject } from "./prompts/GeneratorContract.mjs";

/** 2026-11-14: Synthesiser by construction.
 *
 * The earlier Synthesiser asked one model call to write a complete scoreboard
 * and a second to prove nothing was missing; any omission discarded the whole
 * message. Here every public participant message gets exactly one ledger
 * entry, code verifies that, and any entry that is missing, malformed or not
 * independently confirmed is replaced by the participant's own words. The
 * rendered scoreboard therefore accounts for every message and can always be
 * produced: a model failure degrades wording, never coverage or delivery. */

export const GENERAL_OPTION = "General";
export const OTHER_POINTS_TITLE = "Other points";
export const LEDGER_SUMMARY = "Shared points so far";
export const FALLBACK_QUESTION = "How do you weigh these points together?";
export const MAX_POINT_WORDS = 60;
export const MAX_QUESTION_WORDS = 25;
export const MIN_SYNTHESIS_ITEMS = 2;
export const LEDGER_ROUNDS = 2;
export const LEDGER_CALL_TIMEOUT_MS = 35_000;
// Only when the model could not be reached at all: a very short message that
// names no option ("agree", "ok", "??") is not quoted.
const UNAVAILABLE_REASONS = ["no_model", "time_budget", "extraction_unavailable", "audit_unavailable"];
const SHORT_MESSAGE_WORDS = 4;

const words = text => String(text ?? "").trim().split(/\s+/).filter(Boolean);
const loose = text => String(text ?? "").toLowerCase().replace(/[‘’]/g, "'").replace(/[“”]/g, '"').replace(/\s+/g, " ").trim();
const escapeRegExp = text => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

export function ledgerSources(chat) {
  return withMessageIds(chat).filter(isPublicParticipantMessage)
    .filter(m => typeof m.text === "string" && m.text.trim())
    .map((m, order) => ({ messageId: m.messageId, text: m.text, name: m.sender?.name ?? "", order }));
}

/** Option named in the message itself (full label or its first word). */
function mentionedOptions(text, optionLabels) {
  return optionLabels.filter(label => [label, label.split(/\s+/)[0]].some(form => form.length > 2
    && new RegExp(`(^|[^\\p{L}\\p{N}])${escapeRegExp(form)}([^\\p{L}\\p{N}]|$)`, "iu").test(text)));
}

function verbatimEntry(source, optionLabels, hintOption, fallbackReason) {
  const mentioned = mentionedOptions(source.text, optionLabels);
  const option = mentioned.length === 1 ? mentioned[0]
    : optionLabels.includes(hintOption) && !mentioned.length ? hintOption : GENERAL_OPTION;
  return { messageId: source.messageId, status: "verbatim", fallbackReason,
    points: [{ option, text: `“${source.text.trim()}”`, verbatim: true }] };
}

export function extractionSchema(ids, optionLabels) {
  return { type: "object", additionalProperties: false, required: ["entries", "question"], properties: {
    entries: { type: "array", items: { type: "object", additionalProperties: false,
      required: ["messageId", "status", "points", "sameAs", "reason"], properties: {
        messageId: { type: "string", enum: ids },
        status: { type: "string", enum: ["points", "repeats", "no_task_information"] },
        points: { type: "array", items: { type: "object", additionalProperties: false, required: ["option", "text", "quote"], properties: {
          option: { type: "string", enum: [...optionLabels, GENERAL_OPTION] }, text: { type: "string" }, quote: { type: "string" } } } },
        sameAs: { type: ["string", "null"] },
        reason: { type: "string" } } } },
    question: { type: "string" } } };
}
export function auditSchema(ids) {
  return { type: "object", additionalProperties: false, required: ["verdicts", "questionOk"], properties: {
    verdicts: { type: "array", items: { type: "object", additionalProperties: false, required: ["messageId", "verdict"], properties: {
      messageId: { type: "string", enum: ids },
      verdict: { type: "string", enum: ["ok", "incomplete", "unfaithful", "wrongly_excluded"] } } } },
    questionOk: { type: "boolean" } } };
}

/** Structural checks only code can guarantee. Returns a clean entry or null. */
export function checkProposedEntry(raw, source, { optionLabels, earlierIds }) {
  if (!raw || typeof raw !== "object" || raw.messageId !== source.messageId) return null;
  if (raw.status === "no_task_information") return Array.isArray(raw.points) && raw.points.length === 0
    ? { messageId: source.messageId, status: "no_task_information", points: [], reason: String(raw.reason ?? "") } : null;
  if (raw.status === "repeats") return typeof raw.sameAs === "string" && earlierIds.includes(raw.sameAs) && Array.isArray(raw.points) && raw.points.length === 0
    ? { messageId: source.messageId, status: "repeats", sameAs: raw.sameAs, points: [], reason: String(raw.reason ?? "") } : null;
  if (raw.status !== "points" || !Array.isArray(raw.points) || !raw.points.length) return null;
  const sourceLoose = loose(source.text);
  const points = [];
  for (const point of raw.points) {
    const text = typeof point?.text === "string" ? point.text.trim() : "";
    const count = words(text).length;
    if (!text || count > MAX_POINT_WORDS || text.includes("@") || /[\n\r]/.test(text)) return null;
    if (![...optionLabels, GENERAL_OPTION].includes(point.option)) return null;
    if (typeof point.quote !== "string" || !loose(point.quote) || !sourceLoose.includes(loose(point.quote))) return null;
    points.push({ option: point.option, text, quote: point.quote });
  }
  return { messageId: source.messageId, status: "points", points, reason: String(raw.reason ?? "") };
}

export function checkQuestion(question) {
  const text = typeof question === "string" ? question.trim() : "";
  return text && words(text).length <= MAX_QUESTION_WORDS && (text.match(/\?/g) || []).length === 1 && text.endsWith("?")
    && !text.includes("@") && !/[\n\r]/.test(text) ? text : null;
}

async function callJson(callLLM, kind, system, user, schemaName, schema) {
  let response;
  try {
    response = await callLLM([{ role: "system", content: system }, { role: "user", content: user }],
      { reasoningEffort: "low", responseSchema: { name: schemaName, schema } }, kind);
  } catch (error) { return { ok: false, error: String(error?.message || error) }; }
  if (!response?.success) return { ok: false, error: String(response?.error ?? "no response") };
  const parsed = strictParseJsonObject(response.rawText);
  return parsed.ok ? { ok: true, value: parsed.parsed } : { ok: false, error: parsed.error };
}

/**
 * Build the complete ledger for the round.
 * @param cache previously confirmed entries: { [messageId]: { text, entry } }
 * @param callLLM async (messages, options, kind) => { success, rawText | error }
 * Never throws for model failures; always returns an entry for every source.
 */
export async function buildSynthesisLedger({ chat, optionLabels = [], taskGeneralContext = "", cache = {}, callLLM, canContinue = () => true }) {
  const sources = ledgerSources(chat);
  const order = sources.map(s => s.messageId);
  const entries = {}, nextCache = {}, diagnostics = { calls: [], fallbacks: [] };
  for (const source of sources) {
    const hit = cache?.[source.messageId];
    if (hit?.text === source.text && hit.entry?.messageId === source.messageId && ["points", "repeats", "no_task_information"].includes(hit.entry.status)) {
      entries[source.messageId] = hit.entry;
      nextCache[source.messageId] = hit;
    }
  }
  const targets = sources.filter(s => !entries[s.messageId]);
  let question = null;
  const fallback = (source, reason, hint) => {
    if (UNAVAILABLE_REASONS.includes(reason) && words(source.text).length < SHORT_MESSAGE_WORDS && !mentionedOptions(source.text, optionLabels).length) {
      entries[source.messageId] = { messageId: source.messageId, status: "no_task_information", points: [], reason: "short_message_model_unavailable", fallbackReason: reason };
      diagnostics.fallbacks.push({ messageId: source.messageId, reason, excludedAsShort: true });
      return;
    }
    entries[source.messageId] = verbatimEntry(source, optionLabels, hint, reason);
    diagnostics.fallbacks.push({ messageId: source.messageId, reason });
  };

  const context = `[TASK_GENERAL_CONTEXT]\n${taskGeneralContext || "(not provided)"}\n\n[OPTIONS]\n${JSON.stringify(optionLabels)}\n\n[PUBLIC_TRANSCRIPT]\n${formatMessagesWithIds(sources.map(s => ({ messageId: s.messageId, text: s.text, sender: { name: s.name } })))}`;
  // Round 1 covers every uncached message; round 2 retries only the entries
  // that failed, with the reason. Whatever still fails is quoted verbatim.
  let pending = targets;
  const failure = new Map();   // messageId -> { reason, hint }
  for (let round = 1; round <= LEDGER_ROUNDS && pending.length; round++) {
    if (typeof callLLM !== "function") { for (const s of pending) failure.set(s.messageId, { reason: "no_model" }); break; }
    if (!canContinue()) { for (const s of pending) if (!failure.has(s.messageId)) failure.set(s.messageId, { reason: "time_budget" }); break; }
    const ids = pending.map(s => s.messageId);
    const feedback = round > 1 ? `\n\n[PREVIOUS_ATTEMPT_PROBLEMS]\n${JSON.stringify(Object.fromEntries(ids.map(id => [id, failure.get(id)?.reason ?? "unknown"])))}\nCorrect these entries: include all task information in the message, say only what it says, keep qualifiers, and copy quotes exactly.` : "";
    const extracted = await callJson(callLLM, "ledger_extract", readRuntimeFile("specialist/ledger_extractor.md"),
      `${context}\n\n[TARGET_MESSAGE_IDS]\n${JSON.stringify(ids)}${feedback}`, "synthesis_ledger_entries", extractionSchema(ids, optionLabels));
    diagnostics.calls.push({ kind: "ledger_extract", round, targets: ids.length, ok: extracted.ok, error: extracted.error });
    const proposed = new Map();
    let proposedQuestion = null;
    if (extracted.ok && Array.isArray(extracted.value.entries)) {
      const seen = new Set();
      for (const raw of extracted.value.entries) {
        const source = pending.find(s => s.messageId === raw?.messageId);
        if (!source) continue;
        if (seen.has(source.messageId)) { proposed.set(source.messageId, { rejected: "entry_duplicated" }); continue; }
        seen.add(source.messageId);
        const checked = checkProposedEntry(raw, source, { optionLabels, earlierIds: order.slice(0, order.indexOf(source.messageId)) });
        proposed.set(source.messageId, checked ?? { rejected: "entry_failed_structure_check", hint: raw?.points?.[0]?.option });
      }
      if (round === 1) proposedQuestion = checkQuestion(extracted.value.question);
    }
    const auditable = pending.filter(s => proposed.get(s.messageId) && !proposed.get(s.messageId).rejected);
    const verdicts = new Map();
    let auditRan = false;
    if (auditable.length && canContinue()) {
      const auditIds = auditable.map(s => s.messageId);
      const audited = await callJson(callLLM, "ledger_audit", readRuntimeFile("specialist/ledger_auditor.md"),
        `${context}\n\n[PROPOSED_ENTRIES]\n${JSON.stringify(auditable.map(s => { const { reason, ...entry } = proposed.get(s.messageId); return entry; }), null, 1)}\n\n[PROPOSED_QUESTION]\n${proposedQuestion ?? "(none)"}`,
        "synthesis_ledger_audit", auditSchema(auditIds));
      diagnostics.calls.push({ kind: "ledger_audit", round, targets: auditIds.length, ok: audited.ok, error: audited.error });
      if (audited.ok && Array.isArray(audited.value.verdicts)) {
        auditRan = true;
        const counts = new Map();
        for (const v of audited.value.verdicts) counts.set(v?.messageId, (counts.get(v?.messageId) || 0) + 1);
        for (const v of audited.value.verdicts) if (counts.get(v?.messageId) === 1) verdicts.set(v.messageId, v.verdict);
        if (round === 1 && proposedQuestion && audited.value.questionOk === true) question = proposedQuestion;
      }
    }
    const stillPending = [];
    for (const source of pending) {
      const entry = proposed.get(source.messageId);
      const fail = (reason, hint) => { failure.set(source.messageId, { reason, hint: hint ?? failure.get(source.messageId)?.hint }); stillPending.push(source); };
      if (!entry) { fail(extracted.ok ? "entry_missing" : "extraction_unavailable"); continue; }
      if (entry.rejected) { fail(entry.rejected, entry.hint); continue; }
      const hint = entry.points[0]?.option;
      if (!auditRan) { fail("audit_unavailable", hint); continue; }
      const verdict = verdicts.get(source.messageId);
      if (verdict !== "ok") { fail(`audit_${verdict ?? "verdict_missing"}`, hint); continue; }
      failure.delete(source.messageId);
      entries[source.messageId] = entry;
      nextCache[source.messageId] = { text: source.text, entry };
    }
    pending = stillPending;
  }
  for (const source of targets) if (!entries[source.messageId]) fallback(source, failure.get(source.messageId)?.reason ?? "time_budget", failure.get(source.messageId)?.hint);
  // A "repeats" entry is only as good as what it points to: follow the chain
  // to a represented message; a repeat of a no-information message carries
  // none either; anything unresolved is quoted.
  for (const source of sources) {
    const entry = entries[source.messageId];
    if (entry.status !== "repeats") continue;
    let target = entries[entry.sameAs];
    for (let hops = 0; target?.status === "repeats" && hops < sources.length; hops++) target = entries[target.sameAs];
    if (target && ["points", "verbatim"].includes(target.status)) continue;
    delete nextCache[source.messageId];
    if (target?.status === "no_task_information") {
      entries[source.messageId] = { messageId: source.messageId, status: "no_task_information", points: [], reason: `repeats ${entry.sameAs}, which has no task information` };
      nextCache[source.messageId] = { text: source.text, entry: entries[source.messageId] };
    } else fallback(source, "repeat_target_not_represented");
  }
  return { order, entries, cache: nextCache, question, diagnostics };
}

/** Deterministic rendering: every "points"/"verbatim" entry appears, in
 * first-appearance order, under its option in the authoritative option order. */
export function renderSynthesisLedger({ order, entries, question }, optionLabels = []) {
  const bySection = new Map([...optionLabels, GENERAL_OPTION].map(label => [label, []]));
  const groundingMessageIds = [], accounted = [];
  for (const id of order) {
    const entry = entries[id];
    accounted.push({ messageId: id, status: entry.status, ...(entry.sameAs ? { sameAs: entry.sameAs } : {}), ...(entry.fallbackReason ? { fallbackReason: entry.fallbackReason } : {}) });
    if (!entry.points.length) continue;
    groundingMessageIds.push(id);
    for (const point of entry.points) {
      const section = bySection.get(bySection.has(point.option) ? point.option : GENERAL_OPTION);
      // Identical wording under the same option is listed once; both messages stay cited.
      if (!section.some(existing => loose(existing) === loose(point.text))) section.push(point.text);
    }
  }
  for (const id of order) if (entries[id].status === "repeats" && !groundingMessageIds.includes(id)) groundingMessageIds.push(id);
  const sections = [...bySection].filter(([, points]) => points.length).map(([label, points]) => ({
    title: label === GENERAL_OPTION ? OTHER_POINTS_TITLE : label,
    body: points.map((text, index) => `${index + 1}. ${text}`).join("\n"),
  }));
  const itemCount = [...bySection.values()].reduce((n, points) => n + points.length, 0);
  const stats = { messages: order.length, items: itemCount,
    points: order.filter(id => entries[id].status === "points").length,
    verbatim: order.filter(id => entries[id].status === "verbatim").length,
    repeats: order.filter(id => entries[id].status === "repeats").length,
    noTaskInformation: order.filter(id => entries[id].status === "no_task_information").length,
    questionSource: question ? "model" : "fixed" };
  return { enough: itemCount >= MIN_SYNTHESIS_ITEMS && sections.length > 0, stats, accounted,
    candidate: { role: "INFORMATION_SYNTHESISER",
      message: { summary: LEDGER_SUMMARY, sections, question: question || FALLBACK_QUESTION },
      groundingMessageIds: groundingMessageIds.sort((a, b) => order.indexOf(a) - order.indexOf(b)) } };
}
