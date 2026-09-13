// Tier 1 -- deterministic, zero-LLM tests against the REAL exported pure
// functions: utils.js (evaluateGate/chooseRole/THRESHOLDS/ROLE_PRIORITY),
// CheckpointManager.mjs (shouldEvaluateCheckpoint/recordAttempt/
// recordPublish/readCheckpointState/containsFacilitatorMention),
// EvidenceChecker.js (checkEvidence), and SemanticAssessor.js
// (assessSemanticFactors, with a fake injected callLLM -- no network).
//
// No bundling, no fake game/round/stage needed here: every function under
// test already takes a plain {get,set}-shaped store or plain data, so we use
// FakeScope (fakeStore.mjs) directly as the "store" argument, exactly the
// same object shape callbacks.js passes in production (a real Game scope
// also only exposes get/set to these modules).
import { evaluateGate, chooseRole, THRESHOLDS, ROLE_PRIORITY, getRoleThreshold } from "../../src/utils.js";
import {
  shouldEvaluateCheckpoint, recordAttempt, recordPublish, readCheckpointState,
  containsFacilitatorMention, resetRoundState, CHECKPOINT_DEFAULTS,
} from "../../src/CheckpointManager.mjs";
import { checkEvidence } from "../../src/EvidenceChecker.js";
import { assessSemanticFactors } from "../../src/SemanticAssessor.js";
import { FakeScope } from "./fakes/fakeStore.mjs";

function factor(strength, { status = "present", span = "evidence span", ids = ["m0"] } = {}) {
  if (status !== "present") return { status, strength: 0, message_ids: [], span: "" };
  return { status, strength, message_ids: ids, span };
}

export async function runTier1Pure(rec) {
  console.log("\n=== Tier 1: pure decision-function tests (utils.js / CheckpointManager.mjs / EvidenceChecker.js / SemanticAssessor.js) ===");

  // ---------------------------------------------------------------- #1
  {
    const gate = evaluateGate({ breadth_deficiency: factor(0.9) }, { remainingTime: 8_000 });
    rec.record({
      id: 1, tier: 1, name: "Time floor: <10s remaining -> Abstain (evaluateGate)",
      status: gate.decision === "abstain" && gate.abstentionKind === "time_floor" ? "PASS" : "FAIL",
      expected: "decision=abstain, abstentionKind=time_floor",
      observed: gate,
    });
  }
  // Also confirm the same floor at the checkpoint-trigger layer.
  {
    const store = new FakeScope("game", { messagesSinceLastPublish: 6 });
    const res = shouldEvaluateCheckpoint({ store, humanMessageCount: 7, currentStageName: "Task", remainingTimeMs: 9_000 });
    rec.record({
      id: "1b", tier: 1, name: "Time floor: <10s remaining -> shouldEvaluateCheckpoint blocks (CheckpointManager)",
      status: res.trigger === false && res.reason.startsWith("time_floor") ? "PASS" : "FAIL",
      expected: "trigger=false, reason starts with time_floor", observed: res,
    });
  }

  // ---------------------------------------------------------------- #2
  {
    const store = new FakeScope("game", { messagesSinceLastPublish: 6 });
    let last;
    for (let i = 1; i <= 4; i++) {
      last = shouldEvaluateCheckpoint({ store, humanMessageCount: i, currentStageName: "Task", remainingTimeMs: 120_000, now: i * 100_000 });
      if (last.trigger) recordAttempt(store, i, i * 100_000);
    }
    rec.record({
      id: 2, tier: 1, name: "Attempt cap: 4th automatic attempt after 3 already attempted -> blocked",
      status: last.trigger === false && last.reason.startsWith("cap_reached") ? "PASS" : "FAIL",
      expected: "4th trigger=false, reason starts with cap_reached", observed: last,
    });
  }

  // ---------------------------------------------------------------- #3
  {
    const store = new FakeScope("game", { messagesSinceLastPublish: 6 });
    const t0 = 1_000_000;
    const first = shouldEvaluateCheckpoint({ store, humanMessageCount: 1, currentStageName: "Task", remainingTimeMs: 120_000, now: t0 });
    recordAttempt(store, 1, t0);
    const second = shouldEvaluateCheckpoint({ store, humanMessageCount: 2, currentStageName: "Task", remainingTimeMs: 120_000, now: t0 + 5_000 });
    rec.record({
      id: 3, tier: 1, name: "Cooldown: two triggers within 30s -> second Abstains",
      status: first.trigger === true && second.trigger === false && second.reason.startsWith("cooldown") ? "PASS" : "FAIL",
      expected: "first trigger=true, second trigger=false reason cooldown", observed: { first, second },
    });
  }

  // ---------------------------------------------------------------- #4
  {
    const store = new FakeScope("game", { messagesSinceLastPublish: 3 });
    const blocked = shouldEvaluateCheckpoint({ store, humanMessageCount: 1, currentStageName: "Task", remainingTimeMs: 120_000, now: 0 });
    recordAttempt(store, 1, 0); // failed attempt: attempted but not published
    const stillBlocked = shouldEvaluateCheckpoint({ store, humanMessageCount: 2, currentStageName: "Task", remainingTimeMs: 120_000, now: 40_000 });
    const stateAfterFail = readCheckpointState(store);
    rec.record({
      id: 4, tier: 1, name: "Opportunity gate: <6 msgs since last publish -> Abstain; failed attempt does not reset the counter",
      status: blocked.trigger === false && blocked.reason.startsWith("opportunity_gate")
        && stillBlocked.trigger === false && stillBlocked.reason.startsWith("opportunity_gate")
        && stateAfterFail.messagesSinceLastPublish === 3
        ? "PASS" : "FAIL",
      expected: "both blocked by opportunity_gate; messagesSinceLastPublish stays 3 after a failed (non-published) attempt",
      observed: { blocked, stillBlocked, messagesSinceLastPublishAfterFail: stateAfterFail.messagesSinceLastPublish },
    });
  }

  // ---------------------------------------------------------------- #5
  {
    const store = new FakeScope("game", { messagesSinceLastPublish: 6 });
    const first = shouldEvaluateCheckpoint({ store, humanMessageCount: 5, currentStageName: "Task", remainingTimeMs: 120_000, now: 0 });
    recordAttempt(store, 5, 0);
    const dupe = shouldEvaluateCheckpoint({ store, humanMessageCount: 5, currentStageName: "Task", remainingTimeMs: 120_000, now: 1_000_000 });
    rec.record({
      id: 5, tier: 1, name: "Dedup: same checkpoint (humanMessageCount) evaluated twice -> no double-fire",
      status: first.trigger === true && dupe.trigger === false && dupe.reason.startsWith("dedup") ? "PASS" : "FAIL",
      expected: "first trigger=true, re-evaluation of same humanMessageCount trigger=false reason dedup",
      observed: { first, dupe },
    });
  }

  // ---------------------------------------------------------------- #6
  {
    const marker = containsFacilitatorMention("@[Facilitator] can you help?");
    const noMarker = containsFacilitatorMention("no mention here");
    // (a) bypasses time floor
    const storeA = new FakeScope("game", { messagesSinceLastPublish: 0 });
    const a = shouldEvaluateCheckpoint({ store: storeA, humanMessageCount: 1, currentStageName: "Task", remainingTimeMs: 5_000, isMentionCheckpoint: true });
    // (b) bypasses cap: 3 attempts already recorded
    const storeB = new FakeScope("game", { messagesSinceLastPublish: 0 });
    for (let i = 1; i <= 3; i++) recordAttempt(storeB, i, i);
    const b = shouldEvaluateCheckpoint({ store: storeB, humanMessageCount: 4, currentStageName: "Task", remainingTimeMs: 120_000, isMentionCheckpoint: true });
    // (c) bypasses cooldown
    const storeC = new FakeScope("game", {});
    recordAttempt(storeC, 1, 1_000);
    const c = shouldEvaluateCheckpoint({ store: storeC, humanMessageCount: 2, currentStageName: "Task", remainingTimeMs: 120_000, now: 1_500, isMentionCheckpoint: true });
    // (d) bypasses opportunity gate
    const storeD = new FakeScope("game", { messagesSinceLastPublish: 1 });
    const d = shouldEvaluateCheckpoint({ store: storeD, humanMessageCount: 1, currentStageName: "Task", remainingTimeMs: 120_000, isMentionCheckpoint: true });
    // (e) does NOT bypass dedup
    const storeE = new FakeScope("game", { messagesSinceLastPublish: 6 });
    shouldEvaluateCheckpoint({ store: storeE, humanMessageCount: 9, currentStageName: "Task", remainingTimeMs: 120_000, isMentionCheckpoint: true });
    recordAttempt(storeE, 9, 0);
    const e = shouldEvaluateCheckpoint({ store: storeE, humanMessageCount: 9, currentStageName: "Task", remainingTimeMs: 120_000, isMentionCheckpoint: true });
    const ok = marker === true && noMarker === false && a.trigger && b.trigger && c.trigger && d.trigger && e.trigger === false && e.reason.startsWith("dedup");
    rec.record({
      id: 6, tier: 1, name: "@-mention bypasses time floor/cap/cooldown/opportunity-gate but NOT dedup",
      status: ok ? "PASS" : "FAIL",
      expected: "a/b/c/d all trigger=true under otherwise-blocking conditions; e (dedup) still trigger=false",
      observed: { markerDetected: marker, noMarker, a, b, c, d, e },
    });
  }

  // ---------------------------------------------------------------- #7
  {
    const points = [0.34, 0.35, 0.36];
    const expanderResults = points.map((s) => evaluateGate({ breadth_deficiency: factor(s) }, { remainingTime: 120_000 }));
    const expanderOk = expanderResults[0].decision !== "specialist" && expanderResults[1].decision === "specialist" && expanderResults[2].decision === "specialist";
    const challengerResults = [0.59, 0.60, 0.61].map((s) => evaluateGate({
      group_preference: factor(s), justification_deficiency: factor(s),
    }, { remainingTime: 120_000 }));
    const challengerOk = challengerResults[0].decision !== "specialist" && challengerResults[1].decision === "specialist" && challengerResults[2].decision === "specialist";
    const synthResults = [0.59, 0.60, 0.61].map((s) => evaluateGate({ integration_deficiency: factor(s) }, { remainingTime: 120_000 }));
    const synthOk = synthResults[0].decision !== "specialist" && synthResults[1].decision === "specialist" && synthResults[2].decision === "specialist";
    rec.record({
      id: 7, tier: 1, name: "Threshold boundaries: expander@0.35, challenger/synthesiser@0.6",
      status: expanderOk && challengerOk && synthOk ? "PASS" : "FAIL",
      expected: "below threshold != specialist; at/above threshold == specialist, for all three roles",
      observed: { expander: expanderResults.map((r) => r.decision), challenger: challengerResults.map((r) => r.decision), synthesiser: synthResults.map((r) => r.decision), THRESHOLDS },
    });
  }

  // ---------------------------------------------------------------- #8
  {
    // In-band: expander raw score higher than challenger, gap <= 0.20 -> frozen
    // priority (challenger > synthesiser > expander) must override raw score.
    const inBand = evaluateGate({
      breadth_deficiency: factor(0.70),
      group_preference: factor(0.62), justification_deficiency: factor(0.62),
    }, { remainingTime: 120_000 });
    // Out-of-band: gap > 0.20 -> plain top score (expander) wins even though
    // it is the LOWEST-priority role.
    const outOfBand = evaluateGate({
      breadth_deficiency: factor(0.90),
      integration_deficiency: factor(0.65),
    }, { remainingTime: 120_000 });
    const ok = inBand.decision === "specialist" && inBand.chosenRole === "challenger"
      && outOfBand.decision === "specialist" && outOfBand.chosenRole === "expander";
    rec.record({
      id: 8, tier: 1, name: "Tie-break: within 0.20 margin -> priority order wins; outside margin -> raw top score wins",
      status: ok ? "PASS" : "FAIL",
      expected: "in-band gap(0.08)->challenger (priority beats higher-scoring expander); out-of-band gap(0.25)->expander (raw top score, no priority override)",
      observed: { inBand: { chosenRole: inBand.chosenRole, scores: inBand.scores }, outOfBand: { chosenRole: outOfBand.chosenRole, scores: outOfBand.scores }, margin: THRESHOLDS.gate.margin, priority: ROLE_PRIORITY },
    });
  }

  // ---------------------------------------------------------------- #9
  {
    const chat = [
      { messageId: "raw0", text: "The group has only discussed transit options for Rovenna so far.", sender: { id: "p-green" } },
      { messageId: "raw1", text: "We are self-correcting by looking at other factors now.", sender: { id: "p-blue" } },
    ];
    const raw = {
      breadth_deficiency: factor(0.5, { span: "only discussed transit options for Rovenna", ids: ["m0"] }),
      self_correction: factor(0.9, { span: "self-correcting by looking at other factors", ids: ["m1"] }),
    };
    const checked = checkEvidence(raw, { chat });
    const withoutDiscount = evaluateGate({ breadth_deficiency: factor(0.5) }, { remainingTime: 120_000 });
    const withDiscount = evaluateGate(checked, { remainingTime: 120_000 });
    const ok = withoutDiscount.decision === "specialist" && withDiscount.decision !== "specialist"
      && checked.breadth_deficiency.selfCorrectionDiscounted === true
      && checked.breadth_deficiency.strength < 0.5;
    rec.record({
      id: 9, tier: 1, name: "Self-correction discount flips an otherwise-clear specialist decision to Generalist/Abstain",
      status: ok ? "PASS" : "FAIL",
      expected: "same raw breadth_deficiency=0.5 is 'specialist' alone but drops below threshold (and gate decision changes) once self_correction=0.9 discounts it",
      observed: { withoutDiscount: withoutDiscount.decision, withDiscount: withDiscount.decision, discountedStrength: checked.breadth_deficiency.strength, discountFlag: checked.breadth_deficiency.selfCorrectionDiscounted },
    });
  }

  // ---------------------------------------------------------------- #10
  {
    const gateA = evaluateGate({ integration_deficiency: factor(0.65) }, { remainingTime: 15_000 });
    const chosenA = chooseRole(gateA, { remainingTime: 15_000, synthesiserFired: false });
    const gateB = evaluateGate({ breadth_deficiency: factor(0.9) }, { remainingTime: 15_000 });
    const chosenB = chooseRole(gateB, { remainingTime: 15_000, synthesiserFired: false });
    let abstainThrew = false;
    try {
      chooseRole({ decision: "abstain", reason: "no need" }, { remainingTime: 15_000, synthesiserFired: false });
    } catch (e) { abstainThrew = true; }
    const ok = chosenA.role === "synthesiser" && chosenA.forced === true
      && chosenB.role !== "synthesiser"
      && abstainThrew === true;
    rec.record({
      id: 10, tier: 1, name: "Forced wrap-up nudge (<=20s): fires only when Synthesiser independently eligible; cannot override an Abstain (regression)",
      status: ok ? "PASS" : "FAIL",
      expected: "synthesiser-eligible case -> forced synthesiser; synthesiser-ineligible case -> no forced synthesiser; chooseRole() on an Abstain gate throws rather than emitting a role",
      observed: { chosenA, chosenB, abstainThrew },
    });
  }

  // ---------------------------------------------------------------- #11
  {
      const badGateNull = evaluateGate(null, { remainingTime: 120_000 });
      const badGateUndefined = evaluateGate(undefined, { remainingTime: 120_000 });
      const apiErr = await assessSemanticFactors({ chat: [], taskGeneralContext: "x", callLLM: async () => ({ success: false, error: "network down" }) });
      const parseErr = await assessSemanticFactors({ chat: [], taskGeneralContext: "x", callLLM: async () => ({ success: true, rawText: "not json at all" }) });
      const schemaErr = await assessSemanticFactors({ chat: [], taskGeneralContext: "x", callLLM: async () => ({ success: true, rawText: "{}" }) });
      const gateFromApiErr = evaluateGate(apiErr.success ? apiErr.factors : null, { remainingTime: 120_000 });
      const ok = badGateNull.decision === "abstain" && badGateUndefined.decision === "abstain"
        && apiErr.success === false && parseErr.success === false && schemaErr.success === false
        && gateFromApiErr.decision === "abstain";
      rec.record({
        id: 11, tier: 1, name: "Fail-closed: malformed/missing Assessor output -> Abstain, never crashes, never fabricates a role",
        status: ok ? "PASS" : "FAIL",
        expected: "null/undefined checkedFactors -> abstain; API/parse/schema failures all return success:false; abstain never proposes a role",
        observed: { badGateNull: badGateNull.decision, badGateUndefined: badGateUndefined.decision, apiErr: apiErr.code, parseErr: parseErr.code, schemaErr: schemaErr.code },
      });
  }

  // ---------------------------------------------------------------- #12
  {
    const chat = [{ messageId: "raw0", text: "Talwick has a frequent direct rail service to the venue district.", sender: { id: "p-green" } }];
    const raw = { breadth_deficiency: factor(0.8, { span: "this exact phrase is fabricated and never appears", ids: ["m0"] }) };
    const checked = checkEvidence(raw, { chat });
    const gate = evaluateGate({ breadth_deficiency: checked.breadth_deficiency }, { remainingTime: 120_000 });
    const ok = checked.breadth_deficiency.status === "uncertain"
      && checked.breadth_deficiency.downgradedReason === "SPAN_NOT_FOUND_IN_CITED_MESSAGES"
      && checked.breadth_deficiency.strength === 0
      && gate.decision !== "specialist";
    rec.record({
      id: 12, tier: 1, name: "Evidence Checker: fabricated/non-verbatim span -> downgraded to uncertain, role selection reflects it",
      status: ok ? "PASS" : "FAIL",
      expected: "status=uncertain, downgradedReason=SPAN_NOT_FOUND_IN_CITED_MESSAGES, strength=0, and evaluateGate no longer treats it as specialist-eligible",
      observed: { checkedFactor: checked.breadth_deficiency, gateDecision: gate.decision },
    });
  }

  // ---------------------------------------------------------------- #13
  {
    const chat = [
      { messageId: "raw0", text: "I really think Rovenna is best for the whole group here.", sender: { id: "p-green" } },
      { messageId: "raw1", text: "Rovenna is best, restating my point again.", sender: { id: "p-green" } },
    ];
    const raw = { group_preference: factor(0.9, { span: "Rovenna is best", ids: ["m0", "m1"] }) };
    const checked = checkEvidence(raw, { chat });
    const ok = checked.group_preference.status === "uncertain" && checked.group_preference.downgradedReason === "GROUP_PREFERENCE_SINGLE_PARTICIPANT_ONLY";
    rec.record({
      id: 13, tier: 1, name: "Evidence Checker: group_preference cited from the same participant twice -> rejected, not counted",
      status: ok ? "PASS" : "FAIL",
      expected: "status=uncertain, downgradedReason=GROUP_PREFERENCE_SINGLE_PARTICIPANT_ONLY",
      observed: checked.group_preference,
    });
  }
}
