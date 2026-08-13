import { createHash } from "node:crypto";

const SCHEMA = "research";
const RELATION_TYPES = ["mentioned", "attributed", "evaluated", "compared", "countered", "integrated"];
const ROUND_RESPONSE_KEYS = Object.freeze({
  InitialDecision: ["initialDecision"],
  FinalDecision: ["finalDecision"],
  IndividualAssessment: ["individualAssessment"],
  TLX: ["tlxSurvey"],
  SubjectiveSurvey: ["subjectiveSurvey"],
});

function digest(...parts) {
  return createHash("sha256").update(parts.map((part) => String(part ?? "")).join("\u001f")).digest("hex");
}

export function researchParticipantId(gameId, participantId) {
  return digest("participant", gameId, participantId);
}

export function researchMessageId(gameId, messageId) {
  return messageId ? digest("message", gameId, messageId) : null;
}

function iso(value) {
  if (value === null || value === undefined) return null;
  const date = new Date(value);
  return Number.isNaN(date.valueOf()) ? null : date.toISOString();
}

export function redactPII(value) {
  if (typeof value !== "string") return value;
  return value
    .replace(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi, "[REDACTED_EMAIL]")
    .replace(/\b(?:https?:\/\/|www\.)\S+/gi, "[REDACTED_URL]")
    .replace(/(?:\+?\d[\d ().-]{7,}\d)/g, "[REDACTED_PHONE]")
    .replace(/\b(Prolific(?:\s+(?:participant\s+)?ID)?|PID)\s*[:=#-]?\s*[A-Z0-9_-]{5,}\b/gi, "$1 [REDACTED_RECRUITMENT_ID]")
    .replace(/@(?!\[)[A-Z0-9_.-]{2,}/gi, "[REDACTED_HANDLE]")
    .replace(/\b(my (?:real )?name is|call me)\s+[A-Z][A-Za-z'-]*(?:\s+[A-Z][A-Za-z'-]*)?/gi, "$1 [REDACTED_NAME]");
}

export function redactDeep(value) {
  if (typeof value === "string") return redactPII(value);
  if (Array.isArray(value)) return value.map(redactDeep);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, redactDeep(item)]));
}

export function buildReviewQuizPassResponse({ gameId, roundId, participantId, passed }) {
  if (!passed) return null;
  return {
    response_id: digest(gameId, roundId, participantId, "review_quiz_passed"),
    game_id: gameId,
    round_id: roundId,
    participant_id: researchParticipantId(gameId, participantId),
    response_type: "review_quiz_passed",
    response_payload: { passed: true },
    submitted_at: null,
    updated_at: new Date().toISOString(),
  };
}

export function buildRoundResponseRows({ gameId, roundId, participantId, stageName, read }) {
  if (stageName === "ReviewQuiz") {
    const passed = read("reviewQuizPassed") === true;
    const row = buildReviewQuizPassResponse({ gameId, roundId, participantId, passed });
    return row ? [row] : [];
  }
  if (stageName === "IndividualAssessment") {
    const payload = {
      agreesWithGroupChoice: read("agreesWithGroupChoice"),
      finalPersonalChoice: read("finalPersonalChoice"),
      finalPersonalChoiceConfidence: read("finalPersonalChoiceConfidence"),
      finalPersonalChoiceRationale: read("finalPersonalChoiceRationale"),
    };
    if (!payload.finalPersonalChoice) return [];
    return [{
      response_id: digest(gameId, roundId, participantId, "individualAssessment"),
      game_id: gameId, round_id: roundId, participant_id: researchParticipantId(gameId, participantId),
      response_type: "individualAssessment", response_payload: redactDeep(payload),
      submitted_at: null, updated_at: new Date().toISOString(),
    }];
  }
  const keys = ROUND_RESPONSE_KEYS[stageName] || [];
  return keys.flatMap((key) => {
    const stored = read(key);
    if (!stored || typeof stored !== "object") return [];
    const { submittedAt, submissionId: _submissionId, ...payload } = stored;
    return [{
      response_id: digest(gameId, roundId, participantId, key),
      game_id: gameId,
      round_id: roundId,
      participant_id: researchParticipantId(gameId, participantId),
      response_type: key,
      response_payload: redactDeep(payload),
      submitted_at: iso(submittedAt),
      updated_at: new Date().toISOString(),
    }];
  });
}

export function buildGlobalResponseRow({ gameId, participantId, responseType, stored }) {
  if (!stored || typeof stored !== "object" || !["finalQuestions", "expFeedback"].includes(responseType)) return null;
  const { submittedAt, submissionId: _submissionId, ...payload } = stored;
  return {
    response_id: digest(gameId, participantId, responseType), game_id: gameId, round_id: null,
    participant_id: researchParticipantId(gameId, participantId), response_type: responseType,
    response_payload: redactDeep(payload), submitted_at: iso(submittedAt), updated_at: new Date().toISOString(),
  };
}

export function buildMessageRow({ gameId, roundId, transcriptKey, message }) {
  return {
    message_id: researchMessageId(gameId, message.messageId),
    game_id: gameId,
    round_id: roundId,
    participant_id: message.participantId ? researchParticipantId(gameId, message.participantId) : null,
    transcript_key: transcriptKey,
    sequence_position: message.sequencePosition,
    stage_name: message.stage,
    message_type: message.messageType,
    speaker_type: message.speakerType,
    content: redactPII(message.content ?? message.text ?? ""),
    occurred_at: iso(message.timestamp ?? message.ts ?? Date.now()),
  };
}

function canonicalMessageId(gameId, positionalId, chat) {
  const index = Number.parseInt(String(positionalId).replace(/^m/, ""), 10);
  return Number.isInteger(index) ? researchMessageId(gameId, chat[index]?.messageId) : null;
}

export function buildInterventionMirror({ gameId, roundId, facilitation, chat, entry }) {
  const checkpointIndex = Number(entry.humanMessageCount ?? entry.checkpointIndex ?? 0);
  const interventionId = entry.auditRequestId || digest(gameId, roundId, checkpointIndex, entry.timestamp);
  const occurredAt = iso(entry.timestamp ?? Date.now());
  const latestHuman = [...chat].reverse().find((message) => message.speakerType === "human" || message.messageType === "human");
  const intervention = {
    intervention_id: interventionId, game_id: gameId, round_id: roundId,
    trigger_message_id: researchMessageId(gameId, latestHuman?.messageId),
    published_message_id: researchMessageId(gameId, entry.publishedMessageId),
    checkpoint_index: checkpointIndex,
    facilitation,
    trigger_type: entry.triggerType || (entry.mentionDetected ? "PARTICIPANT_REQUEST" : "CHECKPOINT"),
    routing_decision: entry.routingDecision || entry.gateDecision || null,
    selected_role: entry.selectedRole || null,
    outcome: entry.outcome || "UNKNOWN",
    rationale: redactDeep({ reason: entry.reason || null, reasoning: entry.reasoning || null, gateReason: entry.gateReason || null }),
    remaining_seconds: Number.isFinite(entry.remainingTime) ? Math.max(0, Math.round(entry.remainingTime)) : null,
    occurred_at: occurredAt,
    published_at: entry.publishedMessageId ? iso(entry.auditCompletedAt ?? Date.now()) : null,
  };
  const llmCalls = [];
  if (facilitation === "adaptive" && (entry.rawDetectorFactors || entry.detectorError)) {
    llmCalls.push({
      llm_call_id: digest(interventionId, "semantic_assessor", 1), game_id: gameId, round_id: roundId,
      intervention_id: interventionId, call_type: "semantic_assessor", attempt_number: 1, model: entry.model || null,
      prompt_metadata: {}, request_payload: null,
      response_metadata: redactDeep({ factors: entry.rawDetectorFactors || null }),
      success: !entry.detectorError, latency_ms: entry.detectorLatency ?? null,
      error_code: entry.detectorError ? "SEMANTIC_ASSESSOR_FAILED" : null, occurred_at: occurredAt,
    });
  }
  if (entry.requestMade) {
    const generatorAttempts = Math.max(1, Number(entry.attempts || entry.totalGeneratorAttempts || 1));
    for (let attempt = 1; attempt <= generatorAttempts; attempt += 1) {
      llmCalls.push({
        llm_call_id: digest(interventionId, "generator", attempt), game_id: gameId, round_id: roundId,
        intervention_id: interventionId, call_type: "generator", attempt_number: attempt, model: entry.model || null,
        prompt_metadata: redactDeep(entry.promptMetadata || {}),
        request_payload: attempt === generatorAttempts ? redactDeep(entry.messagesOAIFormat || null) : null,
        response_metadata: {}, success: entry.requestSuccess === true,
        latency_ms: entry.generationLatency ?? null,
        error_code: entry.requestSuccess === true ? null : "GENERATOR_FAILED", occurred_at: occurredAt,
      });
    }
  }
  for (const [attempt, verdict] of [[1, entry.validator], [2, entry.validatorRepair]]) {
    if (!verdict) continue;
    llmCalls.push({
      llm_call_id: digest(interventionId, "semantic_validator", attempt), game_id: gameId, round_id: roundId,
      intervention_id: interventionId, call_type: "semantic_validator", attempt_number: attempt,
      model: entry.model || null, prompt_metadata: {}, request_payload: null,
      response_metadata: redactDeep(verdict), success: verdict.passed === true,
      latency_ms: null, error_code: verdict.passed === true ? null : "SEMANTIC_VALIDATION_REJECTED",
      occurred_at: occurredAt,
    });
  }
  const adaptive = facilitation === "adaptive"
    && Boolean(entry.rawDetectorFactors || entry.detectorError || entry.checkedDetectorFactors || entry.gateDecision);
  const featureSnapshot = adaptive ? {
    feature_snapshot_id: digest(interventionId, "features"), game_id: gameId, round_id: roundId,
    intervention_id: interventionId, checkpoint_index: checkpointIndex,
    semantic_assessor: redactDeep({ rawFactors: entry.rawDetectorFactors || null, error: entry.detectorError || null }),
    evidence_checker: redactDeep({ checkedFactors: entry.checkedDetectorFactors || null }),
    gate_state: redactDeep({ decision: entry.gateDecision || null, reason: entry.gateReason || null, eligibleRoles: entry.eligibleRoles || [], scores: entry.stateScores || null, perRole: entry.perRole || null }),
    occurred_at: occurredAt,
  } : null;
  const relations = adaptive ? (entry.checkedDetectorFactors?.evidenceRelations || []).flatMap((relation) => {
    const messageId = canonicalMessageId(gameId, relation.messageId, chat);
    if (!messageId) return [];
    return RELATION_TYPES.map((type) => ({
      evidence_relation_id: digest(interventionId, messageId, type), game_id: gameId, round_id: roundId,
      intervention_id: interventionId, message_id: messageId, relation_type: type, relation_value: relation[type] === true,
      option_key: null, evidence_key: null, detector_metadata: {}, occurred_at: occurredAt,
    }));
  }) : [];
  return { intervention, llmCalls, featureSnapshot, relations };
}

export function safePersistenceError(error) {
  return { code: error?.code || "RESEARCH_PERSISTENCE_FAILED", status: Number.isInteger(error?.status) ? error.status : null };
}

export function mirrorNonBlocking(promise, { operation = "mirror", onError = () => {} } = {}) {
  return Promise.resolve(promise).catch((error) => {
    onError({ operation, ...safePersistenceError(error) });
    return null;
  });
}

export async function persistAssignmentOrBlock(persistence, row) {
  try {
    return await persistence.persistAssignment(row);
  } catch (_error) {
    const error = new Error("This session cannot begin because its research assignment could not be durably recorded. Please contact the research team.");
    error.code = "ASSIGNMENT_PERSISTENCE_BLOCKED";
    throw error;
  }
}

export function createSupabasePersistence({
  url = process.env.SUPABASE_URL,
  serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY,
  fetchImpl = globalThis.fetch,
} = {}) {
  const baseUrl = typeof url === "string" ? url.replace(/\/$/, "") : "";
  function requireConfiguration() {
    if (!baseUrl || !serviceRoleKey || typeof fetchImpl !== "function") {
      const error = new Error("Server research persistence is not configured");
      error.code = "SUPABASE_NOT_CONFIGURED";
      throw error;
    }
  }
  async function request(table, { method = "GET", query = "", body, prefer } = {}) {
    requireConfiguration();
    const response = await fetchImpl(`${baseUrl}/rest/v1/${table}${query}`, {
      method,
      headers: {
        apikey: serviceRoleKey, Authorization: `Bearer ${serviceRoleKey}`,
        Accept: "application/json", "Content-Type": "application/json",
        "Accept-Profile": SCHEMA, "Content-Profile": SCHEMA,
        ...(prefer ? { Prefer: prefer } : {}),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    if (!response.ok) {
      const error = new Error(`Research persistence request failed (${response.status})`);
      error.code = "SUPABASE_REQUEST_FAILED";
      error.status = response.status;
      throw error;
    }
    if (response.status === 204) return null;
    const text = await response.text();
    return text ? JSON.parse(text) : null;
  }
  const upsert = (table, rows, conflict) => {
    if (!rows || (Array.isArray(rows) && rows.length === 0)) return Promise.resolve(null);
    return request(table, { method: "POST", query: `?on_conflict=${encodeURIComponent(conflict)}`, body: rows, prefer: "resolution=merge-duplicates,return=minimal" });
  };
  return {
    async persistAssignment(row) {
      await request("game_assignments", { method: "POST", query: "?on_conflict=game_id", body: row, prefer: "resolution=ignore-duplicates,return=minimal" });
      const existing = await request("game_assignments", { query: `?game_id=eq.${encodeURIComponent(row.game_id)}&select=game_id,sequence_id,allocation_number,allocation_block_id,allocation_position` });
      const saved = existing?.[0];
      if (!saved || ["sequence_id", "allocation_number", "allocation_block_id", "allocation_position"].some((key) => String(saved[key]) !== String(row[key]))) {
        const error = new Error("Durable assignment does not match the runtime allocation");
        error.code = "ASSIGNMENT_CONFLICT";
        throw error;
      }
      return saved;
    },
    upsertParticipants: (rows) => upsert("participants", rows, "participant_id"),
    upsertRounds: (rows) => upsert("rounds", rows, "round_id"),
    upsertMessage: (row) => upsert("messages", row, "message_id"),
    upsertResponses: (rows) => upsert("responses", rows, "response_id"),
    upsertSnapshot: (row) => upsert("game_snapshots", row, "snapshot_id"),
    async mirrorIntervention(bundle) {
      await upsert("interventions", bundle.intervention, "intervention_id");
      await upsert("llm_calls", bundle.llmCalls, "llm_call_id");
      if (bundle.featureSnapshot) await upsert("feature_snapshots", bundle.featureSnapshot, "feature_snapshot_id");
      await upsert("evidence_relations", bundle.relations, "evidence_relation_id");
    },
  };
}

let singleton;
export function researchPersistence() {
  if (!singleton) singleton = createSupabasePersistence();
  return singleton;
}
