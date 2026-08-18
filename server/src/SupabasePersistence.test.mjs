import assert from "node:assert/strict";
import test from "node:test";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  buildInterventionMirror,
  buildRoundResponseRows,
  createSupabasePersistence,
  mirrorNonBlocking,
  mirrorResponsesWithParents,
  persistAssignmentOrBlock,
  redactPII,
  researchParticipantId,
  safePersistenceError,
  wasSubmittedDuringCurrentServerRun,
} from "./SupabasePersistence.mjs";

const dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(dirname, "../..");
const callbacksSource = readFileSync(path.join(dirname, "callbacks.js"), "utf8");

function jsonResponse(status, body = null) {
  return { ok: status >= 200 && status < 300, status, text: async () => body === null ? "" : JSON.stringify(body) };
}

test("assignment persistence is idempotent for the same game_id", async () => {
  const stored = new Map();
  const fetchImpl = async (url, options) => {
    if (options.method === "POST") {
      const row = JSON.parse(options.body);
      if (!stored.has(row.game_id)) stored.set(row.game_id, row);
      return jsonResponse(201);
    }
    const gameId = decodeURIComponent(new URL(url).searchParams.get("game_id").replace(/^eq\./, ""));
    return jsonResponse(200, stored.has(gameId) ? [stored.get(gameId)] : []);
  };
  const persistence = createSupabasePersistence({ url: "https://project.invalid", serviceRoleKey: "test-placeholder", fetchImpl });
  const row = {
    game_id: "g1", runtime_ledger_id: "runtime-ledger-a",
    sequence_id: "S3", allocation_number: 7,
    allocation_block_id: 2, allocation_position: 1,
    allocation_claimed_at: new Date(0).toISOString(), allocation_method: "test", ledger_key: "ledger",
  };
  await persistence.persistAssignment(row);
  await persistence.persistAssignment(row);
  assert.equal(stored.size, 1);
  assert.equal(stored.get("g1").sequence_id, "S3");
});

test("an assignment persisted before runtime ledger scoping remains safely retryable", async () => {
  const legacy = {
    game_id: "legacy-game",
    runtime_ledger_id: "legacy",
    sequence_id: "S2",
    allocation_number: 4,
    allocation_block_id: 1,
    allocation_position: 4,
  };
  const fetchImpl = async (_url, options) => (
    options.method === "POST" ? jsonResponse(201) : jsonResponse(200, [legacy])
  );
  const persistence = createSupabasePersistence({
    url: "https://project.invalid",
    serviceRoleKey: "test-placeholder",
    fetchImpl,
  });
  const saved = await persistence.persistAssignment({
    ...legacy,
    runtime_ledger_id: "new-runtime-ledger",
  });
  assert.equal(saved.game_id, "legacy-game");
  assert.equal(saved.runtime_ledger_id, "legacy");
});

test("assignment persistence tolerates the live legacy schema until the ledger migration is applied", async () => {
  const posted = [];
  const legacy = {
    game_id: "legacy-schema-game",
    sequence_id: "S1",
    allocation_number: 1,
    allocation_block_id: 1,
    allocation_position: 1,
  };
  const fetchImpl = async (_url, options) => {
    if (options.method === "POST") {
      const row = JSON.parse(options.body);
      posted.push(row);
      return Object.hasOwn(row, "runtime_ledger_id")
        ? jsonResponse(400, { code: "42703", message: "column game_assignments.runtime_ledger_id does not exist" })
        : jsonResponse(201);
    }
    return jsonResponse(200, [legacy]);
  };
  const persistence = createSupabasePersistence({
    url: "https://project.invalid",
    serviceRoleKey: "test-placeholder",
    fetchImpl,
  });
  const saved = await persistence.persistAssignment({
    ...legacy,
    runtime_ledger_id: "new-ledger",
    allocation_claimed_at: new Date(0).toISOString(),
    allocation_method: "test",
    ledger_key: "ledger",
  });
  assert.equal(saved.game_id, "legacy-schema-game");
  assert.equal(posted.length, 2);
  assert.equal(posted[0].runtime_ledger_id, "new-ledger");
  assert.equal(Object.hasOwn(posted[1], "runtime_ledger_id"), false);
});

test("non-assignment mirror failure is swallowed and reported without blocking runtime", async () => {
  const failures = [];
  const result = await mirrorNonBlocking(Promise.reject(Object.assign(new Error("secret response"), { status: 503 })), {
    operation: "message", onError: (failure) => failures.push(failure),
  });
  assert.equal(result, null);
  assert.deepEqual(failures, [{
    operation: "message",
    code: "RESEARCH_PERSISTENCE_FAILED",
    status: 503,
    supabaseCode: null,
    message: null,
    details: null,
    hint: null,
    payloadShape: null,
  }]);
});

test("Supabase failures retain safe structured diagnostics and payload shape", async () => {
  const persistence = createSupabasePersistence({
    url: "https://project.invalid",
    serviceRoleKey: "test-placeholder",
    fetchImpl: async () => jsonResponse(409, {
      code: "23503",
      message: "insert violates foreign key for jane@example.com",
      details: "Key (game_id)=(g1) is not present",
      hint: "Create the parent first",
    }),
  });
  let caught;
  try {
    await persistence.upsertResponses({
      response_id: "response-1",
      game_id: "g1",
      participant_id: "participant-1",
      response_type: "finalQuestions",
      response_payload: { privateValue: "not logged" },
    });
  } catch (error) {
    caught = safePersistenceError(error);
  }
  assert.equal(caught.status, 409);
  assert.equal(caught.supabaseCode, "23503");
  assert.match(caught.message, /REDACTED_EMAIL/);
  assert.match(caught.details, /game_id/);
  assert.deepEqual(caught.payloadShape, {
    table: "responses",
    method: "POST",
    rowCount: 1,
    keys: ["game_id", "participant_id", "response_id", "response_payload", "response_type"],
  });
  assert.doesNotMatch(JSON.stringify(caught), /not logged|test-placeholder/);
});

test("response mirroring recreates required parents in FK order and remains idempotent", async () => {
  const order = [];
  const stored = {
    assignments: new Map(),
    participants: new Map(),
    rounds: new Map(),
    responses: new Map(),
  };
  const persistence = {
    persistAssignment: async (row) => {
      order.push("assignment");
      stored.assignments.set(row.game_id, row);
    },
    upsertParticipants: async (rows) => {
      order.push("participants");
      for (const row of rows) stored.participants.set(row.participant_id, row);
    },
    upsertRounds: async (rows) => {
      order.push("rounds");
      for (const row of rows) stored.rounds.set(row.round_id, row);
    },
    upsertResponses: async (rows) => {
      order.push("responses");
      for (const row of rows) stored.responses.set(row.response_id, row);
    },
  };
  const bundle = {
    assignment: { game_id: "g1" },
    participants: [{ participant_id: "p1", game_id: "g1" }],
    rounds: [{ round_id: "r1", game_id: "g1" }],
    responses: [{ response_id: "response-1", game_id: "g1", round_id: "r1", participant_id: "p1" }],
  };
  assert.deepEqual(await mirrorResponsesWithParents(persistence, bundle), { mirrored: true });
  assert.deepEqual(await mirrorResponsesWithParents(persistence, bundle), { mirrored: true });
  assert.deepEqual(order.slice(0, 4), ["assignment", "participants", "rounds", "responses"]);
  assert.equal(stored.assignments.size, 1);
  assert.equal(stored.participants.size, 1);
  assert.equal(stored.rounds.size, 1);
  assert.equal(stored.responses.size, 1);
});

test("response mirroring skips cleanly when a required parent cannot be reconstructed", async () => {
  let calls = 0;
  const persistence = {
    persistAssignment: async () => { calls += 1; },
    upsertParticipants: async () => { calls += 1; },
    upsertRounds: async () => { calls += 1; },
    upsertResponses: async () => { calls += 1; },
  };
  const result = await mirrorResponsesWithParents(persistence, {
    assignment: { game_id: "g1" },
    participants: [],
    responses: [{ response_id: "response-1", game_id: "g1", participant_id: "missing" }],
  });
  assert.deepEqual(result, { mirrored: false, reason: "missing_participant_parent" });
  assert.equal(calls, 0);
});

test("terminal response callbacks ignore attributes persisted before this server run", () => {
  const serverStartedAt = 10_000;
  assert.equal(wasSubmittedDuringCurrentServerRun({ submittedAt: 9_999 }, serverStartedAt), false);
  assert.equal(wasSubmittedDuringCurrentServerRun({ submittedAt: 10_000 }, serverStartedAt), true);
  assert.equal(wasSubmittedDuringCurrentServerRun({ submittedAt: 10_001 }, serverStartedAt), true);
  assert.equal(wasSubmittedDuringCurrentServerRun({}, serverStartedAt), false);
  assert.match(callbacksSource, /wasSubmittedDuringCurrentServerRun\(stored, CALLBACKS_STARTED_AT\)/);
  assert.doesNotMatch(callbacksSource, /game\?\.id \|\| player\.get\("researchGameId"\)/);
});

test("round-stage and terminal responses use the same parent-first mirror path", () => {
  const stageEndedStart = callbacksSource.indexOf("Empirica.onStageEnded");
  const stageEndedFinish = callbacksSource.indexOf("Empirica.onRoundEnded", stageEndedStart);
  const stageEndedBlock = callbacksSource.slice(stageEndedStart, stageEndedFinish);
  const terminalStart = callbacksSource.indexOf('for (const responseType of ["finalQuestions", "expFeedback"])');
  const terminalBlock = callbacksSource.slice(terminalStart);

  assert.notEqual(stageEndedStart, -1);
  assert.notEqual(stageEndedFinish, -1);
  assert.notEqual(terminalStart, -1);
  assert.match(stageEndedBlock, /mirrorResponseRowsFromRuntime\(\{/);
  assert.match(terminalBlock, /mirrorResponseRowsFromRuntime\(\{/);
});

test("Task stage end reconciles the transcript before writing a stable discussion_ended snapshot", () => {
  const stageEndedStart = callbacksSource.indexOf("Empirica.onStageEnded");
  const stageEndedFinish = callbacksSource.indexOf("Empirica.onRoundEnded", stageEndedStart);
  const block = callbacksSource.slice(stageEndedStart, stageEndedFinish);
  assert.notEqual(stageEndedStart, -1);
  assert.notEqual(stageEndedFinish, -1);
  assert.match(block, /if \(stageName === "Task"\)/);
  assert.match(block, /for \(const message of chat\)/);
  assert.match(block, /await persistence\.upsertMessage/);
  assert.match(block, /await persistence\.upsertSnapshot/);
  assert.ok(block.indexOf("await persistence.upsertMessage") < block.indexOf("await persistence.upsertSnapshot"));
  assert.match(block, /snapshot_id: `\$\{game\.id\}:\$\{round\.id\}:discussion_ended`/);
  assert.match(block, /snapshot_type: "discussion_ended"/);
  assert.match(block, /transcriptComplete: true/);
});

test("assignment persistence failure blocks a new untracked game", async () => {
  const original = Object.assign(new Error("offline response with internal details"), {
    code: "SUPABASE_REQUEST_FAILED",
    status: 409,
  });
  const failing = { persistAssignment: async () => { throw original; } };
  await assert.rejects(
    persistAssignmentOrBlock(failing, { game_id: "untracked" }),
    (error) => (
      error.code === "ASSIGNMENT_PERSISTENCE_BLOCKED"
      && /cannot begin/.test(error.message)
      && error.persistence?.code === "SUPABASE_REQUEST_FAILED"
      && error.persistence?.status === 409
      && !JSON.stringify(error).includes("internal details")
    ),
  );
  assert.match(callbacksSource, /Empirica\.before\("game", "start", async/);
  const allocationBlock = callbacksSource.slice(
    callbacksSource.indexOf('Empirica.before("game", "start"'),
    callbacksSource.indexOf("// ── onGameStart"),
  );
  assert.doesNotMatch(allocationBlock, /assignmentPersistenceStatus"\) === "confirmed"\) return/);
  assert.match(allocationBlock, /assignmentPersistenceStatus", "blocked"/);
  assert.doesNotMatch(allocationBlock, /throw error/);
  assert.match(callbacksSource, /Empirica\.after\("game", "start"[\s\S]*game\.end\([\s\S]*"failed"/);
  assert.match(callbacksSource, /runtime_ledger_id: runtimeLedgerId/);
});

test("ReviewQuiz mirror stores only a minimal successful completion and no attempt history", () => {
  const store = new Map([
    ["reviewQuizPassed", true],
  ]);
  const rows = buildRoundResponseRows({ gameId: "g", roundId: "r", participantId: "p", stageName: "ReviewQuiz", read: (key) => store.get(key) });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].response_type, "review_quiz_passed");
  assert.deepEqual(rows[0].response_payload, { passed: true });
  assert.equal(rows[0].submitted_at, null);
  assert.doesNotMatch(JSON.stringify(rows), /attempt|incorrect|correctness|123/);

  store.set("reviewQuizPassed", false);
  assert.deepEqual(buildRoundResponseRows({ gameId: "g", roundId: "r", participantId: "p", stageName: "ReviewQuiz", read: (key) => store.get(key) }), []);
});

test("client source contains no Supabase import or server secret variable", () => {
  const files = [];
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else files.push(full);
    }
  };
  walk(path.join(root, "client/src"));
  const source = files.map((file) => readFileSync(file, "utf8")).join("\n");
  assert.doesNotMatch(source, /@supabase|SUPABASE_URL|SUPABASE_SERVICE_ROLE_KEY|SupabasePersistence/);
});

test("feature_snapshots and evidence_relations are emitted only for Adaptive checkpoints", () => {
  const chat = [{ messageId: "human-1", messageType: "human", speakerType: "human" }];
  const entry = {
    auditRequestId: "audit-1", humanMessageCount: 1, timestamp: 1000, outcome: "SILENT",
    checkedDetectorFactors: { evidenceRelations: [{ messageId: "m0", mentioned: true, attributed: false, evaluated: true, compared: false, countered: false, integrated: false }] },
    rawDetectorFactors: { participation_imbalance: { status: "absent" } }, gateDecision: "abstain",
  };
  const adaptive = buildInterventionMirror({ gameId: "g", roundId: "r", facilitation: "adaptive", chat, entry });
  assert.ok(adaptive.featureSnapshot);
  assert.equal(adaptive.relations.length, 6);
  assert.deepEqual(Object.fromEntries(adaptive.relations.map((row) => [row.relation_type, row.relation_value])), {
    mentioned: true, attributed: false, evaluated: true, compared: false, countered: false, integrated: false,
  });
  const staticMirror = buildInterventionMirror({ gameId: "g", roundId: "r", facilitation: "static", chat, entry });
  assert.equal(staticMirror.featureSnapshot, null);
  assert.deepEqual(staticMirror.relations, []);
});

test("Supabase keeps raw Generator and Validator responses as distinct redacted LLM attempts", () => {
  const entry = {
    auditRequestId: "audit-full-llm",
    timestamp: 1_000,
    humanMessageCount: 6,
    outcome: "PUBLISHED",
    requestMade: true,
    requestSuccess: true,
    totalGeneratorAttempts: 3,
    messagesOAIFormat: [
      { role: "user", content: "Latest prompt from jane@example.com about Meridia" },
    ],
    agentState: {
      cumulativeContext: [{ text: "jane@example.com compared Meridia with Halden" }],
      selectedOptionLabels: ["Meridia", "Halden"],
    },
    promptMetadata: { generationRole: "Generalist", promptVersion: "general-v2" },
    specialistFailure: {
      attempts: 2,
      promptMetadata: { generationRole: "Expander", promptVersion: "specialist-v1" },
      validator: { passed: false, failedCriteria: ["grounding"] },
      validatorRepair: { passed: false, failedCriteria: ["grounding"] },
    },
    validator: { passed: true, failedCriteria: [] },
    generatorRawResponses: [
      { attempt: 1, rawText: '{"MESSAGE":"First from jane@example.com"}' },
      { attempt: 2, rawText: '{"MESSAGE":"Repaired specialist"}' },
      { attempt: 3, rawText: '{"MESSAGE":"Generalist fallback about Meridia"}' },
    ],
    generatorRequests: [
      {
        attempt: 1,
        messages: [{ role: "user", content: "Specialist prompt from jane@example.com about Meridia" }],
        promptMetadata: { generationRole: "Expander", promptVersion: "specialist-v1" },
      },
      {
        attempt: 2,
        messages: [{ role: "user", content: "Repair specialist prompt about Halden" }],
        promptMetadata: { generationRole: "Expander", promptVersion: "specialist-v1" },
      },
      {
        attempt: 3,
        messages: [{ role: "user", content: "Generalist fallback prompt about Meridia" }],
        promptMetadata: { generationRole: "Generalist", promptVersion: "general-v2" },
      },
    ],
    validatorRawResponses: [
      { attempt: 1, rawText: '{"passed":false,"note":"jane@example.com"}' },
      { attempt: 2, rawText: '{"passed":false}' },
      { attempt: 3, rawText: '{"passed":true}' },
    ],
    generatorLatenciesMs: [101, 102, 103],
    validatorLatenciesMs: [201, 202, 203],
  };
  const mirror = buildInterventionMirror({
    gameId: "g", roundId: "r", facilitation: "adaptive", chat: [], entry,
  });
  const generators = mirror.llmCalls.filter((row) => row.call_type === "generator");
  const validators = mirror.llmCalls.filter((row) => row.call_type === "semantic_validator");

  assert.equal(generators.length, 3);
  assert.deepEqual(generators.map((row) => row.attempt_number), [1, 2, 3]);
  assert.deepEqual(generators.map((row) => row.prompt_metadata.generationRole), ["Expander", "Expander", "Generalist"]);
  assert.deepEqual(generators.map((row) => row.latency_ms), [101, 102, 103]);
  assert.match(generators[0].request_payload.messages[0].content, /Meridia/);
  assert.match(generators[1].request_payload.messages[0].content, /Halden/);
  assert.match(generators[2].request_payload.messages[0].content, /Meridia/);
  assert.match(generators[0].request_payload.agentState.cumulativeContext[0].text, /REDACTED_EMAIL/);
  assert.deepEqual(generators[0].request_payload.agentState.selectedOptionLabels, ["Meridia", "Halden"]);
  assert.equal(Object.hasOwn(generators[1].request_payload, "agentState"), false);
  assert.equal(Object.hasOwn(generators[2].request_payload, "agentState"), false);
  assert.doesNotMatch(JSON.stringify(generators), /jane@example\.com/);
  assert.match(generators[0].response_metadata.rawText, /REDACTED_EMAIL/);
  assert.match(generators[2].response_metadata.rawText, /Meridia/);

  assert.equal(validators.length, 3);
  assert.deepEqual(validators.map((row) => row.attempt_number), [1, 2, 3]);
  assert.deepEqual(validators.map((row) => row.response_metadata.verdict.passed), [false, false, true]);
  assert.deepEqual(validators.map((row) => row.latency_ms), [201, 202, 203]);
  assert.match(validators[0].response_metadata.rawText, /REDACTED_EMAIL/);
  assert.equal(new Set(mirror.llmCalls.map((row) => row.llm_call_id)).size, mirror.llmCalls.length);
});

test("a later failed Generator call is not mislabeled successful after an earlier successful attempt", () => {
  const mirror = buildInterventionMirror({
    gameId: "g",
    roundId: "r",
    facilitation: "static",
    chat: [],
    entry: {
      auditRequestId: "generator-second-attempt-failed",
      timestamp: 1_000,
      requestMade: true,
      requestSuccess: true,
      generatorLatenciesMs: [100, 200],
      generatorRawResponses: [{ attempt: 1, rawText: '{"MESSAGE":"first"}' }],
      outcome: "SILENT_GENERATOR_FAILED_AFTER_VALIDATOR_REJECT",
    },
  });
  const generators = mirror.llmCalls.filter((row) => row.call_type === "generator");
  assert.equal(generators.length, 2);
  assert.deepEqual(generators.map((row) => row.success), [true, false]);
  assert.deepEqual(generators.map((row) => row.error_code), [null, "GENERATOR_FAILED"]);
});

test("Semantic Assessor raw output is retained in Supabase after Tajriba compaction", () => {
  const mirror = buildInterventionMirror({
    gameId: "g",
    roundId: "r",
    facilitation: "adaptive",
    chat: [],
    entry: {
      auditRequestId: "assessor-raw",
      timestamp: 1_000,
      rawDetectorFactors: { balanced_contribution: { status: "present" } },
      detectorRawResponse: '{"note":"from jane@example.com"}',
    },
  });
  const assessor = mirror.llmCalls.find((row) => row.call_type === "semantic_assessor");
  assert.ok(assessor);
  assert.deepEqual(assessor.response_metadata.factors, { balanced_contribution: { status: "present" } });
  assert.match(assessor.response_metadata.rawText, /REDACTED_EMAIL/);
});

test("public chat and free text PII patterns are redacted without deleting option labels", () => {
  const result = redactPII("My name is Jane Doe, jane@example.com, +44 7700 900123, @janedoe, Prolific ID 5FABC123, https://example.com/me. Meridia and Halden remain options.");
  assert.doesNotMatch(result, /Jane Doe|jane@example|7700|@janedoe|5FABC123|example\.com/);
  assert.match(result, /REDACTED_NAME/);
  assert.match(result, /Meridia and Halden/);
});

test("research participant keys do not expose Empirica or recruitment-derived identifiers", () => {
  const sourceId = "prolific-session-ABC123";
  const pseudonym = researchParticipantId("game-1", sourceId);
  assert.equal(pseudonym.length, 64);
  assert.doesNotMatch(pseudonym, /prolific|session|ABC123/i);
  const rows = buildRoundResponseRows({
    gameId: "game-1", roundId: "round-1", participantId: sourceId,
    stageName: "ReviewQuiz", read: (key) => key === "reviewQuizPassed",
  });
  assert.equal(rows[0].participant_id, pseudonym);
});

test("migration defines exactly the required ten research tables", () => {
  const sql = readFileSync(path.join(root, "supabase/migrations/202608120001_research_persistence.sql"), "utf8");
  const tables = [...sql.matchAll(/create table research\.([a-z_]+)/g)].map((match) => match[1]);
  assert.deepEqual(tables, [
    "game_assignments", "participants", "rounds", "messages", "interventions",
    "llm_calls", "responses", "game_snapshots", "feature_snapshots", "evidence_relations",
  ]);
  assert.doesNotMatch(sql, /prompt_versions|public\.(?:game_assignments|participants|rounds)/);
  assert.match(sql, /revoke all on all tables in schema research from public, anon, authenticated/);
  assert.match(sql, /grant select, insert, update on all tables in schema research to service_role/);
  assert.match(sql, /runtime_ledger_id text not null/);
  assert.match(sql, /unique \(runtime_ledger_id, allocation_number\)/);
  assert.match(sql, /unique \(runtime_ledger_id, allocation_block_id, allocation_position\)/);
  assert.match(sql, /unique \(runtime_ledger_id, allocation_block_id, sequence_id\)/);
});

test("incremental migration preserves old assignments and scopes future allocation uniqueness", () => {
  const sql = readFileSync(
    path.join(root, "supabase/migrations/202608140001_scope_assignment_ledger.sql"),
    "utf8",
  );
  assert.match(sql, /add column if not exists runtime_ledger_id text/);
  assert.match(sql, /set runtime_ledger_id = 'legacy'/);
  assert.match(sql, /alter column runtime_ledger_id set not null/);
  assert.match(sql, /drop constraint if exists game_assignments_allocation_number_key/);
  assert.match(sql, /unique \(runtime_ledger_id, allocation_number\)/);
  assert.match(sql, /unique \(runtime_ledger_id, allocation_block_id, allocation_position\)/);
  assert.match(sql, /unique \(runtime_ledger_id, allocation_block_id, sequence_id\)/);
  assert.doesNotMatch(sql, /delete from|truncate|drop table/i);
});
