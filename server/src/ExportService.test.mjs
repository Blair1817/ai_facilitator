import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  ExportService,
  redactGameBundle,
  renderQuestionnaireCsv,
  renderTranscriptMd,
  ExportNotFoundError,
} from "./ExportService.mjs";
import { recordExportEvent } from "./ExportAudit.mjs";

/**
 * Build a fake Tajriba admin connection. The store is a flat map
 *   scopeId -> { id, kind, attributes: [{ key, value, index? }] }
 * and the connection paginates the result of `scopes({filter,first})`
 * by walking the store in memory. The filter `{ids, kinds, kvs}` is
 * honoured; `kvs` values are matched against `JSON.stringify(stored)`
 * for simplicity (this matches how Tajriba emits them).
 */
function makeMockAdmin(scopes) {
  const all = Object.values(scopes);
  // Apply one ScopedAttributesInput against a scope list. The production
  // admin rejects a filter object that uses more than one of
  // {kinds, ids, kvs, names, keys}; the mock mirrors that by matching on
  // whichever axis is present.
  function applyOne(scopeList, filter) {
    if (!filter) return scopeList;
    let out = scopeList;
    if (Array.isArray(filter.kinds) && filter.kinds.length > 0) {
      out = out.filter((s) => filter.kinds.includes(s.kind));
    }
    if (Array.isArray(filter.ids) && filter.ids.length > 0) {
      out = out.filter((s) => filter.ids.includes(s.id));
    }
    if (Array.isArray(filter.kvs) && filter.kvs.length > 0) {
      out = out.filter((s) =>
        filter.kvs.every(({ key, val }) =>
          (s.attributes || []).some((a) => {
            if (a.key !== key) return false;
            // Tajriba emits `val` as a JSON string; the fixture's `attr`
            // helper stores scalars as strings and objects as JSON strings.
            // Compare against the stored raw value as a string.
            return a.value === val;
          }),
        ),
      );
    }
    return out;
  }
  return {
    scopes: async ({ filter, first = 100, after = null } = {}) => {
      // Tajriba v1.12 takes `filter` as `[ScopedAttributesInput!]`; the
      // service normalises the single-object shorthand before calling us.
      // Each entry is AND-ed.
      const filterList = Array.isArray(filter) ? filter : filter == null ? [] : [filter];
      let matched = all;
      for (const f of filterList) {
        matched = applyOne(matched, f);
      }
      const startIdx = after ? matched.findIndex((s) => s.id === after) + 1 : 0;
      const end = startIdx + first;
      const slice = matched.slice(startIdx, end);
      return {
        edges: slice.map((node) => ({ node, cursor: node.id })),
        pageInfo: {
          hasNextPage: end < matched.length,
          endCursor: slice.length > 0 ? slice[slice.length - 1].id : null,
        },
      };
    },
  };
}

function attr(scope, key, value) {
  // Build a per-scope attribute list. We store the original value
  // verbatim so Tajriba's `JSON.stringify(value)` convention is
  // matched when tests put strings into kvs.
  scope.attributes.push({ key, value: typeof value === "string" ? value : JSON.stringify(value) });
  return scope;
}

function attrIndexed(scope, key, index, value) {
  // Model a Tajriba *vector* attribute (written via `game.append`):
  // one Attribute record per element, sharing `key` and distinguished
  // by `index`. This is how `chat_round_N` actually appears in the
  // admin `scopes` response.
  scope.attributes.push({ key, index, value: typeof value === "string" ? value : JSON.stringify(value) });
  return scope;
}

function attrVersioned(scope, key, version, value, opts = {}) {
  // Model a scalar attribute that was `game.set` more than once: each
  // version is its own record, the live one is `current: true` (or the
  // highest `version`), and superseded ones carry `deleted`/`deletedAt`.
  scope.attributes.push({ key, version, value: typeof value === "string" ? value : JSON.stringify(value), ...opts });
  return scope;
}

function makeScope(id, kind, builder = () => {}) {
  const scope = { id, kind, attributes: [] };
  builder(scope);
  return scope;
}

const T = (v) => JSON.stringify(v);

/**
 * Realistic post-migration fixture: one batch, one game, three players, one
 * technical Practice / Orientation round, and two formal research rounds.
 * Players have submitted initial / final decisions, a per-round TLX and
 * subjective survey, the end-of-game final questions, and a chat log
 * with a facilitator intervention. The game also has a bounded llmLog
 * with one PUBLISHED entry and one INTERRUPTED entry.
 */
function fixture() {
  const batch = makeScope("BATCH1", "batch", (s) => {
    attr(s, "status", "ended");
    attr(s, "treatment", { name: "main", gameDuration: 10, phase1Duration: 2 });
    attr(s, "createdAt", "2026-08-15T10:00:00+08:00");
  });
  const game = makeScope("GAME1", "game", (s) => {
    attr(s, "batchID", T("BATCH1"));
    attr(s, "status", "ended");
    attr(s, "treatment", { gameDuration: 10, phase1Duration: 2 });
    attr(s, "treatmentName", "main");
    attr(s, "sequenceId", "S2");
    attr(s, "startedAt", "2026-08-15T10:05:00+08:00");
    attr(s, "endedAt", "2026-08-15T10:45:00+08:00");
    attr(s, "totalInterventions", 4);
    attr(s, "totalFallbackMessages", 1);
    attr(s, "systemInfo", { model: "MiniMax-Text-01", thresholds: { abstain: 0.4 } });
    attr(s, "llmLogIndex", ["R1", "R2"]);
    attr(s, "llmLog.R1", {
      id: "R1", auditRequestId: "R1", outcome: "PUBLISHED", role: "Expander",
      reason: "", requestSuccess: true, messageAdded: true,
      totalLatencyMs: 2400, humanMessageCountAtCompletion: 6, responseContextDriftMessages: 0,
      auditCompletedAt: 1723705200000,
      agentState: { cumulativeContext: "internal-only-payload" },
    });
    attr(s, "llmLog.R2", {
      id: "R2", auditRequestId: "R2", outcome: "INTERRUPTED_CALLBACKS_RESTART",
      reason: "Callbacks process ended before this checkpoint wrote a terminal audit record",
      requestSuccess: false, messageAdded: false,
      totalLatencyMs: null, auditCompletedAt: 1723705500000,
    });
    attr(s, "chat_round_0", [
      { text: "I think we should focus on cost first.", sender: { id: "p1", name: "Red" }, ts: 1723705200000 },
      { text: "Why cost?", sender: { id: "p2", name: "Pink" }, ts: 1723705210000 },
      { text: "Consider the trade-offs across all options.", sender: { id: "ai", name: "Facilitator" }, ts: 1723705220000, role: "Expander" },
    ]);
    attr(s, "chat_round_1", [
      { text: "Formal Round 2 evidence.", sender: { id: "p3", name: "Blue" }, ts: 1723705600000 },
    ]);
    attr(s, "chat_round_2", [
      { text: "POISON NATIVE-INDEX TRANSCRIPT", sender: { id: "p2", name: "Pink" }, ts: 1723705700000 },
    ]);
    attr(s, "practice_icebreaker_chat", [
      { text: "Practice-only answer.", sender: { id: "p1", name: "Red" }, ts: 1723705000000 },
    ]);
  });
  const participantSpecs = [
    { id: "p1", name: "Red", initialOffset: 1 },
    { id: "p2", name: "Pink", initialOffset: 2 },
    { id: "p3", name: "Blue", initialOffset: 3 },
  ];
  const players = participantSpecs.map(({ id, name }) =>
    makeScope(id, "player", (s) => {
      attr(s, "gameID", T("GAME1"));
      attr(s, "name", name);
      attr(s, "introDone", true);
      attr(s, "ended", "debriefing");
      attr(s, `playerRoundID-PRACTICE`, T(`PR-PRACTICE-${id}`));
      attr(s, `playerRoundID-R0`, T(`PR-R0-${id}`));
      attr(s, `playerRoundID-R1`, T(`PR-R1-${id}`));
      attr(s, "finalQuestions", {
        submissionId: `${id}:1723705900000`,
        firstTaskCarryover: id === "p1" ? "yes" : "no",
        firstTaskCarryoverDescription: id === "p1"
          ? "I noticed Red focused on cost; that shaped my second task."
          : "",
        facilitatorDifference: id === "p1" ? 5 : 3,
        preferredFacilitator: id === "p1" ? "second_task" : "first_task",
        submittedAt: 1723705900000,
      });
      attr(s, "expFeedback", {
        submissionId: `${id}:1723705950000`,
        expFeedback: id === "p1"
          ? "Study was clear; my email is researcher@example.com if you need more."
          : `${id} feedback`,
        submittedAt: 1723705950000,
      });
    }),
  );
  const playerRounds = [];
  for (const { id, initialOffset } of participantSpecs) {
    playerRounds.push(makeScope(`PR-PRACTICE-${id}`, "playerRound", (s) => {
      attr(s, "gameID", T("GAME1"));
      attr(s, "roundID", T("PRACTICE"));
      attr(s, "playerID", T(id));
      attr(s, "initialChoice", `POISON-PRACTICE-${id}`);
      attr(s, "tlxSurvey", { tlxMentalDemand: 99 });
      attr(s, "subjectiveSurvey", { groupFreeText: `POISON-PRACTICE-${id}` });
    }));
    playerRounds.push(makeScope(`PR-R0-${id}`, "playerRound", (s) => {
      attr(s, "gameID", T("GAME1"));
      attr(s, "roundID", T("R0"));
      attr(s, "playerID", T(id));
      attr(s, "reviewQuizPassed", true);
      attr(s, "initialChoice", `${id}-r0-choice`);
      attr(s, "initialConfidence", 60 + initialOffset);
      attr(s, "initialDecision", { choice: `${id}-r0-choice`, confidence: 60 + initialOffset, submittedAt: 1000 + initialOffset });
      attr(s, "finalDecision", { choice: "OPT1", confidence: 70 + initialOffset, submittedAt: 2000 + initialOffset, finalDecisionOutcome: "consensus_choice" });
      attr(s, "groupFinalChoice", "OPT1");
      attr(s, "groupChoiceConfidence", 70 + initialOffset);
      attr(s, "groupFinalConfirmedChoice", "OPT1");
      attr(s, "tlxSurvey", {
        tlxMentalDemand: 10 + initialOffset,
        tlxPhysicalDemand: 20 + initialOffset,
        tlxTemporalDemand: 30 + initialOffset,
        tlxPerformance: 40 + initialOffset,
        tlxEffort: 50 + initialOffset,
        tlxFrustration: 60 + initialOffset,
        submittedAt: 3000 + initialOffset,
      });
      attr(s, "subjectiveSurvey", {
        groupFreeText: `${id}-r0-subjective`,
        groupContribution: String(initialOffset),
        groupInfluence: "3",
        groupProductive: "4",
        groupStructured: "5",
        groupCohesion: "same",
        facilitatorGroupFreetext: `${id}-r0-facilitator`,
        facilitatorSharing: "4",
        facilitatorDistracting: "2",
        facilitatorSynthesis: "4",
        facilitatorFocus: "5",
        facilitatorNeedFit: "4",
        facilitatorTimingAppropriateness: "4",
        facilitatorOptionPush: "1",
      });
    }));
    playerRounds.push(makeScope(`PR-R1-${id}`, "playerRound", (s) => {
      attr(s, "gameID", T("GAME1"));
      attr(s, "roundID", T("R1"));
      attr(s, "playerID", T(id));
      attr(s, "reviewQuizPassed", true);
      attr(s, "initialChoice", `${id}-r1-choice`);
      attr(s, "initialConfidence", 80 + initialOffset);
      attr(s, "initialDecision", { choice: `${id}-r1-choice`, confidence: 80 + initialOffset, submittedAt: 4000 + initialOffset });
      attr(s, "finalDecision", { choice: "NO_GROUP_FINAL_DECISION", confidence: 50 + initialOffset, submittedAt: 5000 + initialOffset, finalDecisionOutcome: "declared_fail" });
      attr(s, "groupFinalChoice", "NO_GROUP_FINAL_DECISION");
      attr(s, "groupChoiceConfidence", 50 + initialOffset);
      attr(s, "groupFinalConfirmedChoice", "NO_GROUP_FINAL_DECISION");
      attr(s, "finalPersonalChoice", `${id}-r1-personal`);
      attr(s, "finalPersonalChoiceConfidence", 90 + initialOffset);
      attr(s, "finalPersonalChoiceRationale", `${id}-r1-rationale`);
      attr(s, "agreesWithGroupChoice", null);
      attr(s, "tlxSurvey", {
        tlxMentalDemand: 70 + initialOffset,
        tlxPhysicalDemand: 71 + initialOffset,
        tlxTemporalDemand: 72 + initialOffset,
        tlxPerformance: 73 + initialOffset,
        tlxEffort: 74 + initialOffset,
        tlxFrustration: 75 + initialOffset,
        submittedAt: 6000 + initialOffset,
      });
      attr(s, "subjectiveSurvey", {
        groupFreeText: `${id}-r1-subjective`,
        groupContribution: String(initialOffset + 1),
        groupInfluence: "2",
        groupProductive: "3",
        groupStructured: "4",
        groupCohesion: "random",
        facilitatorGroupFreetext: `${id}-r1-facilitator`,
        facilitatorSharing: "3",
        facilitatorDistracting: "1",
        facilitatorSynthesis: "3",
        facilitatorFocus: "4",
        facilitatorNeedFit: "3",
        facilitatorTimingAppropriateness: "3",
        facilitatorOptionPush: "2",
      });
    }));
  }
  const rounds = [
    makeScope("PRACTICE", "round", (s) => {
      attr(s, "gameID", T("GAME1"));
      attr(s, "index", 0);
      attr(s, "isPractice", true);
    }),
    makeScope("R0", "round", (s) => {
      attr(s, "gameID", T("GAME1"));
      attr(s, "index", 1);
      attr(s, "taskIndex", 0);
      attr(s, "taskVersion", "A");
      attr(s, "facilitation", "adaptive");
      attr(s, "finalDecisionOutcome", "consensus_choice");
      attr(s, "finalDecisionMatchedChoice", "OPT1");
      attr(s, "finalDecisionConfirmed", true);
    }),
    makeScope("R1", "round", (s) => {
      attr(s, "gameID", T("GAME1"));
      attr(s, "index", 2);
      attr(s, "taskIndex", 1);
      attr(s, "taskVersion", "B");
      attr(s, "facilitation", "static");
      attr(s, "finalDecisionOutcome", "declared_fail");
      attr(s, "finalDecisionMatchedChoice", "NO_GROUP_FINAL_DECISION");
      attr(s, "finalDecisionConfirmed", true);
    }),
  ];
  const scopes = Object.fromEntries([batch, game, ...rounds, ...players, ...playerRounds].map((scope) => [scope.id, scope]));
  return { scopes, game, batch, players, rounds, playerRounds };
}

function legacyTwoRoundFixture() {
  const fx = fixture();
  delete fx.scopes.PRACTICE;
  fx.rounds = fx.rounds.slice(1);
  fx.rounds.forEach((round, index) => {
    const indexAttribute = round.attributes.find((attribute) => attribute.key === "index");
    indexAttribute.value = JSON.stringify(index);
  });
  fx.game.attributes = fx.game.attributes.filter((attribute) => attribute.key !== "practice_icebreaker_chat");
  return fx;
}

function service({ scopes, auditFile } = {}) {
  const fx = scopes || fixture().scopes;
  return new ExportService({ admin: makeMockAdmin(fx), auditFile, defaultRedact: true });
}

test("listBatches returns each batch with playerCount and gameCount", async () => {
  const svc = service();
  const batches = await svc.listBatches();
  assert.equal(batches.length, 1);
  assert.equal(batches[0].id, "BATCH1");
  assert.equal(batches[0].treatment, "main");
  assert.equal(batches[0].status, "ended");
  assert.equal(batches[0].gameCount, 1);
  assert.equal(batches[0].playerCount, 3);
});

test("listGames filters by treatment and respects limit/offset", async () => {
  const svc = service();
  const all = await svc.listGames("BATCH1", { limit: 10, offset: 0 });
  assert.equal(all.items.length, 1);
  assert.equal(all.total, 1);
  assert.equal(all.items[0].treatment, "main");
  assert.equal(all.items[0].sequenceId, "S2");
  assert.equal(all.items[0].playerCount, 3);
  const gameTreatment = await svc.listGames("BATCH1", { treatment: "main" });
  assert.equal(gameTreatment.items.length, 1);
  const roundFacilitation = await svc.listGames("BATCH1", { treatment: "static" });
  assert.equal(roundFacilitation.items.length, 0);
});

test("getGameBundle assembles players, rounds, and the bounded LLM log", async () => {
  const fx = fixture();
  const svc = service({ scopes: fx.scopes });
  const bundle = await svc.getGameBundle("GAME1");
  assert.equal(bundle.game.id, "GAME1");
  assert.equal(bundle.game.batchId, "BATCH1");
  assert.equal(bundle.game.treatment, "main");
  assert.equal(bundle.players.length, 3);
  assert.equal(bundle.players[0].name, "Blue", "players should be sorted by name");
  assert.equal(bundle.rounds.length, 2);
  assert.deepEqual(await svc.gameRoundIDs("GAME1"), ["PRACTICE", "R0", "R1"], "technical reconstruction remains ordered by native index");
  const reconstructedPractice = await svc.readRound(fx.rounds[0], bundle.players);
  assert.equal(reconstructedPractice.nativeIndex, 0);
  assert.equal(reconstructedPractice.taskIndex, null, "a missing practice taskIndex must remain absent");
  assert.equal(reconstructedPractice.index, null, "practice must not acquire formal Round 1 identity");
  assert.equal(reconstructedPractice.isPractice, true);
  assert.equal(bundle.rounds[0].index, 0);
  assert.equal(bundle.rounds[0].nativeIndex, 1);
  assert.equal(bundle.rounds[0].taskIndex, 0);
  assert.equal(bundle.rounds[0].facilitation, "adaptive");
  assert.equal(bundle.rounds[1].index, 1);
  assert.equal(bundle.rounds[1].nativeIndex, 2);
  assert.equal(bundle.rounds[1].taskIndex, 1);
  assert.equal(bundle.rounds[1].facilitation, "static");
  assert.ok(bundle.rounds.every((round) => round.id !== "PRACTICE"));
  assert.equal(bundle.rounds[0].finalDecisionOutcome, "consensus_choice");
  assert.equal(bundle.rounds[1].finalDecisionOutcome, "declared_fail");
  assert.equal(bundle.llmLog.length, 2);
  assert.equal(bundle.llmLog[0].auditRequestId, "R1");
  assert.equal(bundle.llmLog[1].outcome, "INTERRUPTED_CALLBACKS_RESTART");
});

test("getGameBundle resolves each formal response through the player's exact playerRound link", async () => {
  const fx = fixture();
  const bundle = await service({ scopes: fx.scopes }).getGameBundle("GAME1");
  const [round0, round1] = bundle.rounds;

  for (const playerId of ["p1", "p2", "p3"]) {
    assert.equal(round0.perPlayer[playerId].playerRoundId, `PR-R0-${playerId}`);
    assert.equal(round1.perPlayer[playerId].playerRoundId, `PR-R1-${playerId}`);
    assert.equal(round0.perPlayer[playerId].initialChoice, `${playerId}-r0-choice`);
    assert.equal(round1.perPlayer[playerId].initialChoice, `${playerId}-r1-choice`);
    assert.equal(round0.perPlayer[playerId].subjectiveSurvey.groupFreeText, `${playerId}-r0-subjective`);
    assert.equal(round1.perPlayer[playerId].subjectiveSurvey.groupFreeText, `${playerId}-r1-subjective`);
    assert.equal(round0.perPlayer[playerId].finalDecision.finalDecisionOutcome, "consensus_choice");
    assert.equal(round1.perPlayer[playerId].finalDecision.finalDecisionOutcome, "declared_fail");
    assert.equal(round1.perPlayer[playerId].finalPersonalChoice, `${playerId}-r1-personal`);
    assert.equal(round1.perPlayer[playerId].finalPersonalChoiceRationale, `${playerId}-r1-rationale`);
  }

  assert.ok(!JSON.stringify(bundle.rounds).includes("POISON-PRACTICE"));
});

test("a missing playerRound link produces missing data without borrowing another response", async () => {
  const fx = fixture();
  fx.scopes.p2.attributes = fx.scopes.p2.attributes.filter((attribute) => attribute.key !== "playerRoundID-R1");
  const bundle = await service({ scopes: fx.scopes }).getGameBundle("GAME1");
  const round1 = bundle.rounds.find((round) => round.taskIndex === 1);
  assert.equal(round1.perPlayer.p2.playerRoundId, null);
  assert.equal(round1.perPlayer.p2.initialChoice, null);
  assert.equal(round1.perPlayer.p2.tlxSurvey, null);
  assert.equal(round1.perPlayer.p2.subjectiveSurvey, null);
  assert.equal(round1.perPlayer.p2.finalDecision, null);
  assert.equal(round1.perPlayer.p1.initialChoice, "p1-r1-choice");
  assert.equal(round1.perPlayer.p3.initialChoice, "p3-r1-choice");
});

test("getGameBundle throws ExportNotFoundError for an unknown game", async () => {
  const svc = service();
  await assert.rejects(() => svc.getGameBundle("NOPE"), (err) => err instanceof ExportNotFoundError);
});

test("renderQuestionnaireCsv produces one row per player per round plus an end-of-game row", async () => {
  const svc = service();
  const { csv, columns, rowCount } = await svc.renderQuestionnaireCsv("GAME1", { redact: true });
  assert.equal(rowCount, 3 * 2 + 3, "3 players × 2 rounds + 3 end-of-game rows");
  // Sanity: header is the documented column order and includes both
  // per-round and end-of-game forms.
  assert.ok(columns.includes("tlx_mental"));
  assert.ok(columns.includes("review_quiz_passed"));
  assert.ok(columns.includes("first_task_carryover"));
  assert.ok(columns.includes("exp_feedback"));
  // Default redact must have replaced the email in p1's expFeedback.
  assert.match(csv, /\[REDACTED_EMAIL\]/);
  assert.ok(!csv.includes("researcher@example.com"));
  // No raw LLM prompt should appear in the CSV (it lives in the bundle zip only).
  assert.ok(!csv.includes("internal-only-payload"));
  assert.ok(!csv.includes("PRACTICE"));
  const csvLines = csv.trimEnd().split("\n");
  const roundIndexColumn = columns.indexOf("round_index");
  const slotColumn = columns.indexOf("slot");
  const perRoundIndexes = csvLines.slice(1)
    .map((line) => line.split(","))
    .filter((cells) => cells[slotColumn] === "per_round")
    .map((cells) => cells[roundIndexColumn]);
  assert.deepEqual([...new Set(perRoundIndexes)].sort(), ["0", "1"]);
  assert.equal(perRoundIndexes.length, 6, "three participants must each have exactly two formal questionnaire rows");
  const playerColumn = columns.indexOf("player_id");
  const taskIndexColumn = columns.indexOf("task_index");
  const initialChoiceColumn = columns.indexOf("initial_choice");
  const tlxMentalColumn = columns.indexOf("tlx_mental");
  const subjectiveTextColumn = columns.indexOf("subjective_group_free_text");
  const finalChoiceColumn = columns.indexOf("final_decision_choice");
  const finalOutcomeColumn = columns.indexOf("final_decision_outcome");
  const parsedPerRoundRows = csvLines.slice(1)
    .map((line) => line.split(","))
    .filter((cells) => cells[slotColumn] === "per_round");
  const rowFor = (playerId, taskIndex) => parsedPerRoundRows.find(
    (cells) => cells[playerColumn] === playerId && cells[taskIndexColumn] === String(taskIndex),
  );
  for (const playerId of ["p1", "p2", "p3"]) {
    const round0 = rowFor(playerId, 0);
    const round1 = rowFor(playerId, 1);
    assert.equal(round0[initialChoiceColumn], `${playerId}-r0-choice`);
    assert.equal(round1[initialChoiceColumn], `${playerId}-r1-choice`);
    assert.ok(round0[tlxMentalColumn]);
    assert.ok(round1[tlxMentalColumn]);
    assert.equal(round0[subjectiveTextColumn], `${playerId}-r0-subjective`);
    assert.equal(round1[subjectiveTextColumn], `${playerId}-r1-subjective`);
    assert.equal(round0[finalChoiceColumn], "OPT1");
    assert.equal(round1[finalChoiceColumn], "NO_GROUP_FINAL_DECISION");
    assert.equal(round0[finalOutcomeColumn], "consensus_choice");
    assert.equal(round1[finalOutcomeColumn], "declared_fail");
  }
  assert.ok(!csv.includes("POISON-PRACTICE"));
  assert.match(csv, /I noticed Red focused on cost/);
  assert.match(csv, /p2 feedback/);
  for (const line of csv.trimEnd().split("\n").slice(1)) {
    const [gameId, batchId, treatment, sequenceId, startedAt, endedAt] = line.split(",", 6);
    assert.equal(gameId, "GAME1");
    assert.equal(batchId, "BATCH1");
    assert.equal(treatment, "main");
    assert.equal(sequenceId, "S2");
    assert.equal(startedAt, "2026-08-15T10:05:00+08:00");
    assert.equal(endedAt, "2026-08-15T10:45:00+08:00");
  }
});

test("renderQuestionnaireCsv with redact:false keeps the raw text", async () => {
  const svc = service();
  const { csv } = await svc.renderQuestionnaireCsv("GAME1", { redact: false });
  assert.ok(csv.includes("researcher@example.com"));
});

test("renderTranscriptMd emits one section per round and a final LLM audit log section", async () => {
  const svc = service();
  const { markdown } = await svc.renderTranscriptMd("GAME1", { redact: true });
  assert.match(markdown, /^# Game GAME1/m);
  assert.match(markdown, /- Treatment: main/);
  assert.match(markdown, /- Ended: 2026-08-15T10:45:00\+08:00/);
  assert.doesNotMatch(markdown, /- Ended: \(in progress\)/);
  assert.match(markdown, /## Round 1 · Task 1/);
  assert.match(markdown, /## Round 2 · Task 2/);
  assert.doesNotMatch(markdown, /## Round 3|Practice \/ Orientation|Practice-only answer/);
  assert.doesNotMatch(markdown, /POISON NATIVE-INDEX TRANSCRIPT/);
  assert.match(markdown, /## LLM audit log \(2 entries\)/);
  assert.match(markdown, /Red.*focus on cost first/);
  assert.match(markdown, /Facilitator.*Expander/);
  assert.match(markdown, /Blue.*Formal Round 2 evidence/);
  // Default redact must strip the email from the expFeedback mention
  // when it ends up in the bundle (transcript does not embed
  // expFeedback today, so this is a defensive check).
  assert.ok(!markdown.includes("researcher@example.com"));
});

test("legacy games containing only two formal rounds retain their existing export identities", async () => {
  const fx = legacyTwoRoundFixture();
  const svc = service({ scopes: fx.scopes });
  const bundle = await svc.getGameBundle("GAME1");
  assert.deepEqual(bundle.rounds.map(({ index, nativeIndex, taskIndex }) => ({ index, nativeIndex, taskIndex })), [
    { index: 0, nativeIndex: 0, taskIndex: 0 },
    { index: 1, nativeIndex: 1, taskIndex: 1 },
  ]);
  const { markdown } = await svc.renderTranscriptMd("GAME1", { redact: true });
  assert.match(markdown, /Red.*focus on cost first/);
  assert.match(markdown, /Blue.*Formal Round 2 evidence/);
});

test("renderTranscriptMd reconstructs vector chat_round_N from indexed attributes", async () => {
  const fx = fixture();
  const game = fx.game;
  // Replace the single-array chat_round_0 with the production vector
  // shape: one indexed attribute per appended message.
  game.attributes = game.attributes.filter((a) => a.key !== "chat_round_0");
  attrIndexed(game, "chat_round_0", 0, { text: "I think we should focus on cost first.", sender: { id: "p1", name: "Red" }, ts: 1723705200000 });
  attrIndexed(game, "chat_round_0", 1, { text: "Why cost?", sender: { id: "p2", name: "Pink" }, ts: 1723705210000 });
  attrIndexed(game, "chat_round_0", 2, { text: "Consider the trade-offs across all options.", sender: { id: "ai", name: "Facilitator" }, ts: 1723705220000, role: "Expander" });

  const svc = service({ scopes: fx.scopes });
  const { markdown } = await svc.renderTranscriptMd("GAME1", { redact: true });
  assert.match(markdown, /Red.*focus on cost first/);
  assert.match(markdown, /Pink.*Why cost\?/);
  assert.match(markdown, /Facilitator.*Expander/);
});

test("renderTranscriptMd reads the current version of a multi-version scalar", async () => {
  const fx = fixture();
  const game = fx.game;
  // Replace the single totalInterventions with three versioned records in a
  // deliberately non-chronological edge order: the superseded v1/v2 come after
  // the live v3, so a naive "last wins" would keep v1 ("0") instead of 2.
  game.attributes = game.attributes.filter((a) => a.key !== "totalInterventions");
  attrVersioned(game, "totalInterventions", 3, 2, { current: true });
  attrVersioned(game, "totalInterventions", 1, 0, { deleted: true });
  attrVersioned(game, "totalInterventions", 2, 1, { deletedAt: "2026-08-20T06:35:21Z" });

  const svc = service({ scopes: fx.scopes });
  const { markdown } = await svc.renderTranscriptMd("GAME1", { redact: true });
  assert.match(markdown, /- Total interventions: 2/);
  assert.ok(!markdown.includes("- Total interventions: 0"));
});

test("redactGameBundle replaces PII in submitted forms and LLM audit", async () => {
  const fx = fixture();
  const svc = service({ scopes: fx.scopes });
  const bundle = await svc.getGameBundle("GAME1");
  const redacted = redactGameBundle(bundle);
  // players are sorted by name, so the email-bearing Red is the last one
  const red = redacted.players.find((p) => p.name === "Red");
  assert.ok(red, "Red should be in the player list");
  assert.match(red.expFeedback.expFeedback, /\[REDACTED_EMAIL\]/);
  // LLM log agentState was an arbitrary string; PII inside it should be
  // scrubbed (the fixture's payload contains no PII so this is just a
  // structural check).
  assert.deepEqual(redacted.llmLog[0].agentState, bundle.llmLog[0].agentState);
});

test("ExportService writeGameBundle produces a valid ZIP and records the audit entry", async () => {
  const fx = fixture();
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "export-bundle-"));
  const auditFile = path.join(tmpDir, "audit.jsonl");
  const outFile = path.join(tmpDir, "bundle.zip");
  const svc = new ExportService({ admin: makeMockAdmin(fx.scopes) });

  const output = fs.createWriteStream(outFile);
  const { bytes, sha256, files } = await svc.writeGameBundle("GAME1", { redact: true, output });
  await new Promise((resolve) => output.on("close", resolve));
  assert.ok(bytes > 0, "bundle must not be empty");
  assert.equal(sha256.length, 64);
  assert.deepEqual(files, ["questionnaire.csv", "transcript.md", "meta.json", "llm-audit.jsonl"]);
  const meta = JSON.parse(execFileSync("unzip", ["-p", outFile, "meta.json"], { encoding: "utf8" }));
  assert.equal(meta.batchId, "BATCH1");
  assert.deepEqual(meta.rounds.map(({ id, index, nativeIndex, taskIndex }) => ({ id, index, nativeIndex, taskIndex })), [
    { id: "R0", index: 0, nativeIndex: 1, taskIndex: 0 },
    { id: "R1", index: 1, nativeIndex: 2, taskIndex: 1 },
  ]);

  // The service is request-context-free; the caller (HTTP server / CLI)
  // writes the audit record. Simulate that here and verify the line.
  await recordExportEvent({
    auditFile,
    record: {
      endpoint: "bundle.zip",
      gameId: "GAME1",
      format: "zip",
      redact: true,
      sizeBytes: bytes,
      sha256,
      requester: "tester",
      sourceIp: "127.0.0.1",
    },
  });
  const audit = fs.readFileSync(auditFile, "utf8").trim().split("\n");
  assert.equal(audit.length, 1);
  const record = JSON.parse(audit[0]);
  assert.equal(record.gameId, "GAME1");
  assert.equal(record.format, "zip");
  assert.equal(record.redact, true);
  assert.equal(record.sizeBytes, bytes);
  assert.equal(record.sha256, sha256);
});

test("production game-ended handler persists an idempotent Tajriba endedAt", () => {
  const callbacksSource = fs.readFileSync(new URL("./callbacks.js", import.meta.url), "utf8");
  const handlerStart = callbacksSource.indexOf("Empirica.onGameEnded");
  const handlerEnd = callbacksSource.indexOf("\nfor (const responseType", handlerStart);
  assert.ok(handlerStart >= 0 && handlerEnd > handlerStart, "game-ended handler must exist");
  const handler = callbacksSource.slice(handlerStart, handlerEnd);
  assert.match(handler, /game\.get\("endedAt"\)/);
  assert.match(handler, /new Date\(\)\.toISOString\(\)/);
  assert.match(handler, /if \(endedAt !== storedEndedAt\) game\.set\("endedAt", endedAt\)/);
  assert.match(handler, /occurred_at: endedAt/);
});
