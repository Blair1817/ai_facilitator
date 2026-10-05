import test from "node:test";
import assert from "node:assert/strict";
import {
  canConfirmBreak,
  allFinalDecisionConfirmationsMatch,
  classifyFinalDecision,
  MESSAGE_TYPES,
  NO_GROUP_FINAL_DECISION,
  allocateSequencePosition,
  buildCanonicalMessage,
  normalizeMessageContent,
  reviewFinalDecisionConfirmation,
  reviewHumanMessageRequest,
  summarizeFinalDecisionDrafts,
} from "./ExperimentPolicies.mjs";

const breakEnd = 1_000_000;

test("T32-T33: readiness opens exactly 45 seconds before the scheduled end", () => {
  assert.equal(canConfirmBreak(breakEnd, breakEnd - 45_001), false);
  assert.equal(canConfirmBreak(breakEnd, breakEnd - 45_000), true);
});

test("FinalDecision requires exactly three identical non-empty drafts", () => {
  assert.deepEqual(summarizeFinalDecisionDrafts([
    { choice: "A", confidence: 40 },
    { choice: "A", confidence: null },
    { choice: "A", confidence: null },
  ]), { status: "agreed", matchedChoice: "A" });
  assert.deepEqual(summarizeFinalDecisionDrafts([{ choice: "A" }, { choice: "B" }, { choice: "A" }]), { status: "not_agreed", matchedChoice: null });
  assert.deepEqual(summarizeFinalDecisionDrafts([{ choice: "A" }, { choice: "A" }, { choice: "" }]), { status: "not_agreed", matchedChoice: null });
});

function matchingFinalDecisionDrafts(confidences = [40, null, null]) {
  return confidences.map((confidence, index) => ({
    participantId: `p${index + 1}`,
    choice: "A",
    confidence,
    confirmedChoice: null,
  }));
}

test("FinalDecision lets one participant confirm from their own authoritative confidence", () => {
  const drafts = matchingFinalDecisionDrafts();
  assert.deepEqual(reviewFinalDecisionConfirmation({
    drafts,
    participantId: "p1",
    requestChoice: "A",
  }), { accepted: true, matchedChoice: "A" });

  drafts[0].confirmedChoice = "A";
  assert.equal(allFinalDecisionConfirmationsMatch(drafts, "A"), false);
});

test("FinalDecision rejects a participant without their own valid confidence", () => {
  const drafts = matchingFinalDecisionDrafts();
  assert.equal(reviewFinalDecisionConfirmation({ drafts, participantId: "p2", requestChoice: "A" }).accepted, false);
  assert.equal(reviewFinalDecisionConfirmation({ drafts, participantId: "p1", requestChoice: "B" }).accepted, false);
});

test("FinalDecision accepts confidence boundaries and rejects invalid stored values", () => {
  for (const confidence of [0, 100]) {
    const drafts = matchingFinalDecisionDrafts([confidence, null, null]);
    assert.equal(reviewFinalDecisionConfirmation({ drafts, participantId: "p1", requestChoice: "A" }).accepted, true);
  }
  for (const confidence of [null, NaN, Infinity, -1, 101, "40"]) {
    const drafts = matchingFinalDecisionDrafts([confidence, null, null]);
    assert.equal(reviewFinalDecisionConfirmation({ drafts, participantId: "p1", requestChoice: "A" }).accepted, false);
  }
});

test("FinalDecision completes only after all three independently eligible confirmations", () => {
  const drafts = matchingFinalDecisionDrafts([40, null, null]);
  assert.equal(reviewFinalDecisionConfirmation({ drafts, participantId: "p1", requestChoice: "A" }).accepted, true);
  drafts[0].confirmedChoice = "A";
  assert.equal(allFinalDecisionConfirmationsMatch(drafts, "A"), false);

  drafts[1].confidence = 0;
  assert.equal(reviewFinalDecisionConfirmation({ drafts, participantId: "p2", requestChoice: "A" }).accepted, true);
  drafts[1].confirmedChoice = "A";
  assert.equal(allFinalDecisionConfirmationsMatch(drafts, "A"), false);

  drafts[2].confidence = 100;
  assert.equal(reviewFinalDecisionConfirmation({ drafts, participantId: "p3", requestChoice: "A" }).accepted, true);
  drafts[2].confirmedChoice = "A";
  assert.equal(allFinalDecisionConfirmationsMatch(drafts, "A"), true);
});

test("FinalDecision confirmations must all bind to the current matching choice", () => {
  assert.equal(allFinalDecisionConfirmationsMatch([
    { confirmedChoice: "A" }, { confirmedChoice: "A" }, { confirmedChoice: "A" },
  ], "A"), true);
  assert.equal(allFinalDecisionConfirmationsMatch([
    { confirmedChoice: "A" }, { confirmedChoice: null }, { confirmedChoice: "A" },
  ], "A"), false);
  assert.equal(allFinalDecisionConfirmationsMatch([
    { confirmedChoice: "A" }, { confirmedChoice: "A" }, { confirmedChoice: "A" },
  ], "B"), false);
});

test("FinalDecision classifies consensus, declared FAIL, and timeout FAIL distinctly", () => {
  assert.deepEqual(classifyFinalDecision("A"), { officialChoice: "A", outcome: "consensus_choice", timedOut: false });
  assert.deepEqual(classifyFinalDecision(NO_GROUP_FINAL_DECISION), { officialChoice: "FAIL", outcome: "declared_fail", timedOut: false });
  assert.deepEqual(classifyFinalDecision(null, { timedOut: true }), { officialChoice: "FAIL", outcome: "timeout_fail", timedOut: true });
});

const baseRequestContext = {
  playerId: "p1",
  currentRoundId: "r1",
  currentRoundIndex: 0,
  currentStageId: "s1",
  currentStageName: "Task",
  deadline: 2_000,
  now: 1_999,
};
const request = { requestId: "request-1", roundId: "r1", stageId: "s1", content: "  Evidence here  " };

test("R9-R10: authoritative message review accepts before deadline and rejects closed/stale/wrong-stage requests", () => {
  assert.deepEqual(reviewHumanMessageRequest({ ...baseRequestContext, request }), {
    accepted: true,
    reason: "accepted",
    requestId: "request-1",
    messageId: "p1-request-1",
    attribute: "chat_round_0",
    stage: "Discussion",
    content: "Evidence here",
  });
  assert.equal(reviewHumanMessageRequest({ ...baseRequestContext, request, now: 2_000 }).reason, "discussion_closed");
  assert.equal(reviewHumanMessageRequest({ ...baseRequestContext, request: { ...request, roundId: "old" } }).reason, "stale_round");
  assert.equal(reviewHumanMessageRequest({ ...baseRequestContext, request: { ...request, stageId: "old" } }).reason, "stale_stage");
  assert.equal(reviewHumanMessageRequest({ ...baseRequestContext, request, currentStageName: "TLX" }).reason, "wrong_stage");
});

test("formal Round 2 remains isolated in chat_round_1 and non-Discussion stages are rejected", () => {
  const formalRound2 = reviewHumanMessageRequest({
    ...baseRequestContext,
    request: { ...request, roundId: "r2" },
    currentRoundId: "r2",
    currentRoundIndex: 1,
  });
  assert.equal(formalRound2.attribute, "chat_round_1");

  const practice = reviewHumanMessageRequest({
    ...baseRequestContext,
    request,
    currentRoundIndex: 0,
    currentStageName: "PracticeDiscussion",
    deadline: undefined,
  });
  assert.equal(practice.accepted, false);
  assert.equal(practice.reason, "wrong_stage");
});

test("R11-R12/G2: stable IDs deduplicate by request and server allocator is unique and monotonic", () => {
  const processed = new Map();
  const appendAccepted = (incoming) => {
    const result = reviewHumanMessageRequest({ ...baseRequestContext, request: incoming });
    if (!result.accepted || processed.has(result.messageId)) return false;
    processed.set(result.messageId, result);
    return true;
  };
  assert.equal(appendAccepted(request), true);
  assert.equal(appendAccepted(request), false);
  const counters = {};
  assert.deepEqual([
    allocateSequencePosition(counters, "chat_round_0"),
    allocateSequencePosition(counters, "chat_round_0"),
    allocateSequencePosition(counters, "chat_round_0"),
  ], [0, 1, 2]);
});

function messageFixture(overrides = {}) {
  return buildCanonicalMessage({
    messageId: "m1",
    groupId: "g1",
    speakerId: "system",
    roundIndex: 0,
    stage: "Discussion",
    messageType: MESSAGE_TYPES.SYSTEM,
    speakerType: MESSAGE_TYPES.SYSTEM,
    timestamp: 1234,
    sequencePosition: 0,
    content: "Canonical content",
    sender: { id: "system", name: "System", avatar: "S" },
    ...overrides,
  });
}

test("R13/D6: canonical human/facilitator/timer/system/Practice messages satisfy the export fixture contract", () => {
  const representative = [
    messageFixture({ messageId: "human", participantId: "p1", speakerId: undefined, messageType: "human", speakerType: "human" }),
    messageFixture({ messageId: "facilitator", speakerId: "ai", messageType: "facilitator", speakerType: "facilitator" }),
    messageFixture({ messageId: "timer", messageType: "timer_reminder", speakerType: "timer_reminder" }),
    messageFixture({ messageId: "system" }),
    messageFixture({ messageId: "practice", participantId: "p1", speakerId: undefined, stage: "PracticeDiscussion", messageType: "human", speakerType: "human" }),
  ];
  const exportFixture = { game: { attributes: { chat_round_0: { items: representative.map((value) => ({ value })) } } } };
  for (const { value } of exportFixture.game.attributes.chat_round_0.items) {
    for (const key of ["messageId", "groupId", "roundIndex", "stage", "messageType", "speakerType", "timestamp", "sequencePosition", "content"]) {
      assert.ok(Object.hasOwn(value, key), `missing ${key}`);
    }
    assert.ok(value.participantId || value.speakerId);
    assert.equal(value.text, value.content);
    assert.equal(normalizeMessageContent(value), value.content);
  }
});
