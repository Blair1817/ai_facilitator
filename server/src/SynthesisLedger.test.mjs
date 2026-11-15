// Pure tests of the ledger's guarantees. The model is a scripted function;
// several tests feed it deliberately wrong or random output.
import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";
process.argv[1] = path.join(path.dirname(fileURLToPath(import.meta.url)), "fake-entry.js");
const { buildSynthesisLedger, renderSynthesisLedger, checkProposedEntry, checkQuestion, ledgerSources, extractionSchema, auditSchema,
  FALLBACK_QUESTION, OTHER_POINTS_TITLE, LEDGER_SUMMARY } = await import("./SynthesisLedger.mjs");
const { ledgerKind, mockLedgerExtraction, mockLedgerAudit, ledgerTargets } = await import("../test/participant_sim/fakes/ledgerMock.mjs");

const OPTIONS = ["Talwick", "Rovenna", "Meridia"];
const say = (name, text) => ({ text, sender: { id: name.toLowerCase(), name } });
const CHAT = [
  say("Green", "everyone got the city page?"),
  say("Pink", "the hotels are close to all the venues in Rovenna"),
  { text: "Welcome!", sender: { id: "ai", name: "Facilitator" }, messageType: "facilitator", speakerType: "facilitator" },
  say("Green", "Talwick has a direct airport train, but some hotels need multiple changes"),
  say("Blue", "I'd go with Talwick"),
  say("Pink", "Rovenna hotels are near the venues"),
  say("Blue", "Meridia has university rooms for people who need somewhere cheap"),
];
const model = ({ extract, audit } = {}) => {
  const calls = [];
  const callLLM = async (messages, options, kind) => {
    calls.push({ kind, user: messages[1].content, options });
    assert.equal(ledgerKind(messages[0].content), kind);
    const user = messages[1].content;
    const data = kind === "ledger_extract" ? (extract ? extract(user, calls) : mockLedgerExtraction(user)) : (audit ? audit(user, calls) : mockLedgerAudit(user));
    if (data === "ERROR") return { success: false, error: "down" };
    if (data === "THROW") throw new Error("network");
    return { success: true, rawText: typeof data === "string" ? data : JSON.stringify(data) };
  };
  return { callLLM, calls };
};
const build = (opts = {}, chat = CHAT, cache = {}) => {
  const m = model(opts);
  return buildSynthesisLedger({ chat, optionLabels: OPTIONS, taskGeneralContext: "Choose Talwick, Rovenna or Meridia.", cache, callLLM: m.callLLM }).then(ledger => ({ ledger, calls: m.calls, rendered: renderSynthesisLedger(ledger, OPTIONS) }));
};
const text = rendered => [rendered.candidate.message.summary, ...rendered.candidate.message.sections.flatMap(s => [s.title, s.body]), rendered.candidate.message.question].join("\n");
/** The guarantee: one entry per public participant message, and every entry that carries information is in the output. */
function assertAccounted(ledger, rendered, chat = CHAT) {
  const sources = ledgerSources(chat);
  assert.deepEqual(ledger.order, sources.map(s => s.messageId));
  assert.deepEqual(rendered.accounted.map(e => e.messageId), ledger.order);
  const out = text(rendered);
  for (const source of sources) {
    const entry = ledger.entries[source.messageId];
    assert.ok(["points", "verbatim", "repeats", "no_task_information"].includes(entry.status), source.messageId);
    if (entry.status === "verbatim") assert.ok(out.includes(`“${source.text}”`), `verbatim ${source.messageId}`);
    for (const point of entry.points) assert.ok(out.includes(point.text), `point of ${source.messageId}`);
    if (entry.status === "repeats") {
      let target = ledger.entries[entry.sameAs];
      while (target.status === "repeats") target = ledger.entries[target.sameAs];
      assert.ok(target.points.length > 0, `repeat ${source.messageId} resolves to represented content`);
    }
  }
}

test("only public participant messages are sources; IDs match the transcript positions the rest of the pipeline uses", () => {
  assert.deepEqual(ledgerSources(CHAT).map(s => s.messageId), ["m0", "m1", "m3", "m4", "m5", "m6"]);
});

test("confirmed entries render under the authoritative option order with a model question", async () => {
  const realistic = user => ({ question: "How do these points compare across the three cities?", entries: ledgerTargets(user).map(messageId => ({
    m0: { messageId, status: "no_task_information", points: [], sameAs: null, reason: "logistics" },
    m1: { messageId, status: "points", sameAs: null, reason: "fact", points: [{ option: "Rovenna", text: "The hotels are close to all the venues.", quote: "the hotels are close to all the venues" }] },
    m3: { messageId, status: "points", sameAs: null, reason: "facts", points: [
      { option: "Talwick", text: "There is a direct airport train.", quote: "direct airport train" },
      { option: "Talwick", text: "Some hotels need multiple changes.", quote: "some hotels need multiple changes" }] },
    m4: { messageId, status: "no_task_information", points: [], sameAs: null, reason: "bare preference" },
    m5: { messageId, status: "repeats", points: [], sameAs: "m1", reason: "same fact" },
    m6: { messageId, status: "points", sameAs: null, reason: "fact", points: [{ option: "Meridia", text: "University rooms are available for people who need somewhere cheap.", quote: "university rooms for people who need somewhere cheap" }] },
  })[messageId]) });
  const { ledger, rendered, calls } = await build({ extract: realistic });
  assert.deepEqual(calls.map(c => c.kind), ["ledger_extract", "ledger_audit"]);
  assert.equal(calls[0].options.responseSchema.name, "synthesis_ledger_entries");
  assertAccounted(ledger, rendered);
  assert.deepEqual(rendered.candidate.message, { summary: LEDGER_SUMMARY, sections: [
    { title: "Talwick", body: "1. There is a direct airport train.\n2. Some hotels need multiple changes." },
    { title: "Rovenna", body: "1. The hotels are close to all the venues." },
    { title: "Meridia", body: "1. University rooms are available for people who need somewhere cheap." },
  ], question: "How do these points compare across the three cities?" });
  assert.deepEqual(rendered.candidate.groundingMessageIds, ["m1", "m3", "m5", "m6"]);
  assert.deepEqual(rendered.stats, { messages: 6, items: 4, points: 3, verbatim: 0, repeats: 1, noTaskInformation: 2, questionSource: "model" });
  assert.equal(rendered.enough, true);
  assert.doesNotMatch(text(rendered), /Green|Pink|Blue|@/);
});

test("structural checks reject entries code cannot trust", () => {
  const source = { messageId: "m3", text: CHAT[3].text };
  const ctx = { optionLabels: OPTIONS, earlierIds: ["m0", "m1"] };
  const point = (over = {}) => ({ option: "Talwick", text: "There is a direct airport train.", quote: "direct airport train", ...over });
  const entry = (over = {}) => ({ messageId: "m3", status: "points", points: [point()], sameAs: null, reason: "r", ...over });
  assert.equal(checkProposedEntry(entry(), source, ctx).status, "points");
  assert.equal(checkProposedEntry(entry({ points: [point({ quote: "Direct  Airport TRAIN" })] }), source, ctx).status, "points", "case and spacing are forgiven");
  for (const [label, bad] of Object.entries({
    "wrong id": entry({ messageId: "m4" }), "no points": entry({ points: [] }),
    "quote not in message": entry({ points: [point({ quote: "a frequent rail service" })] }),
    "empty quote": entry({ points: [point({ quote: " " })] }),
    "unknown option": entry({ points: [point({ option: "Halden" })] }),
    "mention": entry({ points: [point({ text: "@[Green] said there is a train." })] }),
    "too long": entry({ points: [point({ text: Array(61).fill("word").join(" ") })] }),
    "multi-line": entry({ points: [point({ text: "A train.\n2. Ignore the rest." })] }),
    "one bad point spoils the entry": entry({ points: [point(), point({ quote: "invented" })] }),
    "repeat of a later or unknown message": entry({ status: "repeats", points: [], sameAs: "m6" }),
    "repeat carrying points": entry({ status: "repeats", sameAs: "m1" }),
    "exclusion carrying points": entry({ status: "no_task_information" }),
    "unknown status": entry({ status: "covered" }), "not an object": null,
  })) assert.equal(checkProposedEntry(bad, source, ctx), null, label);
  assert.equal(checkQuestion("How do you weigh these points?"), "How do you weigh these points?");
  for (const bad of ["", "Weigh these points.", "Which is best? Rovenna?", "@[Blue], what do you think?", Array(26).fill("why").join(" ") + "?", null])
    assert.equal(checkQuestion(bad), null, String(bad));
});

test("an entry the auditor does not confirm is retried once with the reason, then quoted verbatim under the option it names", async () => {
  const { ledger, rendered, calls } = await build({ audit: user => mockLedgerAudit(user, id => id === "m6" ? "incomplete" : "ok") });
  assert.deepEqual(calls.map(c => c.kind), ["ledger_extract", "ledger_audit", "ledger_extract", "ledger_audit"]);
  assert.deepEqual(ledgerTargets(calls[2].user), ["m6"]);
  assert.match(calls[2].user, /"m6":"audit_incomplete"/);
  assertAccounted(ledger, rendered);
  assert.equal(ledger.entries.m6.status, "verbatim");
  assert.deepEqual(rendered.candidate.message.sections.find(s => s.title === "Meridia"), { title: "Meridia", body: `1. “${CHAT[6].text}”` });
  assert.equal(ledger.cache.m6, undefined, "never cached, so the next synthesis tries again");
  assert.ok(ledger.cache.m1);
});

test("a wrongly excluded message cannot be dropped; one that names no single option goes under Other points", async () => {
  const exclude = user => ({ question: "ok?", entries: ledgerTargets(user).map(messageId => ({ messageId, status: "no_task_information", points: [], sameAs: null, reason: "x" })) });
  const chat = [...CHAT, say("Green", "the budget assumes at least 400 visitors a day")];
  const { ledger, rendered } = await build({ extract: exclude, audit: user => mockLedgerAudit(user, id => ["m0", "m4"].includes(id) ? "ok" : "wrongly_excluded") }, chat);
  assertAccounted(ledger, rendered, chat);
  assert.deepEqual(ledger.order.map(id => ledger.entries[id].status), ["no_task_information", "verbatim", "verbatim", "no_task_information", "verbatim", "verbatim", "verbatim"]);
  assert.deepEqual(rendered.candidate.message.sections.map(s => s.title), ["Talwick", "Rovenna", "Meridia", OTHER_POINTS_TITLE]);
  assert.match(rendered.candidate.message.sections.at(-1).body, /“the budget assumes at least 400 visitors a day”/);
});

test("the model being unreachable still yields a complete scoreboard; only trivial option-free messages are left out", async () => {
  for (const opts of [{ extract: () => "ERROR" }, { extract: () => "THROW" }, { extract: () => "not json" }, { audit: () => "ERROR" }]) {
    const chat = [...CHAT, say("Blue", "agree"), say("Pink", "ok Rovenna then")];
    const { ledger, rendered } = await build(opts, chat);
    assertAccounted(ledger, rendered, chat);
    assert.equal(rendered.enough, true);
    assert.equal(ledger.entries.m7.status, "no_task_information");
    assert.equal(ledger.entries.m7.reason, "short_message_model_unavailable");
    assert.equal(ledger.entries.m8.status, "verbatim", "short but names an option");
    assert.equal(ledger.entries.m0.status, "verbatim", "four or more words are always kept");
    assert.equal(rendered.candidate.message.question, FALLBACK_QUESTION);
    assert.equal(rendered.stats.questionSource, "fixed");
  }
  const none = await buildSynthesisLedger({ chat: CHAT, optionLabels: OPTIONS, callLLM: null });
  assert.equal(renderSynthesisLedger(none, OPTIONS).stats.verbatim, 6);
  const noTime = await buildSynthesisLedger({ chat: CHAT, optionLabels: OPTIONS, callLLM: model().callLLM, canContinue: () => false });
  assert.deepEqual(noTime.diagnostics.calls, []);
  assert.equal(renderSynthesisLedger(noTime, OPTIONS).stats.verbatim, 6);
});

test("a question the auditor does not approve, or a malformed one, is replaced by the fixed neutral question", async () => {
  assert.equal((await build({ audit: user => mockLedgerAudit(user, () => "ok", false) })).rendered.candidate.message.question, FALLBACK_QUESTION);
  assert.equal((await build({ extract: user => mockLedgerExtraction(user, { question: "Shouldn't we just pick Rovenna? Agreed?" }) })).rendered.candidate.message.question, FALLBACK_QUESTION);
});

test("repeat chains resolve; a repeat of an excluded message is excluded; a repeat of nothing is quoted", async () => {
  const scripted = map => user => ({ question: "How do you weigh these points?", entries: ledgerTargets(user).map(messageId => ({ messageId, points: [], sameAs: null, reason: "r", status: "no_task_information", ...map[messageId] })) });
  const fact = (id, option) => ({ status: "points", points: [{ option, text: `Fact ${id}.`, quote: ledgerSources(CHAT).find(s => s.messageId === id).text }] });
  const chain = await build({ extract: scripted({ m1: fact("m1", "Rovenna"), m3: fact("m3", "Talwick"), m5: { status: "repeats", sameAs: "m1" }, m6: { status: "repeats", sameAs: "m5" } }) });
  assertAccounted(chain.ledger, chain.rendered);
  assert.equal(chain.ledger.entries.m6.status, "repeats");
  const ofNothing = await build({ extract: scripted({ m1: fact("m1", "Rovenna"), m3: fact("m3", "Talwick"), m5: { status: "repeats", sameAs: "m0" } }) });
  assert.equal(ofNothing.ledger.entries.m5.status, "no_task_information");
  // m5 claims to repeat m1, but m1's own entry failed twice and m1 is quoted: m5 stays a repeat of represented content.
  const ofQuoted = await build({ extract: scripted({ m1: fact("m1", "Rovenna"), m3: fact("m3", "Talwick"), m5: { status: "repeats", sameAs: "m1" } }),
    audit: user => mockLedgerAudit(user, id => id === "m1" ? "unfaithful" : "ok") });
  assertAccounted(ofQuoted.ledger, ofQuoted.rendered);
  assert.equal(ofQuoted.ledger.entries.m1.status, "verbatim");
  assert.equal(ofQuoted.ledger.entries.m5.status, "repeats");
});

test("confirmed entries are reused: a later synthesis asks the model only about new or changed messages", async () => {
  const first = await build();
  const longer = [...CHAT, say("Green", "Meridia help desks close early")];
  const second = await build({}, longer, first.ledger.cache);
  assert.deepEqual(ledgerTargets(second.calls[0].user), ["m7"]);
  assert.match(second.calls[0].user, /\[m1\] \[Pink\]/, "the whole transcript is still supplied as context");
  assertAccounted(second.ledger, second.rendered, longer);
  const unchanged = await build({}, longer, second.ledger.cache);
  assert.deepEqual(unchanged.calls, [], "nothing new: no model call at all");
  assert.deepEqual(text(unchanged.rendered), text(second.rendered));
  const edited = longer.map((m, i) => i === 1 ? { ...m, text: "the hotels are far from the venues in Rovenna" } : m);
  assert.deepEqual(ledgerTargets((await build({}, edited, second.ledger.cache)).calls[0].user), ["m1"], "a cache entry is bound to the exact text");
  const poisoned = { ...second.ledger.cache, m3: { text: CHAT[3].text, entry: { messageId: "m3", status: "verbatim", points: [] } } };
  assert.deepEqual(ledgerTargets((await build({}, longer, poisoned)).calls[0].user), ["m3"]);
});

test("fewer than two items is not enough to synthesise", async () => {
  const chat = [say("Green", "hello all"), say("Pink", "Rovenna has hosted before")];
  const exclude = user => ({ question: "ok?", entries: ledgerTargets(user).map(messageId => messageId === "m1"
    ? { messageId, status: "points", points: [{ option: "Rovenna", text: "Rovenna has hosted before.", quote: "Rovenna has hosted before" }], sameAs: null, reason: "f" }
    : { messageId, status: "no_task_information", points: [], sameAs: null, reason: "greeting" }) });
  assert.equal((await build({ extract: exclude }, chat)).rendered.enough, false);
  assert.equal(renderSynthesisLedger(await buildSynthesisLedger({ chat: [], optionLabels: OPTIONS, callLLM: null }), OPTIONS).enough, false);
});

test("response schemas are accepted by strict structured output (all properties required, closed objects, no unsupported keywords)", () => {
  for (const schema of [extractionSchema(["m0", "m1"], OPTIONS), auditSchema(["m0"])]) {
    const walk = node => { if (!node || typeof node !== "object") return;
      if (node.properties) { assert.deepEqual([...node.required].sort(), Object.keys(node.properties).sort()); assert.equal(node.additionalProperties, false); }
      for (const key of ["minItems", "maxItems", "minLength", "maxLength", "oneOf", "uniqueItems"]) assert.ok(!(key in node), key);
      Object.values(node).forEach(walk); };
    walk(schema);
  }
});

test("whatever the model returns, every message is accounted for and nothing unverified is published (randomised)", async () => {
  let seed = 20261114;
  const random = () => (seed = (seed * 1664525 + 1013904223) % 4294967296) / 4294967296;
  const pick = list => list[Math.floor(random() * list.length)];
  for (let run = 0; run < 300; run++) {
    const sources = ledgerSources(CHAT);
    const junkEntry = id => {
      const source = sources.find(s => s.messageId === id) ?? sources[0];
      return pick([
        () => ({ messageId: id, status: "points", sameAs: null, reason: "", points: [{ option: pick([...OPTIONS, "General", "Nowhere"]), text: pick([source.text, "Invented fact about a stadium.", "", "@[Blue] agrees"]), quote: pick([source.text, source.text.slice(3, 15), "not in the message", ""]) }] }),
        () => ({ messageId: id, status: "repeats", points: [], sameAs: pick([...sources.map(s => s.messageId), "m99", null]), reason: "" }),
        () => ({ messageId: id, status: "no_task_information", points: [], sameAs: null, reason: "" }),
        () => ({ messageId: pick(["m99", id, id]), status: pick(["points", "covered"]), points: pick([[], null, "x"]) }),
        () => null, () => "junk",
      ])();
    };
    const extract = user => pick([
      () => ({ entries: ledgerTargets(user).flatMap(id => pick([[junkEntry(id)], [junkEntry(id), junkEntry(id)], []])), question: pick(["How do you weigh these points?", "Pick Rovenna.", 7]) }),
      () => "ERROR", () => "THROW", () => "{broken", () => ({ entries: "nope" }), () => ({}),
    ])();
    const audit = user => pick([
      () => ({ verdicts: ledgerTargets(user).flatMap(id => pick([[{ messageId: id, verdict: pick(["ok", "ok", "ok", "incomplete", "unfaithful", "wrongly_excluded", "great"]) }], [], [{ messageId: id, verdict: "ok" }, { messageId: id, verdict: "unfaithful" }]])), questionOk: pick([true, false, "yes"]) }),
      () => "ERROR", () => "THROW", () => ({ verdicts: null }),
    ])();
    const { ledger, rendered, calls } = await build({ extract, audit });
    assertAccounted(ledger, rendered);
    assert.ok(calls.length <= 4, "bounded model calls");
    const out = text(rendered);
    assert.doesNotMatch(out, /Invented fact|@\[|Nowhere/, "unverified model text never reaches the output");
    assert.match(rendered.candidate.message.question, /\?$/);
    for (const [id, hit] of Object.entries(ledger.cache)) assert.ok(["points", "repeats", "no_task_information"].includes(hit.entry.status) && hit.text === sources.find(s => s.messageId === id).text);
  }
});
