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

export function wasSubmittedDuringCurrentServerRun(stored, serverStartedAt) {
  const submittedAt = Number(stored?.submittedAt);
  return Number.isFinite(submittedAt)
    && Number.isFinite(serverStartedAt)
    && submittedAt >= serverStartedAt;
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
      response_metadata: redactDeep({
        factors: entry.rawDetectorFactors || null,
        rawText: entry.detectorRawResponse ?? null,
      }),
      success: !entry.detectorError, latency_ms: entry.detectorLatency ?? null,
      error_code: entry.detectorError ? "SEMANTIC_ASSESSOR_FAILED" : null, occurred_at: occurredAt,
    });
  }
  if (entry.requestMade) {
    const generatorRawResponses = Array.isArray(entry.generatorRawResponses) ? entry.generatorRawResponses : [];
    const generatorRequests = Array.isArray(entry.generatorRequests) ? entry.generatorRequests : [];
    const generatorAttempts = Math.max(
      1,
      Number(entry.totalGeneratorAttempts || entry.attempts || 1),
      generatorRawResponses.length,
      generatorRequests.length,
      Array.isArray(entry.generatorLatenciesMs) ? entry.generatorLatenciesMs.length : 0,
    );
    const specialistAttempts = entry.specialistFailure
      ? Math.max(0, Number(entry.specialistFailure.attempts || 0))
      : 0;
    for (let attempt = 1; attempt <= generatorAttempts; attempt += 1) {
      const rawResponse = generatorRawResponses.find((item) => Number(item?.attempt) === attempt)
        ?? generatorRawResponses[attempt - 1]
        ?? null;
      const generatorRequest = generatorRequests.find((item) => Number(item?.attempt) === attempt)
        ?? generatorRequests[attempt - 1]
        ?? null;
      const promptMetadata = generatorRequest?.promptMetadata
        ?? (specialistAttempts > 0 && attempt <= specialistAttempts
          ? entry.specialistFailure?.promptMetadata
          : entry.promptMetadata);
      const requestMessages = generatorRequest?.messages
        ?? (attempt === generatorAttempts ? entry.messagesOAIFormat : null);
      llmCalls.push({
        llm_call_id: digest(interventionId, "generator", attempt), game_id: gameId, round_id: roundId,
        intervention_id: interventionId, call_type: "generator", attempt_number: attempt, model: entry.model || null,
        prompt_metadata: redactDeep(promptMetadata || {}),
        request_payload: requestMessages ? redactDeep({ messages: requestMessages }) : null,
        response_metadata: redactDeep({ rawText: rawResponse?.rawText ?? null }),
        success: Boolean(rawResponse),
        latency_ms: entry.generatorLatenciesMs?.[attempt - 1] ?? entry.generationLatency ?? null,
        error_code: rawResponse ? null : "GENERATOR_FAILED",
        occurred_at: occurredAt,
      });
    }
  }
  const structuredValidatorResults = entry.specialistFailure
    ? [
      entry.specialistFailure.validator,
      entry.specialistFailure.validatorRepair,
      entry.validator,
      entry.validatorRepair,
    ].filter(Boolean)
    : [entry.validator, entry.validatorRepair].filter(Boolean);
  const validatorRawResponses = Array.isArray(entry.validatorRawResponses) ? entry.validatorRawResponses : [];
  const validatorAttempts = Math.max(
    structuredValidatorResults.length,
    validatorRawResponses.length,
    Array.isArray(entry.validatorLatenciesMs) ? entry.validatorLatenciesMs.length : 0,
  );
  for (let index = 0; index < validatorAttempts; index += 1) {
    const attempt = index + 1;
    const verdict = structuredValidatorResults[index] ?? null;
    const rawResponse = validatorRawResponses.find((item) => Number(item?.attempt) === attempt)
      ?? validatorRawResponses[index]
      ?? null;
    llmCalls.push({
      llm_call_id: digest(interventionId, "semantic_validator", attempt), game_id: gameId, round_id: roundId,
      intervention_id: interventionId, call_type: "semantic_validator", attempt_number: attempt,
      model: entry.model || null, prompt_metadata: {}, request_payload: null,
      response_metadata: redactDeep({ verdict, rawText: rawResponse?.rawText ?? null }),
      success: verdict?.passed === true,
      latency_ms: entry.validatorLatenciesMs?.[index] ?? null,
      error_code: verdict?.passed === true
        ? null
        : verdict?.passed === false
          ? "SEMANTIC_VALIDATION_REJECTED"
          : "SEMANTIC_VALIDATOR_FAILED",
      occurred_at: occurredAt,
    });
  }
  // AgentState contains the public transcript and the checkpoint-level state
  // that explains why the pipeline took this path. Tajriba intentionally
  // excludes it, so retain one redacted copy on the first detailed LLM call
  // rather than duplicating it across every repair/fallback attempt.
  if (entry.agentState && llmCalls.length > 0) {
    const firstRequest = llmCalls[0].request_payload;
    llmCalls[0].request_payload = redactDeep({
      ...(firstRequest && typeof firstRequest === "object" && !Array.isArray(firstRequest)
        ? firstRequest
        : firstRequest
          ? { messages: firstRequest }
          : {}),
      agentState: entry.agentState,
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

function safeDiagnosticText(value) {
  if (typeof value !== "string" || !value.trim()) return null;
  return redactPII(value).slice(0, 1_000);
}

function payloadShape(table, method, body) {
  const rows = Array.isArray(body) ? body : body && typeof body === "object" ? [body] : [];
  return {
    table,
    method,
    rowCount: rows.length,
    keys: [...new Set(rows.flatMap((row) => Object.keys(row || {})))].sort(),
  };
}

export function safePersistenceError(error) {
  return {
    code: error?.code || "RESEARCH_PERSISTENCE_FAILED",
    status: Number.isInteger(error?.status) ? error.status : null,
    supabaseCode: safeDiagnosticText(error?.supabaseCode),
    message: safeDiagnosticText(error?.supabaseMessage),
    details: safeDiagnosticText(error?.supabaseDetails),
    hint: safeDiagnosticText(error?.supabaseHint),
    payloadShape: error?.payloadShape || null,
  };
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
  } catch (originalError) {
    const error = new Error("This session cannot begin because its research assignment could not be durably recorded. Please contact the research team.");
    error.code = "ASSIGNMENT_PERSISTENCE_BLOCKED";
    // Preserve only a safe diagnostic summary. Never attach a response body,
    // request headers, URL query, or service-role key to the runtime error.
    error.persistence = safePersistenceError(originalError);
    throw error;
  }
}

export async function mirrorResponsesWithParents(persistence, {
  assignment,
  participants,
  rounds = [],
  responses,
} = {}) {
  const responseRows = Array.isArray(responses) ? responses : responses ? [responses] : [];
  const participantRows = Array.isArray(participants) ? participants : participants ? [participants] : [];
  const roundRows = Array.isArray(rounds) ? rounds : rounds ? [rounds] : [];
  if (!assignment?.game_id || responseRows.length === 0) {
    return { mirrored: false, reason: "missing_assignment_or_response" };
  }

  const participantIds = new Set(participantRows.map((row) => row?.participant_id).filter(Boolean));
  const roundIds = new Set(roundRows.map((row) => row?.round_id).filter(Boolean));
  const missingParticipant = responseRows.some((row) => (
    row?.game_id !== assignment.game_id || !participantIds.has(row?.participant_id)
  ));
  const missingRound = responseRows.some((row) => row?.round_id && !roundIds.has(row.round_id));
  if (missingParticipant || missingRound) {
    return {
      mirrored: false,
      reason: missingParticipant ? "missing_participant_parent" : "missing_round_parent",
    };
  }

  await persistence.persistAssignment(assignment);
  await persistence.upsertParticipants(participantRows);
  if (roundRows.length) await persistence.upsertRounds(roundRows);
  await persistence.upsertResponses(responseRows);
  return { mirrored: true };
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
    const text = await response.text();
    if (!response.ok) {
      let failure = null;
      try {
        failure = text ? JSON.parse(text) : null;
      } catch {
        failure = null;
      }
      const error = new Error(`Research persistence request failed (${response.status})`);
      error.code = "SUPABASE_REQUEST_FAILED";
      error.status = response.status;
      error.supabaseCode = failure?.code;
      error.supabaseMessage = failure?.message;
      error.supabaseDetails = failure?.details;
      error.supabaseHint = failure?.hint;
      error.payloadShape = payloadShape(table, method, body);
      throw error;
    }
    if (response.status === 204) return null;
    return text ? JSON.parse(text) : null;
  }
  const upsert = (table, rows, conflict) => {
    if (!rows || (Array.isArray(rows) && rows.length === 0)) return Promise.resolve(null);
    return request(table, { method: "POST", query: `?on_conflict=${encodeURIComponent(conflict)}`, body: rows, prefer: "resolution=merge-duplicates,return=minimal" });
  };
  function missingRuntimeLedgerColumn(error) {
    return error?.supabaseCode === "42703"
      && /runtime_ledger_id/i.test(error?.supabaseMessage || "");
  }
  async function persistAssignment(row) {
    let select = "game_id,runtime_ledger_id,sequence_id,allocation_number,allocation_block_id,allocation_position";
    try {
      await request("game_assignments", { method: "POST", query: "?on_conflict=game_id", body: row, prefer: "resolution=ignore-duplicates,return=minimal" });
    } catch (error) {
      if (!missingRuntimeLedgerColumn(error)) throw error;
      const { runtime_ledger_id: _runtimeLedgerId, ...legacyRow } = row;
      select = "game_id,sequence_id,allocation_number,allocation_block_id,allocation_position";
      await request("game_assignments", { method: "POST", query: "?on_conflict=game_id", body: legacyRow, prefer: "resolution=ignore-duplicates,return=minimal" });
    }
    let existing;
    try {
      existing = await request("game_assignments", { query: `?game_id=eq.${encodeURIComponent(row.game_id)}&select=${select}` });
    } catch (error) {
      if (!missingRuntimeLedgerColumn(error)) throw error;
      existing = await request("game_assignments", { query: `?game_id=eq.${encodeURIComponent(row.game_id)}&select=game_id,sequence_id,allocation_number,allocation_block_id,allocation_position` });
    }
    const saved = existing?.[0];
    // runtime_ledger_id is deliberately not part of the retry comparison:
    // assignments persisted before this column was introduced are marked as
    // `legacy`, and an already-persisted Game must remain safely retryable.
    if (!saved || ["sequence_id", "allocation_number", "allocation_block_id", "allocation_position"].some((key) => String(saved[key]) !== String(row[key]))) {
      const error = new Error("Durable assignment does not match the runtime allocation");
      error.code = "ASSIGNMENT_CONFLICT";
      throw error;
    }
    return saved;
  }
  return {
    persistAssignment,
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
