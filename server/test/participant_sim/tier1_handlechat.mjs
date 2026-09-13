// Tier 1 continued -- mechanical/timing scenarios (2 confirmation, 40-43)
// that live specifically in callbacks.js's handleChat message-filtering /
// orchestration layer rather than in a standalone pure function. These
// drive the REAL handleChat via the offline bundle (fakes/loadCallbacks.mjs)
// so every gating branch executes authentic code, but the injected LLM
// endpoint is unreachable-by-design (see loadCallbacks.mjs) so this costs
// zero API budget: every assertion here is about whether a checkpoint was
// gated in/out, never about generated text.
//
// A key mechanical fact, confirmed empirically while building this file:
// `messagesSinceLastPublish` / `humanMessageCount` are incremented by
// handleChat ITSELF, once per invocation -- NOT by how many messages exist
// in the chat array. So "clearing the opportunity gate" requires calling
// fireCheckpoint() once per chat message, exactly as a real Tajriba
// attribute-change subscription would (one event per mutation), not just
// appending N messages and firing once.
//
// IMPORTANT: this file also surfaces a real bug (see TEST_REPORT.md,
// "Bugs Found #1"): finalizeAuditLog crashes for every checkpoint that does
// NOT trigger, because callbacks.js only assigns `logEntry.auditRequestId`
// on the triggered branch, but InFlightAudit.mjs's appendLog() requires a
// non-empty `entry.id` (= auditRequestId) unconditionally. Empirica's real
// dispatcher swallows this (try/catch around every attribute-listener
// invocation), so the game never crashes -- but it also means llmLog never
// records a NOT-triggered checkpoint's reason in production, contradicting
// README.md / PILOT_PREP.md's operator guidance to inspect those reasons.
// gameHarness.fireCheckpoint() mirrors Empirica's real error boundary
// (catches and records to world.checkpointErrors) so this doesn't abort the
// run; every scenario below still verifies its OWN outcome via committed
// game-store state (readCheckpointState), which is written before the
// crash occurs and is therefore unaffected by it.
import { readCheckpointState, recordPublish } from "../../src/CheckpointManager.mjs";
import { getOfflineHandleChat } from "./fakes/loadCallbacks.mjs";
import { makeTaskWorld, setRemainingMs, sendHuman, sendRawMessage, fireCheckpoint, getLlmLog } from "./fakes/gameHarness.mjs";
import { buildCanonicalMessage, MESSAGE_TYPES } from "../../src/ExperimentPolicies.mjs";

// Send + fire N filler messages, each as its own handleChat invocation, to
// move messagesSinceLastPublish/humanMessageCount forward without any of
// them triggering (stays below the 6-message opportunity gate as long as
// n <= 5). Mirrors exactly how a real discussion's early messages behave.
async function clearToJustBelowGate(world, handleChat, n = 5) {
  for (let i = 0; i < n; i++) {
    sendHuman(world, ["Green", "Blue", "Pink"][i % 3], `Filler message ${i} about the task materials.`);
    await fireCheckpoint(handleChat, world);
  }
}

export async function runTier1HandleChat(rec) {
  console.log("\n=== Tier 1 (continued): real handleChat() driven via offline (unreachable-LLM) bundle -- zero API cost ===");
  const handleChat = await getOfflineHandleChat();

  // ---------------------------------------------------------------- #2 (confirmation via the real orchestrator)
  {
    const world = makeTaskWorld({ facilitation: "static", remainingMs: 5 * 60_000 });
    await clearToJustBelowGate(world, handleChat, 5);
    // 4 more messages, each with lastAttemptTimestamp backdated first so the
    // 30s wall-clock cooldown (irrelevant to what THIS scenario tests) never
    // masks the attempt-cap behaviour we actually want to isolate. Since no
    // publish ever succeeds against the unreachable offline endpoint,
    // messagesSinceLastPublish only ever grows, so the opportunity gate
    // never re-blocks either -- only the 3-attempt cap can stop message #4.
    for (let i = 0; i < 4; i++) {
      world.game.set("lastAttemptTimestamp", Date.now() - 60_000);
      sendHuman(world, "Blue", `Round-robin message ${i} requesting more discussion.`);
      await fireCheckpoint(handleChat, world);
    }
    const state = readCheckpointState(world.game);
    rec.record({
      id: "2-confirm", tier: 1, name: "Attempt cap enforced by the real handleChat(): 4th attempt (after 3) is blocked",
      status: state.attemptedThisRound === 3 ? "PASS" : "FAIL",
      expected: "attemptedThisRound stops at 3 even though a 4th checkpoint was offered (cooldown deliberately defeated so only the cap is being measured)",
      observed: { attemptedThisRound: state.attemptedThisRound, checkpointErrorsThisScenario: world.checkpointErrors.length },
      notes: "The 3 blocked-by-cap-or-not attempts that did NOT trigger hit the known audit-log bug (Bug #1) internally; attemptedThisRound is read from committed store state written before that crash, so this assertion is unaffected by it.",
    });
  }

  // ---------------------------------------------------------------- #40
  {
    const world = makeTaskWorld({ facilitation: "static", remainingMs: 5 * 60_000 });
    await clearToJustBelowGate(world, handleChat, 5);
    // 5 messages "within 2 seconds": in real wall-clock terms these 5
    // fireCheckpoint calls execute back-to-back (a few ms apart), which is
    // exactly the real mechanism the 30s cooldown must reject.
    for (let i = 0; i < 5; i++) {
      sendHuman(world, ["Blue", "Pink"][i % 2], `Burst message ${i} about Rovenna hotel capacity.`);
      await fireCheckpoint(handleChat, world);
    }
    const state = readCheckpointState(world.game);
    rec.record({
      id: 40, tier: 1, name: "Rapid burst: 5 messages within ~2s real time -> exactly ONE checkpoint evaluated",
      status: state.attemptedThisRound === 1 ? "PASS" : "FAIL",
      expected: "attemptedThisRound === 1 (the message that fills the 6-message gate triggers; the next 4, milliseconds later, are cooldown-blocked)",
      observed: { attemptedThisRound: state.attemptedThisRound, lastAttemptTimestamp: state.lastAttemptTimestamp },
    });
  }

  // ---------------------------------------------------------------- #41
  {
    const world = makeTaskWorld({ facilitation: "adaptive", remainingMs: 5 * 60_000 });
    await clearToJustBelowGate(world, handleChat, 5);
    setRemainingMs(world, 8_000); // 8s left: below the 10s floor, right as the 6th message would otherwise satisfy the opportunity gate
    sendHuman(world, "Blue", "We absolutely must compare Rovenna and Meridia on cost and transit RIGHT NOW, this is urgent and unresolved!");
    await fireCheckpoint(handleChat, world);
    const state = readCheckpointState(world.game);
    rec.record({
      id: 41, tier: 1, name: "Strong-trigger content at 8s remaining -> Abstain on time regardless of content",
      status: state.attemptedThisRound === 0 ? "PASS" : "FAIL",
      expected: "attemptedThisRound stays 0 -- the time floor blocks before any content is ever read by a detector, even though the opportunity gate would otherwise have just been satisfied",
      observed: { attemptedThisRound: state.attemptedThisRound, remainingMsAtTrigger: 8000 },
    });
  }

  // ---------------------------------------------------------------- #42
  {
    const world = makeTaskWorld({ facilitation: "adaptive", remainingMs: 5 * 60_000 });
    // Simulate "a fresh published intervention" via the real recordPublish
    // (exactly what a successful runSharedGeneration() call does to game
    // state) so we can test the post-publish cooldown/opportunity-gate
    // interaction without spending a real LLM call to get there.
    recordPublish(world.game, { role: "GENERALIST", messageId: "sim-published-1", now: Date.now() });
    const before = getLlmLog(world).length;
    sendHuman(world, "Pink", "Thanks Facilitator. Following up 10 seconds later with a normal message.");
    await fireCheckpoint(handleChat, world); // ordinary message: should be blocked (opportunity gate: only 1 msg since publish)
    const stateBlocked = readCheckpointState(world.game);
    sendHuman(world, "Pink", "@[Facilitator] can you weigh in on this specific point right away?");
    await fireCheckpoint(handleChat, world); // @-mention: should bypass and actually run the pipeline
    const after = getLlmLog(world).length;
    const ok = stateBlocked.attemptedThisRound === 0 && after > before;
    rec.record({
      id: 42, tier: 1, name: "10s after a fresh publish: ordinary message blocked by opportunity-gate/cooldown; @-mention bypasses it",
      status: ok ? "PASS" : "FAIL",
      expected: "ordinary follow-up: attemptedThisRound stays 0 (blocked); @-mention follow-up: a real (triggered) llmLog entry is written",
      observed: { attemptedThisRoundAfterOrdinary: stateBlocked.attemptedThisRound, llmLogEntriesBefore: before, llmLogEntriesAfterMention: after },
    });
  }

  // ---------------------------------------------------------------- #43
  {
    const world = makeTaskWorld({ facilitation: "static", remainingMs: 5 * 60_000 });
    await clearToJustBelowGate(world, handleChat, 5);
    let canonicalRejectedEmpty = false;
    try {
      buildCanonicalMessage({
        messageId: "empty-1", groupId: world.game.id, participantId: "p-blue", roundIndex: 0,
        stage: "Discussion", messageType: MESSAGE_TYPES.HUMAN, speakerType: MESSAGE_TYPES.HUMAN,
        timestamp: Date.now(), sequencePosition: 99, content: "   ",
        sender: { id: "p-blue", name: "Blue" },
      });
    } catch (e) { canonicalRejectedEmpty = true; }
    const beforeCount = readCheckpointState(world.game).humanMessageCount;
    // A real client can never produce this (buildCanonicalMessage rejects
    // empty content upstream, confirmed above) -- append the raw shape
    // directly to see whether handleChat's OWN filtering (isFormalHumanMessage,
    // which checks messageType/speakerType/stage only, not content) would
    // also have caught it if some other future code path ever bypassed the
    // canonical builder.
    sendRawMessage(world, {
      messageId: "raw-empty-1", sender: { id: "p-blue", name: "Blue" }, messageType: "human",
      speakerType: "human", stage: "Discussion", content: "   ", text: "   ", timestamp: Date.now(),
    });
    await fireCheckpoint(handleChat, world);
    const afterCount = readCheckpointState(world.game).humanMessageCount;
    const wouldHaveTriggeredAsHumanMessage = afterCount > beforeCount;
    rec.record({
      id: 43, tier: 1, name: "Empty/whitespace-only message never reaches checkpoint logic",
      status: canonicalRejectedEmpty ? "OBSERVED" : "FAIL",
      expected: "the real message-construction path (buildCanonicalMessage) refuses empty content outright, so no real client can ever get an empty message into the chat array in the first place",
      observed: { canonicalBuilderRejectsEmptyContent: canonicalRejectedEmpty, humanMessageCountBefore: beforeCount, humanMessageCountAfterRawEmptyAppend: afterCount },
      notes: wouldHaveTriggeredAsHumanMessage
        ? "GAP: handleChat's own isFormalHumanMessage() checks messageType/speakerType/stage only -- it does not itself reject empty/whitespace content. If a raw message bypasses buildCanonicalMessage entirely (not possible via any current human-facing code path in this repo), handleChat would still count it as a human message. Defense-in-depth gap, not a live bug given today's single message-construction path."
        : "handleChat itself also declined to treat the raw empty message as a formal human message (no additional gap found).",
    });
  }
}
