import test from "node:test";
import assert from "node:assert/strict";
import {
  canConfirmBreak,
  canFinalizeBreak,
  allFinalDecisionConfirmationsMatch,
  classifyFinalDecision,
  MESSAGE_TYPES,
  NO_GROUP_FINAL_DECISION,
  allocateSequencePosition,
  buildCanonicalMessage,
  isFreshFinalDecisionDraftRequest,
  isCurrentFinalDecisionConfirmation,
  normalizeMessageContent,
  reviewHumanMessageRequest,
  summarizeFinalDecisionDrafts,
} from "./ExperimentPolicies.mjs";

const breakEnd = 1_000_000;

test("T32-T33: readiness opens exactly 45 seconds before the scheduled end", () => {
  assert.equal(canConfirmBreak(breakEnd, breakEnd - 45_001), false);
  assert.equal(canConfirmBreak(breakEnd, breakEnd - 45_000), true);
});

test("Break can finalize only after its minimum duration and full-group readiness", () => {
  assert.equal(canFinalizeBreak(breakEnd, breakEnd - 1, true), false);
  assert.equal(canFinalizeBreak(breakEnd, breakEnd, false), false);
  assert.equal(canFinalizeBreak(breakEnd, breakEnd, true), true);
});

test("FinalDecision accepts only well-formed, strictly newer private draft requests", () => {
  const request = { requestId: "draft-2", requestedAt: 2_000 };
  assert.equal(isFreshFinalDecisionDraftRequest(request, null), true);
  assert.equal(isFreshFinalDecisionDraftRequest(request, 1_999), true);
  assert.equal(isFreshFinalDecisionDraftRequest(request, 2_000), false);
  assert.equal(isFreshFinalDecisionDraftRequest(request, 2_001), false);
  assert.equal(isFreshFinalDecisionDraftRequest({ ...request, requestId: "" }, null), false);
  assert.equal(isFreshFinalDecisionDraftRequest({ ...request, requestedAt: "invalid" }, null), false);
});

test("FinalDecision rejects confirmations from an earlier agreement revision", () => {
  assert.equal(isCurrentFinalDecisionConfirmation({ agreementRevision: 3 }, 3), true);
  assert.equal(isCurrentFinalDecisionConfirmation({ agreementRevision: 2 }, 3), false);
  assert.equal(isCurrentFinalDecisionConfirmation({ agreementRevision: "3" }, 3), true);
  assert.equal(isCurrentFinalDecisionConfirmation({ agreementRevision: -1 }, 0), false);
  assert.equal(isCurrentFinalDecisionConfirmation({}, 0), false);
});

test("FinalDecision requires exactly three identical non-empty drafts", () => {
  assert.deepEqual(summarizeFinalDecisionDrafts([{ choice: "A" }, { choice: "A" }, { choice: "A" }]), { status: "agreed", matchedChoice: "A" });
  assert.deepEqual(summarizeFinalDecisionDrafts([{ choice: "A" }, { choice: "B" }, { choice: "A" }]), { status: "not_agreed", matchedChoice: null });
  assert.deepEqual(summarizeFinalDecisionDrafts([{ choice: "A" }, { choice: "A" }, { choice: "" }]), { status: "not_agreed", matchedChoice: null });
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

test("R9/R13: IceBreaker uses the same reviewed request boundary with isolated classification", () => {
  const result = reviewHumanMessageRequest({ ...baseRequestContext, request, currentStageName: "Introduction", deadline: undefined });
  assert.equal(result.accepted, true);
  assert.equal(result.attribute, "intro_round_0");
  assert.equal(result.stage, "IceBreaker");

  const secondRound = reviewHumanMessageRequest({
    ...baseRequestContext,
    request: { ...request, roundId: "r2" },
    currentRoundId: "r2",
    currentRoundIndex: 1,
    currentStageName: "Introduction",
    deadline: undefined,
  });
  assert.equal(secondRound.attribute, "intro_round_1");
  assert.notEqual(secondRound.attribute, result.attribute);
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

test("R13/D6: canonical human/facilitator/timer/system/IceBreaker messages satisfy the export fixture contract", () => {
  const representative = [
    messageFixture({ messageId: "human", participantId: "p1", speakerId: undefined, messageType: "human", speakerType: "human" }),
    messageFixture({ messageId: "facilitator", speakerId: "ai", messageType: "facilitator", speakerType: "facilitator" }),
    messageFixture({ messageId: "timer", messageType: "timer_reminder", speakerType: "timer_reminder" }),
    messageFixture({ messageId: "system" }),
    messageFixture({ messageId: "ice", participantId: "p1", speakerId: undefined, stage: "IceBreaker", messageType: "human", speakerType: "human" }),
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
