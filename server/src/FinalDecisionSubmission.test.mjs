import assert from "node:assert/strict";
import test from "node:test";
import { acceptIndependentDecision, finalizeIndependentDecision, independentDecisionResult } from "./FinalDecisionSubmission.mjs";
import { changeDecisionResponse, validateDecisionResponse } from "../../shared/decisionSubmission.mjs";
import { personalPages, personalProgressKey } from "../../shared/personalFlow.mjs";
import { testPersonalState } from "../../shared/testMode.mjs";
import { registerPersonalFlow } from "./PersonalFlow.mjs";
import { buildRoundResponseRows } from "./SupabasePersistence.mjs";
import { describeFinalDecisionOutcome } from "./ExportService.mjs";
function scope(id, values = {}) {
  const data = new Map(Object.entries(values));
  return { id, get: (key) => data.get(key), set: (key, value) => data.set(key, value) };
}
function world(extra = {}) {
  const round = scope("r", { decisionFlowVersion: 2, decisionOptions: [{ id: "a" }, { id: "b" }], finalDecisionDeadline: 10000, FinalDecisionStartedAt: 1000, ...extra });
  const game = scope("g"), stage = scope("s", { name: "FinalDecision" });
  const players = Array.from({ length: 3 }, (_, i) => ({ ...scope(`p${i}`), round: scope(`pr${i}`), stage: scope(`ps${i}`) }));
  Object.assign(game, { players, currentRound: round, currentStage: stage });
  Object.assign(stage, { round, currentGame: game, isCurrent: () => !stage.get("ended") }); round.currentGame = game;
  for (const player of players) player.currentGame = game;
  return { game, round, stage, players };
}
function submit(w, i, changes = {}, now = 2000) {
  acceptIndependentDecision(w.players[i], { requestId: `submission-${i}`, roundId: "r", stageId: "s",
    choice: "a", confidence: 0, agreesWithGroupChoice: true, ...changes }, now);
}
const dissent = { agreesWithGroupChoice: false, finalPersonalChoice: "b", finalPersonalChoiceRationale: "  Better evidence  " };
for (const context of [{ isPractice: true }, { taskIndex: 0 }, { taskIndex: 1 }]) {
  test(`independent consensus in ${JSON.stringify(context)} allows personal dissent`, () => {
    const w = world(context); submit(w, 0, dissent);
    assert.equal(w.players[0].round.get("finalDecisionSubmission").finalPersonalChoiceRationale, "Better evidence");
    assert.equal(w.stage.get("ended"), undefined); submit(w, 1, { confidence: 100 }); submit(w, 2);
    assert.equal(w.stage.get("ended"), true); assert.equal(w.round.get("finalDecisionOutcome"), "consensus_choice");
    assert.equal(w.round.get("officialGroupFinalChoice"), "a"); assert.equal(w.players[0].round.get("agreesWithGroupChoice"), false);
    assert.equal(w.players[0].round.get("finalDecision").submittedAt, 2000);
  });
}
test("mismatched reports end immediately without agreement gating", () => {
  const w = world(); submit(w, 0); submit(w, 1, { choice: "b" }); submit(w, 2);
  assert.equal(w.round.get("finalDecisionOutcome"), "mismatch_fail"); assert.equal(w.round.get("officialGroupFinalChoice"), "FAIL");
  assert.equal(w.round.get("finalDecisionTimedOut"), false);
  assert.match(describeFinalDecisionOutcome("mismatch_fail"), /different group choices/);
  assert.match(describeFinalDecisionOutcome("declared_fail"), /did not reach/);
});
for (const count of [0, 1, 2]) test(`timeout with ${count} responses invents no submissions`, () => {
  const w = world(); for (let i = 0; i < count; i++) submit(w, i);
  assert.equal(independentDecisionResult(w.players), null);
  assert.equal(finalizeIndependentDecision(w.stage, { timedOut: true, now: 10000 }), true);
  assert.equal(w.round.get("finalDecisionOutcome"), "timeout_fail"); assert.equal(w.round.get("finalDecisionDraftChoices").length, count);
  w.players.forEach((p, i) => {
    assert.equal(Boolean(p.round.get("finalDecision")), i < count);
    assert.equal(p.round.get("groupFinalTimeoutReason"), i < count ? null : "stage_timeout");
    assert.equal(p.round.get("groupFinalSubmittedAt"), i < count ? 2000 : undefined);
  });
  assert.equal(finalizeIndependentDecision(w.stage, { timedOut: true, now: 11000 }), false);
});
test("deadline/native-end ordering rejects late requests without changing results", () => {
  for (const nativeFirst of [true, false]) {
    const w = world(); submit(w, 0); submit(w, 1);
    if (nativeFirst) finalizeIndependentDecision(w.stage, { timedOut: true, now: 10000, endStage: false });
    submit(w, 2, {}, 10000);
    assert.equal(w.round.get("finalDecisionOutcome"), "timeout_fail");
    assert.equal(w.players[2].round.get("finalDecisionSubmission"), undefined);
    assert.equal(w.players[2].round.get("finalDecisionSubmissionResult").reason, "closed");
  }
});
test("receipts survive retries and replacement attempts beyond deadline", () => {
  const w = world(); submit(w, 0); const stored = w.players[0].round.get("finalDecisionSubmission");
  submit(w, 0, { choice: "b", requestId: "different" }, 11000);
  assert.deepEqual(w.players[0].round.get("finalDecisionSubmission"), stored);
  assert.equal(w.players[0].round.get("finalDecisionSubmissionResult").status, "accepted");
  submit(w, 1); submit(w, 2); submit(w, 2, { choice: "b" }, 12000);
  assert.equal(w.round.get("finalDecisionOutcome"), "consensus_choice"); assert.equal(w.round.get("finalDecisionFinalizedAt"), 2000);
});
test("invalid and stale submissions never write answers; legacy games ignore new protocol", () => {
  for (const changes of [{ choice: "NO_GROUP_FINAL_DECISION" }, { confidence: null }, { confidence: -1 }, { confidence: 101 },
    { confidence: "50" }, { agreesWithGroupChoice: null }, { agreesWithGroupChoice: false },
    { ...dissent, finalPersonalChoiceRationale: "  " }, { ...dissent, finalPersonalChoice: "invalid" }]) {
    const w = world(); submit(w, 0, changes);
    assert.equal(w.players[0].round.get("finalDecisionSubmissionResult").status, "rejected");
    assert.equal(w.players[0].round.get("groupFinalChoice"), undefined);
  }
  for (const changes of [{ roundId: "old" }, { stageId: "old" }, { requestId: "" }]) {
    const w = world(); submit(w, 0, changes); assert.equal(w.players[0].round.get("finalDecisionSubmission"), undefined);
  }
  const w = world({ decisionFlowVersion: 1 }); submit(w, 0); assert.equal(w.players[0].round.get("finalDecisionSubmission"), undefined);
});
test("choice edits reset endorsement and Yes clears personal follow-up", () => {
  const draft = { choice: "a", confidence: 50, ...dissent };
  const changed = changeDecisionResponse(draft, "choice", "b");
  assert.equal(changed.agreesWithGroupChoice, null); assert.equal(changed.finalPersonalChoice, ""); assert.equal(changed.finalPersonalChoiceRationale, "");
  assert.deepEqual(JSON.parse(JSON.stringify(changed)), changed);
  const yes = changeDecisionResponse(draft, "agreesWithGroupChoice", true);
  assert.equal(yes.finalPersonalChoice, ""); assert.equal(yes.finalPersonalChoiceRationale, "");
  const normalized = validateDecisionResponse({ ...draft, agreesWithGroupChoice: true }, [{ id: "a" }, { id: "b" }]);
  assert.equal(normalized.response.finalPersonalChoice, null); assert.equal(normalized.response.finalPersonalChoiceRationale, null);
});
test("new follow-up and test cursors start at TLX; legacy cursors retain assessment", () => {
  for (const index of [0, 1]) assert.equal(personalPages("Followup", index, 2)[0], "TLX");
  assert.equal(personalPages("Followup", 0)[0], "IndividualAssessment");
  const w = world({ taskIndex: 0 }); w.stage.set("name", "Followup");
  const listeners = new Map(); registerPersonalFlow({ on: (_kind, key, cb) => listeners.set(key, cb), flush() {} }, () => {});
  for (const p of w.players) p.round.set(personalProgressKey("Followup"), { index: 0, startedAt: 1000 });
  const p = w.players[0]; p.round.set("tlxSurvey", { value: 50 });
  assert.equal(testPersonalState(p, w.round, w.stage).pages[0], "TLX");
  listeners.get("personalPageRequest")({}, { player: p, personalPageRequest: { roundId: "r", stageId: "s", index: 0 } });
  assert.equal(p.round.get(personalProgressKey("Followup")).index, 1);
});
test("persistence includes integrated endorsement and rationale in final response", () => {
  const w = world(); submit(w, 0, dissent);
  const rows = buildRoundResponseRows({ gameId: "g", roundId: "r", participantId: "p0", stageName: "FinalDecision", read: (key) => w.players[0].round.get(key) });
  assert.equal(rows.length, 1); assert.equal(rows[0].response_payload.agreesWithGroupChoice, false);
  assert.equal(rows[0].response_payload.finalPersonalChoice, "b"); assert.equal(rows[0].response_payload.finalPersonalChoiceRationale, "Better evidence");
  assert.ok(rows[0].submitted_at);
});

test("CSV retains mismatches, personal dissent and actual submission timestamp", async () => {
  const { renderQuestionnaireCsv } = await import("./ExportService.mjs");
  const { csv, columns } = renderQuestionnaireCsv({ game: { id: "g" }, players: [{ id: "p0" }],
    rounds: [{ id: "r", taskIndex: 0, taskVersion: "A", facilitation: "static", isPractice: false,
      officialGroupFinalChoice: "FAIL", finalDecisionOutcome: "mismatch_fail", perPlayer: { p0: {
        groupFinalChoice: "a", groupFinalSubmittedAt: 2000, agreesWithGroupChoice: false,
        finalPersonalChoice: "b", finalPersonalChoiceRationale: "Better evidence",
      } } }] });
  for (const key of ["agrees_with_group_choice", "group_final_submitted_at", "group_final_timeout_reason"]) assert.ok(columns.includes(key));
  assert.match(csv, /mismatch_fail/); assert.match(csv, /Better evidence/);
  assert.equal(csv.split('\n')[1].split(',')[columns.indexOf("agrees_with_group_choice")], "false");
});

test("registered callbacks accept independent responses and ignore legacy drafts in v2", async () => {
  const { getOfflineCallbacksHarness } = await import("../test/participant_sim/fakes/loadCallbacks.mjs");
  const { Empirica } = await getOfflineCallbacksHarness();
  const listener = (kind, key) => Empirica.attributeListeners.find((l) => l.kind === kind && l.key === key).callback;
  for (const context of [{ isPractice: true }, { taskIndex: 0 }, { taskIndex: 1 }]) {
    const w = world(context);
    listener("player", "finalDecisionDraftRequest")({}, { player: w.players[0], finalDecisionDraftRequest: { roundId: "r", stageId: "s", choice: "b", confidence: 50 } });
    assert.equal(w.players[0].round.get("groupFinalChoice"), undefined);
    w.round.set("finalDecisionDeadline", Date.now() + 90000);
    for (let i = 0; i < 3; i++) listener("player", "finalDecisionSubmitRequest")({}, {
      player: w.players[i], finalDecisionSubmitRequest: { requestId: `r-${i}`, roundId: "r", stageId: "s", choice: i === 1 ? "b" : "a", confidence: 50, agreesWithGroupChoice: true },
    });
    assert.equal(w.round.get("finalDecisionOutcome"), "mismatch_fail"); assert.equal(w.stage.get("ended"), true);
    listener("stage", "ended")({}, { stage: w.stage, ended: true });
    assert.equal(w.round.get("finalDecisionOutcome"), "mismatch_fail");
  }
});

test("test controls finish the shorter v2 Followup cursor including shared break", async () => {
  const { handleTestControl } = await import("./TestControls.mjs");
  for (const taskIndex of [0, 1]) {
    const w = world({ taskIndex }); w.stage.set("name", "Followup");
    w.game.set("testControlsEnabled", true); w.game.set("treatment", { testMode: true }); w.game.set("treatmentName", "test");
    const pages = personalPages("Followup", taskIndex, 2);
    const atBreak = taskIndex === 0;
    for (const p of w.players) p.round.set(personalProgressKey("Followup"), { index: pages.length - 1, startedAt: 1000 });
    if (atBreak) w.round.set("sharedBreakDeadline", Date.now() + 300000);
    const run = (p, action) => handleTestControl(p, { requestId: `test-${taskIndex}-${p.id}`, action,
      gameId: "g", roundId: "r", stageId: "s", index: pages.length - 1, version: 0, stageVersion: w.stage.get("testControlVersion") || 0 });
    if (atBreak) assert.equal(run(w.players[0], "skip_break").status, "accepted");
    else for (const p of w.players) assert.equal(run(p, "skip_page").status, "accepted");
    assert.equal(w.stage.get("ended"), true);
    for (const p of w.players) assert.equal(p.round.get(personalProgressKey("Followup")).index, pages.length);
  }
});

test("late independent submission cannot turn a researcher-skipped decision into a timeout", async () => {
  const { handleTestControl } = await import("./TestControls.mjs");
  const w = world();
  w.game.set("testControlsEnabled", true); w.game.set("treatment", { testMode: true }); w.game.set("treatmentName", "test");
  submit(w, 0);
  const skipped = handleTestControl(w.players[0], { requestId: "skip-decision", action: "next_stage",
    gameId: "g", roundId: "r", stageId: "s", index: 0, version: 0, stageVersion: 0 }, 3000);
  assert.equal(skipped.status, "accepted");
  submit(w, 1, {}, 11000);
  assert.equal(w.round.get("finalDecisionOutcome"), "test_skipped");
  assert.equal(w.round.get("officialGroupFinalChoice"), null);
  assert.equal(w.round.get("finalDecisionTimedOut"), false);
  assert.equal(w.players[1].round.get("finalDecisionSubmission"), undefined);
  assert.equal(finalizeIndependentDecision(w.stage, { timedOut: true, now: 12000 }), false);
  assert.equal(w.players[0].round.get("finalDecision").submittedAt, 2000);
});

test("registered legacy and v2 handlers preserve test skips against delayed requests and native end", async () => {
  const { getOfflineCallbacksHarness } = await import("../test/participant_sim/fakes/loadCallbacks.mjs");
  const { handleTestControl } = await import("./TestControls.mjs");
  const { Empirica } = await getOfflineCallbacksHarness();
  const listener = (kind, key) => Empirica.attributeListeners.find((l) => l.kind === kind && l.key === key).callback;
  for (const decisionFlowVersion of [1, 2]) for (const afterDeadline of [false, true]) {
    const w = world({ decisionFlowVersion, finalDecisionDeadline: Date.now() + (afterDeadline ? -1000 : 90000) });
    w.game.set("testControlsEnabled", true); w.game.set("treatment", { testMode: true }); w.game.set("treatmentName", "test");
    assert.equal(handleTestControl(w.players[0], { requestId: "skip", action: "next_stage", gameId: "g", roundId: "r", stageId: "s", version: 0, stageVersion: 0 }).status, "accepted");
    const key = decisionFlowVersion === 2 ? "finalDecisionSubmitRequest" : "finalDecisionDraftRequest";
    listener("player", key)({}, { player: w.players[0], [key]: { requestId: "late", roundId: "r", stageId: "s", choice: "a", confidence: 50, agreesWithGroupChoice: true } });
    listener("stage", "ended")({}, { stage: w.stage, ended: true });
    assert.equal(w.round.get("finalDecisionOutcome"), "test_skipped");
    assert.equal(w.round.get("officialGroupFinalChoice"), null);
    assert.equal(w.players[0].round.get("finalDecision"), undefined);
  }
});
