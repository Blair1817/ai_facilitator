// Architecture doc Step 6. Pure-function tests -- no network, no Empirica,
// no filesystem reads (EvidenceChecker.js never reads prompt source
// files), so no fake-entry.js / process.argv[1] trick is needed here.
import assert from "node:assert/strict";
import test from "node:test";
import { checkEvidence, FACTOR_KEYS } from "./EvidenceChecker.js";

function humanMsg(name, text, idx) {
  return { text, ts: idx, sender: { id: `human-${name}`, name }, messageId: `m${idx}` };
}

// checkEvidence() re-derives message IDs from `chat` itself via
// withMessageIds (positional, append-order) -- these fixtures rely on that
// same m0/m1/m2/... scheme, matching DynamicContext.mjs's own convention.
function makeChat() {
  return [
    { text: "I think Eldoron is best", ts: 1, sender: { id: "human-1", name: "Red" } },   // m0
    { text: "Eldoron is best for us too", ts: 2, sender: { id: "human-2", name: "Pink" } }, // m1
    { text: "Sounds fine to me", ts: 3, sender: { id: "human-3", name: "Green" } },          // m2
  ];
}

function present(overrides = {}) {
  return { status: "present", strength: 0.8, message_ids: [], span: "", ...overrides };
}
function absent() {
  return { status: "absent", strength: 0, message_ids: [], span: "" };
}
function emptyRaw() {
  const raw = {};
  for (const key of FACTOR_KEYS) raw[key] = absent();
  return raw;
}

test("all-absent input stays all-absent", () => {
  const checked = checkEvidence(emptyRaw(), { chat: makeChat() });
  for (const key of FACTOR_KEYS) {
    assert.equal(checked[key].status, "absent");
  }
});

// ── Rule 2: span must actually occur in a cited message ─────────────────────

test("Rule 2: a fabricated span (not present in the cited message) is downgraded to uncertain", () => {
  const raw = { ...emptyRaw(), breadth_deficiency: present({ message_ids: ["m0"], span: "this text was never said" }) };
  const checked = checkEvidence(raw, { chat: makeChat() });
  assert.equal(checked.breadth_deficiency.status, "uncertain");
  assert.equal(checked.breadth_deficiency.strength, 0);
});

test("Rule 2: a genuine verbatim span from the cited message survives", () => {
  const raw = { ...emptyRaw(), breadth_deficiency: present({ message_ids: ["m0"], span: "Eldoron is best" }) };
  const checked = checkEvidence(raw, { chat: makeChat() });
  assert.equal(checked.breadth_deficiency.status, "present");
});

test("Rule 2: message_ids referencing a message ID that doesn't exist downgrades the factor", () => {
  const raw = { ...emptyRaw(), breadth_deficiency: present({ message_ids: ["m99"], span: "Eldoron is best" }) };
  const checked = checkEvidence(raw, { chat: makeChat() });
  assert.equal(checked.breadth_deficiency.status, "uncertain");
});

// ── Rule 1: group_preference requires >1 distinct participant ───────────────

test("Rule 1: group_preference from a single participant's message is downgraded, even if the LLM cited two message_ids from that same person", () => {
  const chat = [
    { text: "Eldoron is best, no doubt", ts: 1, sender: { id: "human-1", name: "Red" } }, // m0
    { text: "Eldoron is best, seriously", ts: 2, sender: { id: "human-1", name: "Red" } }, // m1 (same sender)
  ];
  const raw = { ...emptyRaw(), group_preference: present({ message_ids: ["m0", "m1"], span: "Eldoron is best" }) };
  const checked = checkEvidence(raw, { chat });
  assert.equal(checked.group_preference.status, "uncertain");
  assert.equal(checked.group_preference.downgradedReason, "GROUP_PREFERENCE_SINGLE_PARTICIPANT_ONLY");
});

test("Rule 1: group_preference genuinely spanning two distinct participants survives", () => {
  const raw = { ...emptyRaw(), group_preference: present({ message_ids: ["m0", "m1"], span: "Eldoron is best" }) };
  const checked = checkEvidence(raw, { chat: makeChat() });
  assert.equal(checked.group_preference.status, "present");
});

test("Rule 1 does not apply to other factors -- a single-participant breadth_deficiency is fine", () => {
  const raw = { ...emptyRaw(), breadth_deficiency: present({ message_ids: ["m0"], span: "Eldoron is best" }) };
  const checked = checkEvidence(raw, { chat: makeChat() });
  assert.equal(checked.breadth_deficiency.status, "present");
});

// ── Rule 3: feature/LLM conflict discount ────────────────────────────────────

test("checked LLM strength is unchanged when its citation is valid", () => {
  const raw = { ...emptyRaw(), breadth_deficiency: present({ strength: 0.8, message_ids: ["m0"], span: "Eldoron is best" }) };
  const checked = checkEvidence(raw, { chat: makeChat() });
  assert.equal(checked.breadth_deficiency.strength, 0.8);
});

// ── Rule 4: self_correction discounts other factors ─────────────────────────

test("Rule 4: self_correction present discounts other present factors proportionally to its own strength", () => {
  const raw = {
    ...emptyRaw(),
    breadth_deficiency: present({ strength: 0.8, message_ids: ["m0"], span: "Eldoron is best" }),
    self_correction: present({ strength: 1.0, message_ids: ["m1"], span: "Eldoron is best for us too" }),
  };
  const checked = checkEvidence(raw, { chat: makeChat() });
  // discountFactor = 1 - 0.5*1.0 = 0.5
  assert.ok(Math.abs(checked.breadth_deficiency.strength - 0.4) < 1e-9);
  assert.equal(checked.breadth_deficiency.selfCorrectionDiscounted, true);
  // self_correction itself is never discounted by its own rule
  assert.equal(checked.self_correction.strength, 1.0);
});

test("Rule 4: absent self_correction leaves other factors untouched", () => {
  const raw = { ...emptyRaw(), breadth_deficiency: present({ strength: 0.8, message_ids: ["m0"], span: "Eldoron is best" }) };
  const checked = checkEvidence(raw, { chat: makeChat() });
  assert.equal(checked.breadth_deficiency.strength, 0.8);
  assert.equal(checked.breadth_deficiency.selfCorrectionDiscounted, undefined);
});

// ── Robustness against malformed/missing input ──────────────────────────────

test("missing or malformed raw factor is treated as absent, not thrown", () => {
  const checked = checkEvidence({}, { chat: makeChat() });
  for (const key of FACTOR_KEYS) {
    assert.equal(checked[key].status, "absent");
  }
});

test("present factor with no span/message_ids is downgraded rather than trusted", () => {
  const raw = { ...emptyRaw(), breadth_deficiency: { status: "present", strength: 0.9, message_ids: [], span: "" } };
  const checked = checkEvidence(raw, { chat: makeChat() });
  assert.equal(checked.breadth_deficiency.status, "uncertain");
});

// ── Delibra spec §3 Node 3: per-evidence-relations tracking (2026-08-11) ──

test("evidenceRelations: returns the cleaned array on the result", () => {
  const raw = {
    ...emptyRaw(),
    evidenceRelations: [
      { messageId: "m0", mentioned: true, attributed: true,  evaluated: false, compared: false, countered: false, integrated: false },
      { messageId: "m1", mentioned: true, attributed: true,  evaluated: true,  compared: true,  countered: false, integrated: true  },
    ],
  };
  const checked = checkEvidence(raw, { chat: makeChat() });
  assert.ok(Array.isArray(checked.evidenceRelations));
  assert.equal(checked.evidenceRelations.length, 2);
  assert.equal(checked.evidenceRelations[0].messageId, "m0");
  assert.equal(checked.evidenceRelations[1].integrated, true);
});

test("evidenceRelations: drops entries whose messageId is not in chat", () => {
  const raw = {
    ...emptyRaw(),
    evidenceRelations: [
      { messageId: "m0", mentioned: true, attributed: false, evaluated: false, compared: false, countered: false, integrated: false }, // valid
      { messageId: "m99", mentioned: true, attributed: false, evaluated: false, compared: false, countered: false, integrated: false }, // bad id
    ],
  };
  const checked = checkEvidence(raw, { chat: makeChat() });
  assert.equal(checked.evidenceRelations.length, 1);
  assert.equal(checked.evidenceRelations[0].messageId, "m0");
});

test("evidenceRelations: drops entries with non-boolean 6-boolean fields", () => {
  const raw = {
    ...emptyRaw(),
    evidenceRelations: [
      { messageId: "m0", mentioned: true, attributed: "yes", evaluated: false, compared: false, countered: false, integrated: false }, // attributed is string
      { messageId: "m1", mentioned: true, attributed: true,  evaluated: true,  compared: true,  countered: false, integrated: true  }, // all valid
    ],
  };
  const checked = checkEvidence(raw, { chat: makeChat() });
  assert.equal(checked.evidenceRelations.length, 1);
  assert.equal(checked.evidenceRelations[0].messageId, "m1");
});

test("evidenceRelations: drops entries with missing 6-boolean fields (full 6-vector required)", () => {
  const raw = {
    ...emptyRaw(),
    evidenceRelations: [
      { messageId: "m0", mentioned: true, attributed: true, evaluated: true, compared: false, countered: false }, // missing integrated
    ],
  };
  const checked = checkEvidence(raw, { chat: makeChat() });
  assert.equal(checked.evidenceRelations.length, 0);
});

test("evidenceRelations: deduplicates by messageId (one row per participant message)", () => {
  const raw = {
    ...emptyRaw(),
    evidenceRelations: [
      { messageId: "m0", mentioned: true, attributed: true,  evaluated: false, compared: false, countered: false, integrated: false },
      { messageId: "m0", mentioned: true, attributed: false, evaluated: true,  compared: false, countered: false, integrated: false }, // duplicate m0, different booleans
    ],
  };
  const checked = checkEvidence(raw, { chat: makeChat() });
  assert.equal(checked.evidenceRelations.length, 1);
  assert.equal(checked.evidenceRelations[0].attributed, true); // first-seen wins
});

test("evidenceRelations: empty input → empty result (early checkpoint case)", () => {
  const raw = { ...emptyRaw(), evidenceRelations: [] };
  const checked = checkEvidence(raw, { chat: makeChat() });
  assert.deepEqual(checked.evidenceRelations, []);
});

test("evidenceRelations: missing field → empty result (graceful, not thrown)", () => {
  // The Assessor may have run before this field existed (legacy response) or
  // be unavailable; we must not throw.
  const raw = emptyRaw(); // no evidenceRelations key
  const checked = checkEvidence(raw, { chat: makeChat() });
  assert.deepEqual(checked.evidenceRelations, []);
});

test("evidenceRelations: 6-boolean vector covers all 6 keys (mentioned/attributed/evaluated/compared/countered/integrated)", () => {
  const raw = {
    ...emptyRaw(),
    evidenceRelations: [
      { messageId: "m0", mentioned: true, attributed: true, evaluated: true, compared: true, countered: true, integrated: true },
    ],
  };
  const checked = checkEvidence(raw, { chat: makeChat() });
  const expectedKeys = ["messageId", "mentioned", "attributed", "evaluated", "compared", "countered", "integrated"];
  assert.deepEqual(Object.keys(checked.evidenceRelations[0]).sort(), expectedKeys.sort());
});
