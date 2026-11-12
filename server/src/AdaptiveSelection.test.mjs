import test from "node:test";
import assert from "node:assert/strict";
import { drawCandidate, selectAdaptiveAssessment, MAX_CONSECUTIVE_SAME_ROLE } from "./AdaptiveEvidence.mjs";

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
// 2026-11-11: uniform random role selection; no priority tiers or waiting queue.
test("roles are drawn uniformly, then candidates uniformly within the drawn role, with the exact probability", () => {
  const pool = [{ role: "challenger", id: 1 }, { role: "challenger", id: 2 }, { role: "synthesiser", id: 3 }];
  const low = drawCandidate(pool, { random: () => 0 });
  assert.equal(low.picked.id, 1);
  assert.equal(low.probability, 0.25);
  const high = drawCandidate(pool, { random: () => 0.99 });
  assert.equal(high.picked.id, 3);
  assert.equal(high.probability, 0.5);
  assert.deepEqual(high.eligibleRoles, ["challenger", "synthesiser"]);
});

test("a role that filled the last two Specialist turns is skipped only when another role is available", () => {
  const recentRoles = Array(MAX_CONSECUTIVE_SAME_ROLE).fill("challenger");
  const mixed = drawCandidate([{ role: "challenger" }, { role: "synthesiser" }], { random: () => 0, recentRoles });
  assert.equal(mixed.picked.role, "synthesiser");
  assert.equal(mixed.probability, 1);
  const only = drawCandidate([{ role: "challenger" }], { random: () => 0, recentRoles });
  assert.equal(only.picked.role, "challenger");
});

test("message checkpoints draw among all verified needs; timed closeout stays integration-only", () => {
  const ordinary = selectAdaptiveAssessment(raw(), { ...options, random: () => 0 });
  assert.equal(ordinary.selection.mode, "random");
  assert.deepEqual(ordinary.selection.pool.map(c => c.role).sort(), ["challenger", "synthesiser"]);
  const timed = selectAdaptiveAssessment(raw(), { ...options, random: () => 0, triggerSource: "time_180" });
  assert.equal(timed.role, "synthesiser");
  assert.equal(timed.selection.mode, "closeout");
});

test("a participant-summary pause holds only while its evidence is among the latest three messages", () => {
  const none = { candidates: { elicit: null, scrutinize: null, integrate: null }, rationale: "summary underway" };
  const recent = selectAdaptiveAssessment({ ...none, defer: { reason: "participant_summary_in_progress", evidence: [q(3)] } }, options);
  assert.equal(recent.selection.mode, "deferred");
  assert.ok(recent.defer);
  const stale = selectAdaptiveAssessment({ ...none, defer: { reason: "participant_summary_in_progress", evidence: [q(0)] } }, options);
  assert.equal(stale.defer, undefined);
  assert.equal(stale.role, null);
  assert.equal(stale.selection.ignoredDefer, "evidence_not_recent");
});
