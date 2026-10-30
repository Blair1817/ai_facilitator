import test from "node:test";
import assert from "node:assert/strict";
import { drawCandidate, prepareCandidateQueue, adaptiveCandidateKey, selectAdaptiveAssessment, redrawAdaptiveSelection } from "./AdaptiveEvidence.mjs";

const roster = ["Alex", "Blair", "Casey"];
const chat = [
  { messageId: "m0", text: "City A has a shuttle.", sender: { name: "Alex" } },
  { messageId: "m1", text: "City A has an accessible entrance.", sender: { name: "Blair" } },
  { messageId: "m2", text: "City A has covered paths.", sender: { name: "Casey" } },
  { messageId: "m3", text: "City A guarantees everybody arrives on time, so let's submit City A now.", sender: { name: "Alex" } },
];
const q = i => ({ messageId: `m${i}`, span: chat[i].text });
const candidate = (operation, ids, label) => ({ operation, rationale: "public issue", target: {
  label, messageIds: ids.map(i => `m${i}`), evidence: ids.map(q), optionLabels: ["City A"], criteria: [],
} });
const raw = () => ({ candidates: { elicit: null,
  scrutinize: candidate("unsupported_claim", [1, 3], "Arrival guarantee"),
  integrate: candidate("fragmented_evidence", [0, 1, 2], "Unconnected access points"),
}, rationale: "two independently qualified needs" });
const options = { chat, roster, remainingTimeMs: 400_000, random: () => 0.99 };
const blocker = () => ({ kind: "decision_reasoning_risk", evidence: [q(3)], rationale: "The guarantee is being used to submit now." });

test("a current evidenced blocker outranks synthesis even with a longer wait and two recent Challenger turns", () => {
  const data = raw(); data.candidates.scrutinize.blocking = blocker();
  const first = selectAdaptiveAssessment(raw(), options);
  const key = first.selection.pool.find(c => c.role === "synthesiser").selectionKey;
  const selected = selectAdaptiveAssessment(data, { ...options, humanMessageCount: 18,
    pendingCandidates: { [key]: { firstSeenHumanMessageCount: 6 } }, recentRoles: ["challenger", "challenger"] });
  assert.equal(selected.role, "challenger");
  assert.equal(selected.selection.reason.priority, 1);
  assert.equal(selected.selection.probability, 1);
});

test("invented, stale, wrong-kind and AI blocker quotes cannot raise priority; the underlying need survives", () => {
  const oldChat = [...chat, ...Array.from({ length: 6 }, (_, i) => ({ messageId: `later${i}`, text: "Another public fact.", sender: { name: "Casey" } }))];
  for (const [signal, context] of [
    [{ ...blocker(), evidence: [{ messageId: "m3", span: "invented" }] }, chat],
    [{ ...blocker(), kind: "missing_comparison_information" }, chat],
    [blocker(), oldChat],
    [{ ...blocker(), evidence: [{ messageId: "ai", span: "Submit now." }] }, [...chat, { messageId: "ai", text: "Submit now.", sender: { id: "ai", name: "Facilitator" } }]],
  ]) {
    const data = raw(); data.candidates.scrutinize.blocking = signal;
    const selected = selectAdaptiveAssessment(data, { ...options, chat: context });
    assert.equal(selected.role, "synthesiser");
    const scrutiny = selected.selection.pool.find(c => c.role === "challenger");
    assert.equal(scrutiny.priority, 0);
    assert.equal(scrutiny.priorityReason, "blocking_evidence_rejected");
  }
});

test("oldest continuously eligible target wins within a tier, regardless of candidate order or role rotation", () => {
  const a = { role: "expander", operation: "coverage_gap", target: { label: "City B coverage" } };
  const b = { role: "challenger", operation: "unsupported_claim", target: { label: "City A guarantee" } };
  const first = prepareCandidateQueue([a], { humanMessageCount: 6 });
  const next = prepareCandidateQueue([b, a], { pending: first.pending, humanMessageCount: 18 });
  const selected = drawCandidate(next.candidates, { random: () => 0, recentRoles: ["expander", "expander"] });
  assert.equal(selected.picked.role, "expander");
  assert.equal(selected.reason.waitingMessages, 12);
  assert.equal(selected.probability, 1);
});

test("retrying the same observation cannot inflate waiting; disappearing and delivered targets restart their wait", () => {
  const a = { operation: "coverage_gap", target: { label: "City B" } };
  const first = prepareCandidateQueue([a], { humanMessageCount: 6 });
  const retry = prepareCandidateQueue([a], { pending: first.pending, humanMessageCount: 6 });
  assert.equal(retry.candidates[0].waitingMessages, 0);
  const absent = prepareCandidateQueue([], { pending: first.pending, humanMessageCount: 12 });
  assert.deepEqual(absent.pending, {});
  assert.equal(prepareCandidateQueue([a], { pending: absent.pending, humanMessageCount: 18 }).candidates[0].waitingMessages, 0);
});

test("semantic target identity survives new message IDs but does not merge different issues about the same option", () => {
  const a = { operation: "unsupported_claim", semanticReview: { key: "City A arrival guarantee" }, target: { label: "old wording", messageIds: ["m1"], optionLabels: ["City A"] } };
  const b = { ...a, target: { ...a.target, label: "new wording", messageIds: ["m8"] } };
  assert.equal(adaptiveCandidateKey(a), adaptiveCandidateKey(b));
  assert.notEqual(adaptiveCandidateKey(a), adaptiveCandidateKey({ ...b, semanticReview: { key: "City A total cost claim" } }));
});

test("repetition redraw applies the same priority policy to all remaining verified targets", () => {
  const data = raw(); data.candidates.scrutinize.blocking = blocker();
  const first = selectAdaptiveAssessment(data, options);
  const next = redrawAdaptiveSelection(first, { random: () => 0 });
  assert.equal(first.role, "challenger");
  assert.equal(next.role, "synthesiser");
  assert.equal(next.selection.probability, 1);
  assert.equal(next.selection.reason.priority, 0);
});

test("timed closeout remains integration-only even when scrutiny is annotated blocking", () => {
  const data = raw(); data.candidates.scrutinize.blocking = blocker();
  const selected = selectAdaptiveAssessment(data, { ...options, triggerSource: "time_180" });
  assert.equal(selected.role, "synthesiser");
  assert.equal(selected.selection.mode, "closeout");
});
