// Pure tests of the ledger's guarantees. The model is a scripted function;
// several tests feed it deliberately wrong or random output.
import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";
process.argv[1] = path.join(path.dirname(fileURLToPath(import.meta.url)), "fake-entry.js");
const { buildSynthesisLedger, renderSynthesisLedger, checkProposedEntry, checkQuestion, ledgerSources, extractionSchema, auditSchema,
  FALLBACK_QUESTION, OTHER_POINTS_TITLE, LEDGER_SUMMARY, ledgerContextLines, namedOptions, UNCLEAR_OPTION } = await import("./SynthesisLedger.mjs");
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
  assert.deepEqual(rendered.stats, { messages: 6, items: 4, points: 3, verbatim: 0, repeats: 1, noTaskInformation: 2, optionDisputed: 0, questionSource: "model" });
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

// ── 2026-11-18 internal test: Halden's points were filed under Fenwick ──────
const B_OPTIONS = ["Norvale University", "Halden University", "Fenwick University"];
const facilitator = (text, presentation) => ({ text, sender: { id: "ai", name: "Facilitator" }, messageType: "facilitator", speakerType: "facilitator", ...(presentation ? { presentation } : {}) });
// Excerpt of the 2026-11-18 Round 1 discussion, in order.
const HALDEN_CHAT = [
  say("Blue", "I want to choose Fenwick"),
  facilitator("Has anyone read anything about Halden University yet—good or bad—that could help the group consider it?"),
  say("Green", "Halden I liek teh name"),
  say("Blue", "very bad name"),
  say("Pink", "public surveys show substantial resident opposition for fenwick"),
  say("Green", "It has experience of delivering similar academic conferences"),
  say("Green", "and tehre are enough closes guest room"),
  facilitator("What points have you already seen, if any, that support the view that Halden University is not good?"),
  say("Blue", "non refundable bookings"),
  say("Green", "residents near conferences have objected to expected noise"),
  facilitator("Shared points so far ...", { summary: "Shared points so far", sections: [{ title: "Fenwick University", body: "1. Fenwick University has experience delivering similar academic conferences." }], question: "How should the group weigh these points?" }),
  say("Pink", "I don't like Fenwick."),
];
const buildB = (opts = {}, chat = HALDEN_CHAT) => {
  const m = model(opts);
  return buildSynthesisLedger({ chat, optionLabels: B_OPTIONS, taskGeneralContext: "Choose a host campus.", callLLM: m.callLLM })
    .then(ledger => ({ ledger, calls: m.calls, rendered: renderSynthesisLedger(ledger, B_OPTIONS) }));
};

test("Facilitator messages reach the extractor and auditor as context only; earlier scoreboards are collapsed to their question", async () => {
  const lines = ledgerContextLines(HALDEN_CHAT).split("\n");
  assert.equal(lines.length, HALDEN_CHAT.length);
  assert.equal(lines[7], "[m7] [Facilitator (context only)]: What points have you already seen, if any, that support the view that Halden University is not good?");
  assert.equal(lines[8], "[m8] [Blue]: non refundable bookings", "the answer directly follows the question it answers");
  assert.equal(lines[10], "[m10] [Facilitator (context only)]: (earlier summary of shared points omitted) How should the group weigh these points?");
  assert.doesNotMatch(lines.join("\n"), /Fenwick University has experience/, "a wrong earlier attribution is not fed back");
  const { calls } = await buildB();
  for (const call of calls) assert.match(call.user, /\[m7\] \[Facilitator \(context only\)\]: What points/);
  assert.deepEqual(ledgerTargets(calls[0].user), ledgerSources(HALDEN_CHAT).map(s => s.messageId), "Facilitator messages are never targets");
  assert.ok(!ledgerTargets(calls[0].user).some(id => ["m1", "m7", "m10"].includes(id)));
});

test("option names are matched with one typo allowed, but not other words", () => {
  const A = ["Talwick", "Rovenna", "Meridia"];
  assert.deepEqual(namedOptions("i like maridia", A), ["Meridia"]);
  assert.deepEqual(namedOptions("I dont like robenna", A), ["Rovenna"]);
  assert.deepEqual(namedOptions("norvgale jhas stuent groups", B_OPTIONS), ["Norvale University"]);
  assert.deepEqual(namedOptions("Novale?", B_OPTIONS), ["Norvale University"]);
  assert.deepEqual(namedOptions("public surveys show substantial resident opposition for fenwick", B_OPTIONS), ["Fenwick University"]);
  assert.deepEqual(namedOptions("the media centre lacks power", A), [], "a different word two edits away is not a name");
  assert.deepEqual(namedOptions("golden hotels, hidden costs, talking", [...A, ...B_OPTIONS]), []);
  assert.deepEqual(namedOptions("Halden is better than Fenwick", B_OPTIONS), ["Halden University", "Fenwick University"]);
});

test("a point filed under a different option than the single one the message names is quoted under the named option, with no retry", async () => {
  const pink = ledgerSources(HALDEN_CHAT).find(s => s.messageId === "m4");
  const wrong = { messageId: "m4", status: "points", sameAs: null, reason: "r",
    points: [{ option: "Halden University", text: "Public surveys show substantial resident opposition.", quote: "public surveys show substantial resident opposition" }] };
  assert.deepEqual(checkProposedEntry(wrong, pink, { optionLabels: B_OPTIONS, earlierIds: [] }).points,
    [{ option: "Fenwick University", text: "“public surveys show substantial resident opposition”", quote: "public surveys show substantial resident opposition" }]);
  assert.equal(checkProposedEntry({ ...wrong, points: [{ ...wrong.points[0], option: "Fenwick University" }] }, pink, { optionLabels: B_OPTIONS, earlierIds: [] }).points[0].text,
    "Public surveys show substantial resident opposition.", "a point under the named option keeps its wording");
  const twoNamed = { messageId: "m0", text: "Halden is better than Fenwick" };
  assert.equal(checkProposedEntry({ ...wrong, messageId: "m0", points: [{ option: "Halden University", text: "Halden is better.", quote: "Halden is better" }] }, twoNamed, { optionLabels: B_OPTIONS, earlierIds: [] }).points[0].option,
    "Halden University", "two named options: the model chooses between them");
  const misfile = user => { const data = mockLedgerExtraction(user); for (const e of data.entries) if (e.messageId === "m4") e.points[0].option = "Halden University"; return data; };
  const { ledger, rendered, calls } = await buildB({ extract: misfile });
  assert.equal(calls.length, 2, "no retry");
  assert.equal(ledger.entries.m4.status, "points");
  assert.match(rendered.candidate.message.sections.find(s => s.title === "Fenwick University").body, /“public surveys show substantial resident opposition for fenwick”/);
  assert.doesNotMatch(rendered.candidate.message.sections.find(s => s.title === "Halden University")?.body ?? "", /opposition/);
});

test("Unclear points and failed entries for messages that name no option go under Other points in the participant's own words, never under a guessed option", async () => {
  const unclear = user => { const data = mockLedgerExtraction(user); for (const e of data.entries) if (e.messageId === "m5") e.points = [{ option: UNCLEAR_OPTION, text: "Experience delivering similar conferences.", quote: "experience of delivering similar academic conferences" }]; return data; };
  const { ledger, rendered } = await buildB({ extract: unclear });
  assert.deepEqual(ledger.entries.m5.points, [{ option: UNCLEAR_OPTION, text: "“experience of delivering similar academic conferences”", quote: "experience of delivering similar academic conferences" }]);
  const other = rendered.candidate.message.sections.find(s => s.title === OTHER_POINTS_TITLE);
  assert.match(other.body, /“experience of delivering similar academic conferences”/);
  assert.doesNotMatch(rendered.candidate.message.sections.find(s => s.title === "Fenwick University")?.body ?? "", /experience/);
  // The model files "and tehre are enough closes guest room" under Fenwick and the auditor rejects it twice:
  // the verbatim fallback must not reuse the model's unverified option.
  const guess = user => { const data = mockLedgerExtraction(user); for (const e of data.entries) if (e.messageId === "m6") e.points[0].option = "Fenwick University"; return data; };
  const { ledger: l2, rendered: r2 } = await buildB({ extract: guess, audit: user => mockLedgerAudit(user, id => id === "m6" ? "unfaithful" : "ok") });
  assert.equal(l2.entries.m6.status, "verbatim");
  assert.equal(l2.entries.m6.points[0].option, "General");
  assert.match(r2.candidate.message.sections.find(s => s.title === OTHER_POINTS_TITLE).body, /“and tehre are enough closes guest room”/);
  assert.ok(extractionSchema(["m0"], B_OPTIONS).properties.entries.items.properties.points.items.properties.option.enum.includes(UNCLEAR_OPTION));
});

// 2026-11-19: a later message contesting an earlier message's option.
test("a message whose option a later message contests is shown in the participant's own words under Other points", async () => {
  const chat = [
    say("Green", "it has experience of delivering similar events"),
    say("Pink", "that was Talwick, not Rovenna"),
    say("Blue", "Rovenna hotels are near the venues"),
  ];
  const { ledger, rendered } = await build({ extract: user => {
    const data = mockLedgerExtraction(user);
    for (const entry of data.entries) {
      if (entry.messageId === "m0") entry.points = [{ option: "Rovenna", text: "Experience delivering similar events.", quote: "experience of delivering similar events" }];
      if (entry.messageId === "m1") Object.assign(entry, { status: "no_task_information", points: [], disputesOptionOf: ["m0", "m2", "m9"] });
    }
    return data;
  } }, chat);
  // Only earlier participant messages count.
  assert.deepEqual(ledger.entries.m1.disputesOptionOf, ["m0"]);
  const sections = Object.fromEntries(rendered.candidate.message.sections.map(s => [s.title, s.body]));
  assert.equal(sections.Rovenna, "1. Rovenna hotels are near the venues");
  assert.match(sections[OTHER_POINTS_TITLE], /“experience of delivering similar events”/);
  assert.doesNotMatch(text(rendered), /Experience delivering similar events\./);
  assert.equal(rendered.stats.optionDisputed, 1);
  assert.deepEqual(rendered.accounted.find(a => a.messageId === "m0"), { messageId: "m0", status: "points", optionDisputed: true });
  // The dispute lives on the contesting entry, so a cached m0 is moved too.
  const cached = await build({}, chat, ledger.cache);
  assert.equal(cached.calls.length, 0);
  assert.match(Object.fromEntries(cached.rendered.candidate.message.sections.map(s => [s.title, s.body]))[OTHER_POINTS_TITLE], /“experience of delivering similar events”/);
});

test("the contesting message's own option claim is not filed either", async () => {
  const chat = [
    say("Green", "and there are enough close guest rooms"),
    say("Pink", "wait, the guest rooms point is Talwick, not Rovenna"),
  ];
  const { rendered } = await build({ extract: user => {
    const data = mockLedgerExtraction(user);
    for (const entry of data.entries) {
      if (entry.messageId === "m0") entry.points = [{ option: "Rovenna", text: "Enough close guest rooms.", quote: "enough close guest rooms" }];
      if (entry.messageId === "m1") Object.assign(entry, { points: [{ option: "Talwick", text: "Guest rooms are a Talwick point.", quote: "the guest rooms point is Talwick" }], disputesOptionOf: ["m0"] });
    }
    return data;
  } }, chat);
  assert.deepEqual(rendered.candidate.message.sections.map(s => s.title), [OTHER_POINTS_TITLE]);
  assert.match(rendered.candidate.message.sections[0].body, /“enough close guest rooms”[\s\S]*“the guest rooms point is Talwick”/);
  assert.equal(rendered.stats.optionDisputed, 2);
});

test("disputesOptionOf on a later message is kept through checkProposedEntry for every status", () => {
  const source = { messageId: "m3", text: "no, Talwick" };
  const earlierIds = ["m0", "m1"];
  assert.deepEqual(checkProposedEntry({ messageId: "m3", status: "no_task_information", points: [], sameAs: null, disputesOptionOf: ["m1", "m1", "m3"], reason: "x" }, source, { optionLabels: OPTIONS, earlierIds }).disputesOptionOf, ["m1"]);
  assert.equal("disputesOptionOf" in checkProposedEntry({ messageId: "m3", status: "no_task_information", points: [], sameAs: null, reason: "x" }, source, { optionLabels: OPTIONS, earlierIds }), false);
});
