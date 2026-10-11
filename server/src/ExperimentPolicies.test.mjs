import test from "node:test";
import assert from "node:assert/strict";
import {
  allFinalDecisionConfirmationsMatch,
  classifyFinalDecision,
  FACILITATOR_ROLES,
  MESSAGE_TYPES,
  NO_GROUP_FINAL_DECISION,
  allocateSequencePosition,
  buildCanonicalMessage,
  normalizeMessageContent,
  reviewFinalDecisionConfirmation,
  reviewHumanMessageRequest,
  summarizeFinalDecisionDrafts,
} from "./ExperimentPolicies.mjs";

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

function decisionLifecycleFixture({ practice = false, taskIndex = 0 } = {}) {
  const deadline = 90_000;
  const players = ["p1", "p2", "p3"].map((participantId) => ({
    participantId,
    choice: "",
    confidence: null,
    confirmedChoice: null,
  }));
  const state = {
    practice,
    taskIndex,
    finalDecisionConfirmed: false,
    finalDecisionOutcome: null,
    finalDecisionTimedOut: false,
    officialGroupFinalChoice: null,
    stageEnded: false,
    transitionCount: 0,
    finalizedCount: 0,
    finalResponses: [],
  };
  const finalize = ({ timedOut = false, nativeStageAlreadyEnded = false } = {}) => {
    if (state.finalDecisionConfirmed) return false;
    const summary = summarizeFinalDecisionDrafts(players);
    if (!timedOut && (summary.status !== "agreed"
      || !allFinalDecisionConfirmationsMatch(players, summary.matchedChoice))) return false;
    const classification = classifyFinalDecision(summary.matchedChoice, { timedOut });
    state.finalDecisionConfirmed = true;
    state.finalDecisionOutcome = classification.outcome;
    state.finalDecisionTimedOut = classification.timedOut;
    state.officialGroupFinalChoice = classification.officialChoice;
    state.finalizedCount += 1;
    state.finalResponses = players.map(({ participantId, choice, confidence }) => ({
      participantId,
      choice,
      confidence,
      finalDecisionOutcome: classification.outcome,
    }));
    if (!nativeStageAlreadyEnded && !state.stageEnded) {
      state.stageEnded = true;
      state.transitionCount += 1;
    }
    return true;
  };
  const draft = (participantId, choice, confidence, now) => {
    if (state.finalDecisionConfirmed) return;
    if (now >= deadline) {
      finalize({ timedOut: true });
      return;
    }
    const player = players.find((item) => item.participantId === participantId);
    const choiceChanged = player.choice !== choice;
    player.choice = choice;
    player.confidence = confidence;
    if (choiceChanged) players.forEach((item) => { item.confirmedChoice = null; });
  };
  const confirm = (participantId, choice, now) => {
    if (state.finalDecisionConfirmed) return;
    if (now >= deadline) {
      finalize({ timedOut: true });
      return;
    }
    const review = reviewFinalDecisionConfirmation({ drafts: players, participantId, requestChoice: choice });
    if (!review.accepted) return;
    players.find((item) => item.participantId === participantId).confirmedChoice = review.matchedChoice;
    finalize();
  };
  const nativeStageEnd = () => {
    if (!state.stageEnded) {
      state.stageEnded = true;
      state.transitionCount += 1;
    }
    finalize({ timedOut: true, nativeStageAlreadyEnded: true });
  };
  return { deadline, players, state, draft, confirm, nativeStageEnd, finalize };
}

function submitMatchingDrafts(fixture, choice = "A") {
  fixture.players.forEach((player, index) => fixture.draft(player.participantId, choice, index * 50, 1_000));
}

test("FinalDecision deadline sequences finalize once and cannot overwrite the authoritative result", () => {
  const before = decisionLifecycleFixture();
  submitMatchingDrafts(before);
  before.confirm("p1", "A", before.deadline - 3);
  before.confirm("p2", "A", before.deadline - 2);
  before.confirm("p3", "A", before.deadline - 1);
  before.nativeStageEnd();
  before.confirm("p3", "A", before.deadline + 1);
  assert.equal(before.state.finalDecisionOutcome, "consensus_choice");
  assert.equal(before.state.finalizedCount, 1);
  assert.equal(before.state.transitionCount, 1);
  assert.equal(before.state.finalResponses.length, 3);

  const exact = decisionLifecycleFixture();
  submitMatchingDrafts(exact);
  exact.confirm("p1", "A", exact.deadline - 2);
  exact.confirm("p2", "A", exact.deadline - 1);
  exact.confirm("p3", "A", exact.deadline);
  assert.equal(exact.state.finalDecisionOutcome, "timeout_fail");
  assert.equal(exact.state.finalizedCount, 1);

  const after = decisionLifecycleFixture();
  submitMatchingDrafts(after);
  after.confirm("p1", "A", after.deadline - 2);
  after.confirm("p2", "A", after.deadline - 1);
  after.confirm("p3", "A", after.deadline + 1);
  assert.equal(after.state.finalDecisionOutcome, "timeout_fail");
  assert.equal(after.state.finalizedCount, 1);
});

test("FinalDecision native-end/late-request order and duplicate callbacks remain idempotent", () => {
  const nativeFirst = decisionLifecycleFixture();
  submitMatchingDrafts(nativeFirst);
  nativeFirst.nativeStageEnd();
  nativeFirst.confirm("p1", "A", nativeFirst.deadline + 1);
  nativeFirst.nativeStageEnd();
  assert.equal(nativeFirst.state.finalDecisionOutcome, "timeout_fail");
  assert.equal(nativeFirst.state.finalizedCount, 1);
  assert.equal(nativeFirst.state.transitionCount, 1);

  const requestFirst = decisionLifecycleFixture();
  submitMatchingDrafts(requestFirst);
  requestFirst.confirm("p1", "A", requestFirst.deadline + 1);
  requestFirst.nativeStageEnd();
  requestFirst.finalize({ timedOut: true });
  assert.equal(requestFirst.state.finalDecisionOutcome, "timeout_fail");
  assert.equal(requestFirst.state.finalizedCount, 1);
  assert.equal(requestFirst.state.transitionCount, 1);
  assert.equal(requestFirst.state.finalResponses.length, 3);
});

test("FinalDecision duplicates, changed drafts, conflicts, and explicit failure preserve outcome rules", () => {
  const duplicate = decisionLifecycleFixture();
  submitMatchingDrafts(duplicate);
  duplicate.confirm("p1", "A", 2_000);
  duplicate.confirm("p1", "A", 2_001);
  duplicate.confirm("p2", "A", 2_002);
  duplicate.confirm("p3", "A", 2_003);
  duplicate.confirm("p3", "A", 2_004);
  assert.equal(duplicate.state.finalDecisionOutcome, "consensus_choice");
  assert.equal(duplicate.state.finalizedCount, 1);

  const changed = decisionLifecycleFixture();
  submitMatchingDrafts(changed);
  changed.confirm("p1", "A", 2_000);
  changed.confirm("p2", "A", 2_001);
  changed.draft("p3", "B", 100, 2_002);
  assert.ok(changed.players.every((player) => player.confirmedChoice === null));
  changed.nativeStageEnd();
  assert.equal(changed.state.finalDecisionOutcome, "timeout_fail");

  const conflict = decisionLifecycleFixture();
  conflict.draft("p1", "A", 0, 1_000);
  conflict.draft("p2", "B", 50, 1_000);
  conflict.draft("p3", "A", 100, 1_000);
  conflict.nativeStageEnd();
  assert.equal(conflict.state.finalDecisionOutcome, "timeout_fail");

  const declared = decisionLifecycleFixture();
  submitMatchingDrafts(declared, NO_GROUP_FINAL_DECISION);
  declared.players.forEach((player, index) => declared.confirm(
    player.participantId,
    NO_GROUP_FINAL_DECISION,
    3_000 + index,
  ));
  assert.equal(declared.state.finalDecisionOutcome, "declared_fail");
  assert.equal(declared.state.finalizedCount, 1);
});

test("Practice and both formal rounds share the same FinalDecision boundary policy and route by outcome", () => {
  for (const context of [
    { practice: true, taskIndex: null },
    { practice: false, taskIndex: 0 },
    { practice: false, taskIndex: 1 },
  ]) {
    const consensus = decisionLifecycleFixture(context);
    submitMatchingDrafts(consensus);
    consensus.players.forEach((player, index) => consensus.confirm(player.participantId, "A", 1_000 + index));
    assert.equal(consensus.state.finalDecisionOutcome, "consensus_choice");
    assert.equal(context.practice ? "PracticeComplete" : "TLX",
      context.practice ? "PracticeComplete" : consensus.state.finalDecisionOutcome === "consensus_choice" ? "TLX" : "IndividualAssessment");

    const timeout = decisionLifecycleFixture(context);
    timeout.nativeStageEnd();
    assert.equal(timeout.state.finalDecisionOutcome, "timeout_fail");
    assert.equal(context.practice ? "PracticeComplete" : "IndividualAssessment",
      context.practice ? "PracticeComplete" : timeout.state.finalDecisionOutcome === "consensus_choice" ? "TLX" : "IndividualAssessment");
  }
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

test("canonical Facilitator messages preserve generated role provenance and request identity", () => {
  const generatedRoles = [
    FACILITATOR_ROLES.STATIC,
    FACILITATOR_ROLES.GENERALIST,
    FACILITATOR_ROLES.INFORMATION_EXPANDER,
    FACILITATOR_ROLES.EVIDENCE_CHALLENGER,
    FACILITATOR_ROLES.INFORMATION_SYNTHESISER,
  ];
  for (const role of generatedRoles) {
    const message = messageFixture({
      messageId: `facilitator-${role}`,
      speakerId: "ai",
      messageType: MESSAGE_TYPES.FACILITATOR,
      speakerType: MESSAGE_TYPES.FACILITATOR,
      role,
      facilitatorOrigin: "LLM_GENERATED",
      facilitatorTrigger: "AUTOMATIC_CHECKPOINT",
      auditRequestId: `audit-${role}`,
    });
    assert.equal(message.role, role);
    assert.equal(message.facilitatorOrigin, "LLM_GENERATED");
    assert.equal(message.facilitatorTrigger, "AUTOMATIC_CHECKPOINT");
    assert.equal(message.auditRequestId, `audit-${role}`);
  }
});

test("canonical Facilitator messages preserve fixed and non-LLM fallback provenance", () => {
  const fixed = messageFixture({
    messageId: "facilitator-nudge-r1-1",
    speakerId: "ai",
    role: FACILITATOR_ROLES.FIXED_MESSAGE,
    facilitatorOrigin: "DETERMINISTIC_FIXED",
    facilitatorTrigger: "DISCUSSION_OPENING",
  });
  assert.equal(fixed.role, "FIXED_MESSAGE");
  assert.equal(fixed.facilitatorTrigger, "DISCUSSION_OPENING");
  assert.equal(Object.hasOwn(fixed, "auditRequestId"), false);

  const fallback = messageFixture({
    messageId: "facilitator-fallback-r1-2",
    speakerId: "ai",
    role: FACILITATOR_ROLES.NON_LLM_FALLBACK,
    facilitatorOrigin: "NON_LLM_FALLBACK",
    facilitatorTrigger: "PARTICIPANT_REQUEST",
    auditRequestId: "audit-fallback",
  });
  assert.equal(fallback.role, "NON_LLM_FALLBACK");
  assert.equal(fallback.auditRequestId, "audit-fallback");
});
