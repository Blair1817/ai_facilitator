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
  persistAssignmentOrBlock,
  redactPII,
  researchParticipantId,
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
    game_id: "g1", sequence_id: "S3", allocation_number: 7,
    allocation_block_id: 2, allocation_position: 1,
    allocation_claimed_at: new Date(0).toISOString(), allocation_method: "test", ledger_key: "ledger",
  };
  await persistence.persistAssignment(row);
  await persistence.persistAssignment(row);
  assert.equal(stored.size, 1);
  assert.equal(stored.get("g1").sequence_id, "S3");
});

test("non-assignment mirror failure is swallowed and reported without blocking runtime", async () => {
  const failures = [];
  const result = await mirrorNonBlocking(Promise.reject(Object.assign(new Error("secret response"), { status: 503 })), {
    operation: "message", onError: (failure) => failures.push(failure),
  });
  assert.equal(result, null);
  assert.deepEqual(failures, [{ operation: "message", code: "RESEARCH_PERSISTENCE_FAILED", status: 503 }]);
});

test("assignment persistence failure blocks a new untracked game", async () => {
  const failing = { persistAssignment: async () => { throw new Error("offline"); } };
  await assert.rejects(
    persistAssignmentOrBlock(failing, { game_id: "untracked" }),
    (error) => error.code === "ASSIGNMENT_PERSISTENCE_BLOCKED" && /cannot begin/.test(error.message),
  );
  assert.match(callbacksSource, /Empirica\.before\("game", "start", async/);
  assert.match(callbacksSource, /assignmentPersistenceStatus"\) === "confirmed"\) return/);
  // Pilot-only fail-open: onGameStart accepts both "confirmed" (Supabase
  // mirror written) and "tajriba-only" (Supabase not configured). Only
  // "blocked" or missing status ends the game.
  assert.match(
    callbacksSource,
    /persistenceStatus !== "confirmed" && persistenceStatus !== "tajriba-only"[\s\S]*game\.end\("failed"/,
  );
});

test("assignment persistence fail-opens when Supabase is not configured (pilot-only)", async () => {
  // createSupabasePersistence throws SUPABASE_NOT_CONFIGURED when env
  // vars are missing. persistAssignmentOrBlock must catch that and
  // return a tajriba-only row so game.start can proceed during pilot.
  const unconfigured = createSupabasePersistence({ url: "", serviceRoleKey: "", fetchImpl: globalThis.fetch });
  const row = {
    game_id: "pilot-game", sequence_id: "S1", allocation_number: 1,
    allocation_block_id: 1, allocation_position: 0,
    allocation_claimed_at: new Date(0).toISOString(),
    allocation_method: "test", ledger_key: "ledger",
  };
  const result = await persistAssignmentOrBlock(unconfigured, row);
  assert.equal(result?.persistenceMode, "tajriba-only");
  assert.equal(result?.game_id, "pilot-game");
  // Generic (non-NOT_CONFIGURED) failures must still block.
  const failing = { persistAssignment: async () => { throw new Error("network down"); } };
  await assert.rejects(
    persistAssignmentOrBlock(failing, row),
    (error) => error.code === "ASSIGNMENT_PERSISTENCE_BLOCKED",
  );
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
});
