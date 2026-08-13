import { ClassicListenersCollector } from "@empirica/core/admin/classic";
export const Empirica = new ClassicListenersCollector();
import _ from "lodash";
import dotenv from "dotenv";
import taskConfig from "./HPTConfig.json";
import { llmSystemPrompts } from "./LLMConfig.js";
import { evaluateGate, chooseRole, getRoleThreshold, THRESHOLDS } from "./utils.js";
import { parseGeneratorOutputStrict, validateAgainstGenerationSchema, runDeterministicValidation } from "./prompts/GeneratorContract.mjs";
import { buildDynamicUserContext, withMessageIds } from "./prompts/DynamicContext.mjs";
import { getRequestedGeneralistPromptBundle } from "./prompts/promptLoader.js";
import { buildStaticSharedTaskOverview, buildStaticUserContext } from "./prompts/StaticContext.mjs";
import { buildChatCompletionPayload, buildSuccessfulLLMResult } from "./LLMTransport.mjs";
import {
  buildIcebreakerLLMMessages,
  buildIcebreakerOpening,
  parseIcebreakerLLMResponse,
} from "./IcebreakerFacilitator.mjs";
import { assessSemanticFactors } from "./SemanticAssessor.js";
import { checkEvidence } from "./EvidenceChecker.js";
import { compilePlan } from "./PolicyCompiler.js";
import {
  shouldEvaluateCheckpoint,
  recordAttempt,
  recordPublish,
  recordParticipantRequest,
  recordParticipantRequestedPublish,
  resetRoundState,
  CHECKPOINT_DEFAULTS,
  containsFacilitatorMention,
} from "./CheckpointManager.mjs";
import { buildAgentState } from "./AgentState.mjs";
import { validateCandidate } from "./SemanticValidator.js";
import { claimSequenceForStudy, RANDOMIZATION_LEDGER_KEY } from "./RandomizationLedger.mjs";
import { randomUUID } from "node:crypto";
import { beginInFlight, finalizeAuditLog as finalizeAuditLogBase, recoverInterruptedInFlight } from "./InFlightAudit.mjs";
import {
  canConfirmBreak,
  allFinalDecisionConfirmationsMatch,
  classifyFinalDecision,
  MESSAGE_TYPES,
  NO_GROUP_FINAL_DECISION,
  allocateSequencePosition,
  buildCanonicalMessage,
  reviewHumanMessageRequest,
  summarizeFinalDecisionDrafts,
} from "./ExperimentPolicies.mjs";
import {
  buildGlobalResponseRow,
  buildInterventionMirror,
  buildMessageRow,
  buildRoundResponseRows,
  mirrorNonBlocking,
  persistAssignmentOrBlock,
  researchParticipantId,
  researchPersistence,
} from "./SupabasePersistence.mjs";

dotenv.config();

let researchMirrorQueue = Promise.resolve();
function queueResearchMirror(operation, task) {
  researchMirrorQueue = mirrorNonBlocking(researchMirrorQueue.then(task), {
    operation,
    onError: (failure) => console.warn("[research mirror] non-blocking write failed", failure),
  });
  return researchMirrorQueue;
}

function finalizeAuditLog(store, entry) {
  finalizeAuditLogBase(store, entry);
  const round = store.currentRound;
  if (!round) return;
  const chat = store.get(`chat_round_${round.get("index")}`) || [];
  const completed = { ...entry, auditCompletedAt: Date.now() };
  queueResearchMirror("intervention", async () => {
    const persistence = researchPersistence();
    for (const message of chat) {
      await persistence.upsertMessage(buildMessageRow({
        gameId: store.id, roundId: round.id,
        transcriptKey: `chat_round_${round.get("index")}`, message,
      }));
    }
    await persistence.mirrorIntervention(buildInterventionMirror({
      gameId: store.id, roundId: round.id, facilitation: round.get("facilitation"), chat, entry: completed,
    }));
  });
}

// Phase 6.3 (model-version freeze): the default was previously the
// "gpt-4o" alias, which silently picks the latest snapshot on every
// call -- a reproducibility hazard for any research that wants to
// attribute participant behaviour to a specific model version. Pinned
// to the platform-confirmed model id ("MiniMax-Text-01") as the
// default; override per-deployment via OPENAI_MODEL in server/.env
// if the live LLM platform exposes a different model identifier. The
// string the process actually uses is recorded in game-level
// systemInfo.model (see onGameStart below) and in every llmLog
// entry, so the post-hoc analysis can recover exactly which snapshot
// produced each intervention. Pilot-prep probe (2026-08-11) showed
// "gpt-4o"/"gpt-4o-2024-08-06"/"abab-6.5s" all return 400 from
// api.minimax.chat; "MiniMax-Text-01" works and returns clean JSON.
const openaiModel = process.env.OPENAI_MODEL || "MiniMax-Text-01";
// Phase 5.5: switched from OpenAI Responses API (`/v1/responses`,
// `input`/`output[]` shape) to OpenAI Chat Completions API
// (`/v1/chat/completions`, `messages`/`choices[0].message.content` shape).
// Reason: the live LLM endpoint is the platform's `api.minimax.chat/v1`
// gateway, and Chat Completions is the universally supported OpenAI-
// compatible surface across providers (Responses API adoption is still
// limited). Phase 6.3: the .env value is kept free of the API-style
// suffix (just `https://api.minimax.chat/v1`), and this code appends
// `/chat/completions` if the caller didn't already -- so changing the
// platform to a non-OpenAI-compatible surface in the future only
// requires changing this single concatenation, not the env var.
const _llmBase = process.env.LLM_API_ENDPOINT || "https://api.minimax.chat/v1";
const llmAPIEndpoint = _llmBase.endsWith("/chat/completions") ? _llmBase : `${_llmBase.replace(/\/$/, "")}/chat/completions`;
const llmMaxOutputTokens = Number.parseInt(process.env.LLM_MAX_OUTPUT_TOKENS ?? "1000", 10);
const CALLBACKS_INSTANCE_ID = randomUUID();

// ── LLM API call ──────────────────────────────────────────────────────────────

async function requestChatCompletion(messages, maxTokens = llmMaxOutputTokens) {
  const data = buildChatCompletionPayload({
    model: openaiModel,
    maxTokens,
    messages,
    // Note: `response_format: { type: "json_object" }` is intentionally
    // NOT sent. The live endpoint (api.minimax.chat, Phase 6 pilot) does
    // not support it -- it returns 400 "unknown response_format type
    // 'json_object'". The platform's `MiniMax-Text-01` model produces
    // well-formed JSON on its own when the prompt explicitly asks for
    // it (every base.md / validator.md / assessor.md in this repo
    // includes an OUTPUT CONTRACT section that does so), and the
    // strict JSON parser (`server/src/prompts/GeneratorContract.mjs`'s
    // `parseGeneratorOutputStrict` and SemanticValidator's
    // `strictParseJsonObject`) tolerates nothing else. If a future
    // platform supports json_object output, re-enable here.
  });
  try {
    const completion = await fetch(llmAPIEndpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
      },
      body: JSON.stringify(data),
    });
    const isJson = completion.headers.get("content-type")?.includes("application/json");
    const responseBody = isJson ? await completion.json() : await completion.text();
    if (!completion.ok) {
      const errorPayload = isJson ? responseBody : { error: responseBody };
      console.error("LLM endpoint HTTP error:", { status: completion.status, error: errorPayload?.error || errorPayload });
      return { success: false, error: errorPayload?.error?.message || completion.statusText };
    }
    const text = responseBody?.choices?.[0]?.message?.content;
    if (typeof text !== "string" || text.length === 0) {
      const finishReason = responseBody?.choices?.[0]?.finish_reason || "unknown";
      console.error("LLM response missing message content", {
        model: openaiModel,
        finishReason,
        reasoningDetailsPresent: Array.isArray(responseBody?.choices?.[0]?.message?.reasoning_details),
      });
      return { success: false, error: `LLM response missing message content (finish_reason=${finishReason})` };
    }
    // Provider envelopes are parsed by the schema-owning downstream stage.
    // In particular, MiniMax may wrap valid JSON in one Markdown code fence;
    // rejecting that here would bypass the Generator/Assessor/Validator
    // parsers that explicitly and safely support the envelope.
    return buildSuccessfulLLMResult(text);
  } catch (error) {
    console.error("LLM endpoint error:", error);
    return { success: false, error: error.message };
  }
}

// Formal-task and icebreaker calls are separate, stateless completion paths.
// The shared function above is transport only: it stores no conversation and
// adds no context. Each wrapper receives messages from its own locked builder.
async function getLLMResponse(messages) {
  return requestChatCompletion(messages, llmMaxOutputTokens);
}

async function getIcebreakerLLMResponse(messages) {
  return requestChatCompletion(messages, Math.min(llmMaxOutputTokens, 500));
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function formatDuration(duration) {
  const totalSeconds = Math.floor(duration / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  const formattedMinutes = minutes > 0 ? `${minutes} mins` : "";
  const formattedSeconds = `${seconds} seconds`;
  return `${formattedMinutes}${formattedMinutes && formattedSeconds ? ", " : ""}${formattedSeconds}`;
}

function isFormalHumanMessage(message) {
  if (!message || message.sender?.id === "ai") return false;
  const messageType = message.messageType ?? "human";
  const speakerType = message.speakerType ?? "human";
  const messageStage = message.stage ?? "Discussion";
  return messageType === "human" && speakerType === "human" && messageStage === "Discussion";
}

function getHumanMessages(chat) {
  if (!chat) return [];
  return chat.filter(isFormalHumanMessage);
}

function isFormalContextMessage(message) {
  const stage = message?.stage ?? "Discussion";
  const type = message?.messageType ?? (message?.sender?.id === "ai" ? "facilitator" : "human");
  return stage === "Discussion" && (type === "human" || type === "facilitator");
}

function buildLocalContext(humanMessages, n = 6) {
  return humanMessages.slice(-n);
}

function recordOperationalEvent(game, event) {
  const entry = { timestamp: Date.now(), serverInstanceId: CALLBACKS_INSTANCE_ID, ...event };
  game.set("operationalEvents", [...(game.get("operationalEvents") || []), entry]);
  return entry;
// ── Feature extraction (calls Python sidecar) ─────────────────────────────────
}

// ── Generator context boundary (Static AND Adaptive) ──────────────────────────
//
// Static uses a deliberately narrower context assembler; Adaptive retains its
// existing dynamic context unchanged. Both conditions converge immediately
// afterward on the same LLM call, parsing, validation, publication, and log
// path in runSharedGeneration.
//
// `role` is the Controller-selected Adaptive role (utils.js's chooseRole(),
// only called once the shared gate -- utils.js's evaluateGate() -- has
// already returned Act) for Adaptive, or null for Static. `plan` is
// PolicyCompiler.js's compilePlan() output for that role (Adaptive with a
// gate Act only) or null (Static, or Adaptive with no plan available).
// Returns { blocked, reason?, metadata, systemPrompt?, userContent?,
// eligibleMessageIds?, aiOrSystemMessageIds?, recentAiMessageTexts?,
// allowedGroundingIds? }; the caller must check `blocked` before calling
// the LLM at all. An unknown/unsupported role comes back blocked here --
// never silently falls back to Static or another role
// (llmSystemPrompts/promptLoader, unmodified).
function buildGeneratorContext(game, players, chat, remainingTime, timeElapsed, facilitation, role, plan = null, promptResultOverride = null) {
  const promptResult = promptResultOverride ?? llmSystemPrompts(facilitation, role);
  if (promptResult.blocked) {
    return { blocked: true, reason: promptResult.reason, metadata: promptResult.metadata };
  }

  const publicTaskOverview = buildStaticSharedTaskOverview({
    generalInfo: game.currentRound?.get("generalInfo"),
    decisionOptions: game.currentRound?.get("decisionOptions"),
  });

  if (facilitation === "static") {
    const staticContext = buildStaticUserContext({
      chat,
      remainingTimeMs: remainingTime,
      elapsedTimeMs: timeElapsed,
      // 2026-08-13: prefer the live game roster over names derived
      // from chat (which only sees speakers so far) so the Static
      // prompt can @ a participant who has not yet spoken (e.g.
      // when a participant has been silent for the whole round).
      // StaticContext.mjs falls back to chat-derived names if this
      // is null.
      activeParticipantNames: players.map((p) => p.get("name")).filter((n) => typeof n === "string" && n.trim()),
    });
    return {
      blocked: false,
      metadata: promptResult.metadata,
      systemPrompt: promptResult.content.replace(
        "{{sharedTaskOverview}}",
        publicTaskOverview,
      ),
      taskGeneralContext: publicTaskOverview,
      ...staticContext,
    };
  }

  const checkpointDescriptor = `Checkpoint after ${getHumanMessages(chat).length} human message(s) so far this round. Participants: ${players.map((p) => p.get("name")).join(", ")}. Time remaining: ${formatDuration(remainingTime)}, elapsed: ${formatDuration(timeElapsed)}.`;

  const dynamicContext = buildDynamicUserContext({
    chat: chat.filter(isFormalContextMessage),
    checkpointDescriptor,
    selectedRoleForDisplay: promptResult.metadata.generationRole,
    generalInfo: publicTaskOverview,
    plan,
    // 2026-08-13: same live-roster pass-through as Static above.
    // Adaptive @ mentions can target any participant, including
    // those who have not yet spoken (the expander's "silence"
    // case), so the roster must come from `players`, not chat.
    activeParticipantNames: players.map((p) => p.get("name")).filter((n) => typeof n === "string" && n.trim()),
  });

  return {
    blocked: false,
    metadata: promptResult.metadata,
    systemPrompt: promptResult.content,
    taskGeneralContext: publicTaskOverview,
    userContent: dynamicContext.userContent,
    eligibleMessageIds: dynamicContext.eligibleMessageIds,
    aiOrSystemMessageIds: dynamicContext.aiOrSystemMessageIds,
    recentAiMessageTexts: dynamicContext.recentAiMessageTexts,
    allowedGroundingIds: dynamicContext.allowedGroundingIds,
    activeParticipantNames: dynamicContext.activeParticipantNames,
  };
}

// ── Shared generation/validation/publication path (Static AND Adaptive) ────────
//
// Phase 5 update (Q6 = "完整实现", audit-phase1.md §6): the post-selection
// path now has a repair loop. Per checkpoint, the Generator may be called
// up to 2 times (1 original + 1 repair), and the Validator LLM runs after
// each successful Generator attempt. The total is bounded:
//   - 1 Generator + 1 Validator on the first attempt
//   - 1 Generator + 1 Validator on the repair attempt (only if the first
//     Validator returned passed:false with at least one failedCriteria)
//   - persistent Specialist failure: caller may route once through the
//     shared Generalist bundle; rejected text is never shown to participants
//
// The Generator itself remains one LLM call per attempt (no internal
// regeneration). The repair's only effect on the Generator is a user-turn
// append ([PRIOR_FAILED_CRITERIA] section) that tells the LLM what to fix
// this time. The Validator is a separate LLM (validator.md) that audits
// the candidate against 7 boolean criteria (notGrounded / nonNeutral /
// roleMisaligned / inventedInformation / recommendationDetected /
// unsupportedInformationDetected / unsupportedConsensusClaim). On a
// failed first Validator audit, the repair attempt's Validator gets the
// same failedCriteria list as a hint (it is a re-audit, not a fresh
// review of the world).
//
// Returns:
//   {published: true, candidate, attempts, validator}    any published path
//   {published: false, reason?}                          silent path
// where `attempts` is 1 or 2 and `validator` is the FINAL Validator
// verdict (i.e. the one that authorised publication, or the last failed
// one for the silent path). Callers (Static / Generalist / Specialist)
// only read `published`; the rest is for llmLog / post-hoc audit.
async function runSharedGeneration(game, chatKey, built, logEntry, originatingRoundId, originatingStageId, chat) {
  logEntry.promptMetadata = built.metadata;

  if (built.blocked) {
    logEntry.reason = `AI request blocked: ${built.reason}`;
    logEntry.outcome = "SILENT";
    return { published: false };
  }

  // Returns false if the originating round/stage has changed (a later
  // attempt would be responding to a stale world). True if the same
  // stage is still active.
  function isOriginatingStageActive() {
    return (
      game.currentRound?.id === originatingRoundId &&
      game.currentStage?.id === originatingStageId &&
      game.currentStage?.get("name") === "Task"
    );
  }

  // One Generator attempt: LLM call + strict parse + schema + deterministic.
  // The user content defaults to the original `built.userContent`; the
  // repair attempt passes a modified version (with [PRIOR_FAILED_CRITERIA]
  // appended) via `userContentOverride`. Returns:
  //   {ok: true, candidate}
  //   {discarded: true}                       round/stage changed
  //   {silent: true, reason, logField?}       any failure
  async function attemptGeneration(userContentOverride = null) {
    const messages = [
      { role: "system", content: built.systemPrompt },
      { role: "user",   content: userContentOverride ?? built.userContent },
    ];
    logEntry.requestMade = true;
    logEntry.messagesOAIFormat = messages;

    const generatorStartedAt = Date.now();
    const llmResponse = await getLLMResponse(messages);
    logEntry.generatorLatenciesMs = [
      ...(logEntry.generatorLatenciesMs || []),
      Date.now() - generatorStartedAt,
    ];
    if (!isOriginatingStageActive()) return { discarded: true };
    if (!llmResponse.success) {
      return { silent: true, reason: `API Error: ${llmResponse.error}` };
    }
    logEntry.generatorRawResponses = [
      ...(logEntry.generatorRawResponses || []),
      { attempt: (logEntry.generatorRawResponses?.length || 0) + 1, rawText: llmResponse.rawText },
    ];
    logEntry.requestSuccess = true;

    const parseResult = parseGeneratorOutputStrict(llmResponse.rawText);
    if (!parseResult.ok) {
      return { silent: true, reason: `Invalid Generator output: ${parseResult.error}` };
    }

    const schemaResult = validateAgainstGenerationSchema(parseResult.parsed, built.metadata.generationRole);
    if (!schemaResult.ok) {
      return {
        silent: true,
        reason: "Generator output failed generation.schema.json",
        logField: { schemaErrors: schemaResult.errors },
      };
    }

    const deterministicResult = runDeterministicValidation(parseResult.parsed, {
      selectedRole: built.metadata.generationRole,
      eligibleMessageIds: built.eligibleMessageIds,
      aiOrSystemMessageIds: built.aiOrSystemMessageIds,
      recentAiMessageTexts: built.recentAiMessageTexts,
      allowedGroundingIds: built.allowedGroundingIds,
      // 2026-08-13: pipe the per-checkpoint participant roster into
      // the deterministic `@[Name]` mention check (GeneratorContract).
      // StaticContext.mjs / DynamicContext.mjs always populate this;
      // a missing/empty value disables the check (and is otherwise
      // harmless because the Validator LLM still catches the same
      // misuse semantically).
      activeParticipantNames: built.activeParticipantNames ?? null,
    });
    logEntry.deterministic = deterministicResult;
    if (!deterministicResult.passed) {
      return {
        silent: true,
        reason: `Generator output failed validation: ${deterministicResult.failedCriteria.join(", ")}`,
      };
    }

    return { ok: true, candidate: parseResult.parsed };
  }

  // Build the user-content append for the repair attempt. The
  // [PRIOR_FAILED_CRITERIA] section is the LLM-visible feedback that
  // differentiates a repair attempt from a fresh attempt; the Validator
  // prompt documents this section's exact shape (validator.md) so the
  // Generator prompt does not need to.
  function buildRepairUserContent(failedCriteria, priorCandidate) {
    const failedList = failedCriteria.join(", ");
    const priorJson = JSON.stringify(
      { role: priorCandidate.role, message: priorCandidate.message, groundingMessageIds: priorCandidate.groundingMessageIds },
      null,
      2
    );
    return `${built.userContent}\n\n---\n\n[PRIOR_FAILED_CRITERIA]\nThe previous candidate at this checkpoint was rejected by the semantic Validator for: ${failedList}.\nPrevious candidate (do NOT repeat it -- generate a NEW message):\n${priorJson}\nRegenerate a candidate that does NOT violate the listed criteria.`;
  }

  // One Validator LLM call. Treats the LLM-side failure (API / parse /
  // schema) as a Validator-unavailable signal distinct from a
  // passed:false verdict -- we have no failedCriteria to feed back in
  // the unavailable case, so no repair is triggered. The caller logs
  // this strongly and goes silent.
  async function runValidator(candidate, priorFailedCriteria = null, priorCandidate = null) {
    const validatorStartedAt = Date.now();
    const result = await validateCandidate({
      chat,
      candidate,
      selectedRole: built.metadata.generationRole,
      taskGeneralContext: built.taskGeneralContext,
      callLLM: getLLMResponse,
      priorFailedCriteria,
      priorCandidate,
    });
    logEntry.validatorLatenciesMs = [
      ...(logEntry.validatorLatenciesMs || []),
      Date.now() - validatorStartedAt,
    ];
    if (typeof result.rawText === "string") {
      logEntry.validatorRawResponses = [
        ...(logEntry.validatorRawResponses || []),
        { attempt: (logEntry.validatorRawResponses?.length || 0) + 1, rawText: result.rawText },
      ];
    }
    if (!result.success) {
      return { validatorFailed: true, code: result.code, error: result.error };
    }
    return { verdict: result.verdict };
  }

  // ── Attempt 1: Generator + Validator ──────────────────────────────────
  const a1 = await attemptGeneration();
  if (a1.discarded) {
    logEntry.reason = "Discarded stale AI result after the originating Discussion stage ended";
    logEntry.outcome = "SILENT";
    return { published: false };
  }
  if (a1.silent) {
    logEntry.reason = a1.reason;
    if (a1.logField) Object.assign(logEntry, a1.logField);
    logEntry.outcome = "SILENT";
    return { published: false };
  }

  const v1 = await runValidator(a1.candidate);
  if (v1.validatorFailed) {
    logEntry.reason = `Validator LLM unavailable on attempt 1 (${v1.code}): ${v1.error}`;
    logEntry.outcome = "SILENT_VALIDATOR_UNAVAILABLE";
    return { published: false };
  }
  logEntry.validator = v1.verdict;
  if (v1.verdict.passed) {
    logEntry.llmAction = a1.candidate;
    const posted = postGeneratorResultIfValid(game, chatKey, a1.candidate, built.metadata.generationRole, logEntry);
    logEntry.attempts = 1;
    logEntry.outcome = posted ? "PUBLISHED" : "SILENT";
    return { published: posted, candidate: a1.candidate, attempts: 1, validator: v1.verdict };
  }

  // ── Attempt 2: repair Generator (with Validator feedback) + re-audit ─
  const a2 = await attemptGeneration(buildRepairUserContent(v1.verdict.failedCriteria, a1.candidate));
  if (a2.discarded) {
    logEntry.reason = "Discarded stale AI result during repair (originating Discussion stage ended)";
    logEntry.outcome = "SILENT";
    return { published: false };
  }
  if (a2.silent) {
    logEntry.reason = `Repair Generator attempt failed: ${a2.reason}`;
    if (a2.logField) Object.assign(logEntry, a2.logField);
    logEntry.outcome = "SILENT_GENERATOR_FAILED_AFTER_VALIDATOR_REJECT";
    return { published: false };
  }

  const v2 = await runValidator(a2.candidate, v1.verdict.failedCriteria, a1.candidate);
  if (v2.validatorFailed) {
    logEntry.reason = `Validator LLM unavailable on repair (${v2.code}): ${v2.error}`;
    logEntry.outcome = "SILENT_VALIDATOR_UNAVAILABLE";
    return { published: false };
  }
  logEntry.validatorRepair = v2.verdict;
  logEntry.attempts = 2;
  if (v2.verdict.passed) {
    logEntry.llmAction = a2.candidate;
    const posted = postGeneratorResultIfValid(game, chatKey, a2.candidate, built.metadata.generationRole, logEntry);
    logEntry.outcome = posted ? "PUBLISHED" : "SILENT";
    return { published: posted, candidate: a2.candidate, attempts: 2, validator: v2.verdict };
  }

  // Persistent failure: both attempts failed the Validator. Silent +
  // strong log marker. Never a fallback stub message -- participants
  // never see a Validator-rejected attempt. The full failedCriteria
  // (both attempts) are logged so the researcher can audit post-hoc
  // which criteria the model couldn't satisfy.
  logEntry.reason = `Validator rejected both attempts. attempt1: [${v1.verdict.failedCriteria.join(", ")}]; attempt2: [${v2.verdict.failedCriteria.join(", ")}]`;
  logEntry.outcome = "SILENT_VALIDATOR_REJECTED";
  return { published: false, attempts: 2, validator: v2.verdict };
}

// ── S1-S4 sequence definitions ──────────────────────────────────────────────
//
// Inline in this file on purpose (not Counterbalancing.mjs -- that module is
// not used for this feature). Must not be changed: S1/S3 start Static+Task A
// or Static+Task B respectively (Round 1 static, Round 2 adaptive); S2/S4
// start Adaptive.
const SEQUENCES = {
  S1: {
    facilitationOrder: ["static", "adaptive"],
    taskOrder: [0, 1],
    taskVersionOrder: ["A", "B"],
  },
  S2: {
    facilitationOrder: ["adaptive", "static"],
    taskOrder: [0, 1],
    taskVersionOrder: ["A", "B"],
  },
  S3: {
    facilitationOrder: ["static", "adaptive"],
    taskOrder: [1, 0],
    taskVersionOrder: ["B", "A"],
  },
  S4: {
    facilitationOrder: ["adaptive", "static"],
    taskOrder: [1, 0],
    taskVersionOrder: ["B", "A"],
  },
};
const SEQUENCE_IDS = Object.keys(SEQUENCES);
const REVIEW_QUIZ_SAFETY_DURATION_SECONDS = 24 * 60 * 60;
const TASK_INFORMATION_DURATION_SECONDS = 10 * 60;
const WALKTHROUGH_DURATION_SECONDS = 10 * 60;
const ICEBREAKER_TRANSITION_DURATION_SECONDS = 10;
// The visible Break countdown is controlled by breakScheduledEndAt. This long
// safety duration prevents Empirica's timer from ending the stage before the
// server-validated readiness gate is satisfied; clients submit synchronously
// only after both the five-minute minimum and full-group readiness are true.
const BREAK_STAGE_SAFETY_DURATION_SECONDS = 24 * 60 * 60;
const TLX_DURATION_SECONDS = 10 * 60;
const SUBJECTIVE_SURVEY_DURATION_SECONDS = 10 * 60;
const BREAK_DURATION_SECONDS = 300;
const INDIVIDUAL_ASSESSMENT_DURATION_SECONDS = 10 * 60;

function addReviewQuizStage(round) {
  round.addStage({ name: "ReviewQuiz", duration: REVIEW_QUIZ_SAFETY_DURATION_SECONDS });
}

// ── Restart-safe randomized-block S1-S4 allocation (one claim per Game) ─────
//
// Every 4 Games get a shuffled permutation of {S1,S2,S3,S4} (a permuted
// block), guaranteeing each sequence appears exactly once per 4 Games,
// instead of two independent Math.random() < 0.5 coin flips (which cannot
// guarantee balance). A new block is generated only once the current one is
// fully claimed.
//
// The JSON ledger lives on Empirica's persistent Global scope. It contains
// every Game's durable claim plus counts and block history, shared across all
// Batches in this Tajriba database. The before-listener runs ahead of
// onGameStart so Round creation can fail closed unless a durable claim exists.
Empirica.before("game", "start", async (ctx, { game, start }) => {
  if (!start) return;
  if (game.get("assignmentPersistenceStatus") === "confirmed") return;
  const games = [...ctx.scopesByKind("game").values()];
  const { ledger, claim } = claimSequenceForStudy(ctx.globals, games, game, SEQUENCE_IDS);

  game.set("sequenceId",           claim.sequenceId);
  game.set("allocationNumber",     claim.allocationNumber);
  game.set("allocationBlockId",    claim.allocationBlockId);
  game.set("allocationPosition",   claim.allocationPosition);
  game.set("allocationClaimedAt",  claim.claimedAt);
  game.set("allocationMethod",     "global_persisted_least-count-permuted-block-v1");
  game.set("allocationLedgerKey",  RANDOMIZATION_LEDGER_KEY);
  game.batch?.set("sequenceAllocationSummaryV1", {
    ledgerKey: RANDOMIZATION_LEDGER_KEY,
    allocationNumber: ledger.allocationNumber,
    counts: ledger.counts,
    updatedAt: Date.now(),
  });

  try {
    await persistAssignmentOrBlock(researchPersistence(), {
      game_id: game.id,
      sequence_id: claim.sequenceId,
      allocation_number: claim.allocationNumber,
      allocation_block_id: claim.allocationBlockId,
      allocation_position: claim.allocationPosition,
      allocation_claimed_at: new Date(claim.claimedAt).toISOString(),
      allocation_method: "global_persisted_least-count-permuted-block-v1",
      ledger_key: RANDOMIZATION_LEDGER_KEY,
      assignment_status: "confirmed",
      updated_at: new Date().toISOString(),
    });
    game.set("assignmentPersistenceStatus", "confirmed");
  } catch (error) {
    game.set("assignmentPersistenceStatus", "blocked");
    game.set("assignmentPersistenceError", error.message);
    throw error;
  }
});

// ── onGameStart ───────────────────────────────────────────────────────────────

Empirica.onGameStart(({ game }) => {
  if (game.get("assignmentPersistenceStatus") !== "confirmed") {
    game.end("failed", game.get("assignmentPersistenceError") || "Research assignment persistence failed before this session could begin.");
    return;
  }
  const treatment = game.get("treatment");
  const { gameDuration, phase1Duration, introDuration } = treatment;
  // facilitation is no longer read from treatment. It is assigned per-round
  // below (from the sequence table) and read from round.get("facilitation")
  // at runtime.

  // Required treatment durations -- fail clearly rather than silently
  // substituting a default if one is ever missing/invalid (preserved from
  // an earlier, unrelated fix; not reintroducing baseline's silent
  // `|| defaultMinutes` fallback here).
  for (const [key, value] of Object.entries({ gameDuration, phase1Duration, introDuration })) {
    if (!Number.isFinite(value) || value <= 0) {
      throw new Error(`[onGameStart] game ${game.id}'s treatment has an invalid/missing ${key} (${JSON.stringify(value)}). Check .empirica/treatments.yaml.`);
    }
  }

  // Initialize game-level state
  if (!Array.isArray(game.get("llmLog"))) game.set("llmLog", []);
  if (!Number.isFinite(game.get("totalInterventions"))) game.set("totalInterventions", 0);
  if (!Number.isFinite(game.get("totalFallbackMessages"))) game.set("totalFallbackMessages", 0);
  if (!game.get("llmInFlight")) game.set("llmInFlight", {});
  if (!Array.isArray(game.get("operationalEvents"))) game.set("operationalEvents", []);
  game.set("activeCallbacksInstanceId", CALLBACKS_INSTANCE_ID);
  if (!game.get("systemInfo")) {
    game.set("systemInfo", {
      model: openaiModel,
      detectorPipeline: ["semantic_assessor", "evidence_checker", "gate"],
      thresholds: THRESHOLDS,
    });
  }

  // ── Randomized-block S1-S4 allocation ──────────────────────────────────────
  // The preceding `before("game", "start")` listener has already persisted
  // this claim globally and on the Game. Never silently fall back to an
  // in-memory draw if that durable allocation step failed.
  const sequenceId = game.get("sequenceId");
  if (!SEQUENCE_IDS.includes(sequenceId)) {
    throw new Error(`[onGameStart] game ${game.id} has no valid durable sequence allocation (${JSON.stringify(sequenceId)})`);
  }

  const sequence = SEQUENCES[sequenceId];
  // Preserved in case other code still reads these game-level attributes
  // (none found to depend on them as of this change, but not removed
  // without checking, per this task's explicit instruction).
  game.set("facilitationOrder", sequence.facilitationOrder);
  game.set("taskOrder",         sequence.taskOrder);
  game.set("taskVersionOrder",  sequence.taskVersionOrder);

  // Round/Stage creation -- standard Empirica pattern: the full field set is
  // passed directly into the single game.addRound() call. game.addRound()
  // does NOT return a live Round scope instance -- a round.set() call made
  // AFTER it returns is silently lost (confirmed against a real running
  // Empirica backend in an earlier audit; @empirica/core@1.12.0). Stages are
  // added immediately via the object that call returns.
  //
  // taskIndex is the zero-based exposure position (Round 1 = 0, Round 2 = 1).
  // taskVersion is the independent Task A/B material identity selected by the
  // sequence; it must not be inferred from taskIndex or facilitation.
  const round1 = game.addRound({
    name: "Round 1",
    facilitation: sequence.facilitationOrder[0],
    taskIndex:    0,
    taskVersion:  sequence.taskVersionOrder[0],
  });
  round1.addStage({ name: "TaskInformation",          duration: TASK_INFORMATION_DURATION_SECONDS });
  round1.addStage({ name: "Walkthrough",              duration: WALKTHROUGH_DURATION_SECONDS });
  addReviewQuizStage(round1);
  round1.addStage({ name: "IceBreakerStartCountdown", duration: ICEBREAKER_TRANSITION_DURATION_SECONDS });
  round1.addStage({ name: "Introduction",             duration: introDuration * 60 });
  round1.addStage({ name: "IceBreakerEndCountdown",   duration: ICEBREAKER_TRANSITION_DURATION_SECONDS });
  round1.addStage({ name: "InitialDecision",          duration: phase1Duration * 60 });
  round1.addStage({ name: "Task",                     duration: gameDuration * 60 });
  round1.addStage({ name: "FinalDecision",            duration: 90 });
  round1.addStage({ name: "IndividualAssessment",     duration: INDIVIDUAL_ASSESSMENT_DURATION_SECONDS });
  round1.addStage({ name: "TLX",                      duration: TLX_DURATION_SECONDS });
  round1.addStage({ name: "SubjectiveSurvey",         duration: SUBJECTIVE_SURVEY_DURATION_SECONDS });
  round1.addStage({ name: "Break",                    duration: BREAK_STAGE_SAFETY_DURATION_SECONDS });

  const round2 = game.addRound({
    name: "Round 2",
    facilitation: sequence.facilitationOrder[1],
    taskIndex:    1,
    taskVersion:  sequence.taskVersionOrder[1],
  });
  round2.addStage({ name: "TaskInformation",          duration: TASK_INFORMATION_DURATION_SECONDS });
  round2.addStage({ name: "Walkthrough",              duration: WALKTHROUGH_DURATION_SECONDS });
  addReviewQuizStage(round2);
  round2.addStage({ name: "IceBreakerStartCountdown", duration: ICEBREAKER_TRANSITION_DURATION_SECONDS });
  round2.addStage({ name: "Introduction",             duration: introDuration * 60 });
  round2.addStage({ name: "IceBreakerEndCountdown",   duration: ICEBREAKER_TRANSITION_DURATION_SECONDS });
  round2.addStage({ name: "InitialDecision",          duration: phase1Duration * 60 });
  round2.addStage({ name: "Task",                     duration: gameDuration * 60 });
  round2.addStage({ name: "FinalDecision",            duration: 90 });
  round2.addStage({ name: "IndividualAssessment",     duration: INDIVIDUAL_ASSESSMENT_DURATION_SECONDS });
  round2.addStage({ name: "TLX",                      duration: TLX_DURATION_SECONDS });
  round2.addStage({ name: "SubjectiveSurvey",         duration: SUBJECTIVE_SURVEY_DURATION_SECONDS });

  // Restore the original stable colour aliases. The shuffled slot controls the
  // participant's visible Green/Blue/Pink name, matching colour, and report
  // profile, and stays fixed across both rounds.
  const aliasSource = taskConfig["tasks"][0]["playerConfig"];
  if (game.players.length > aliasSource.length) {
    console.error(`[onGameStart] Not enough alias slots: need ${game.players.length}, have ${aliasSource.length}`);
  } else {
    const shuffledSlots = _.shuffle(aliasSource.map((_entry, i) => i));
    game.players.forEach((player, i) => {
      const slot = shuffledSlots[i];
      player.set("name",        aliasSource[slot].playerName);
      player.set("participantNumber", i + 1);
      player.set("participantColorIndex", slot);
      player.set("hexCode",     aliasSource[slot].hexCode);
      player.set("profileSlot", slot);
      player.set("researchGameId", game.id);
    });
  }

  const mirrorTimestamp = new Date().toISOString();
  queueResearchMirror("game_structure", async () => {
    const persistence = researchPersistence();
    await persistence.upsertParticipants(game.players.map((player) => ({
      participant_id: researchParticipantId(game.id, player.id),
      game_id: game.id,
      participant_number: player.get("participantNumber"),
      profile_slot: player.get("profileSlot"),
      participant_status: "assigned",
      joined_at: mirrorTimestamp,
      updated_at: mirrorTimestamp,
    })));
    await persistence.upsertRounds([
      {
        round_id: round1.id, game_id: game.id, task_index: 0,
        task_version: sequence.taskVersionOrder[0], facilitation: sequence.facilitationOrder[0],
        round_status: "created", updated_at: mirrorTimestamp,
      },
      {
        round_id: round2.id, game_id: game.id, task_index: 1,
        task_version: sequence.taskVersionOrder[1], facilitation: sequence.facilitationOrder[1],
        round_status: "created", updated_at: mirrorTimestamp,
      },
    ]);
  });
});

// ── onRoundStart ──────────────────────────────────────────────────────────────

Empirica.onRoundStart(({ round }) => {
  const game = round.currentGame;
  round.set("callbacksInitializedAt", Date.now());
  round.set("callbacksInstanceId", CALLBACKS_INSTANCE_ID);
  const taskIndex = round.get("taskIndex");
  const taskVersion = round.get("taskVersion");
  const matchingTasks = taskConfig.tasks.filter((candidate) => candidate.taskVersion === taskVersion);
  const task = matchingTasks.length === 1 ? matchingTasks[0] : null;

  queueResearchMirror("round_started", () => researchPersistence().upsertRounds({
    round_id: round.id, game_id: game.id, task_index: taskIndex, task_version: taskVersion,
    facilitation: round.get("facilitation"), round_status: "started",
    started_at: new Date().toISOString(), updated_at: new Date().toISOString(),
  }));

  if (!task) {
    console.error(`[onRoundStart] No task found for taskVersion ${JSON.stringify(taskVersion)} (exposure taskIndex ${taskIndex})`);
    return;
  }

  // Phase 3: reset the per-round checkpoint state via the manager. This
  // includes the legacy fields below (humanMessageCount, lastRole,
  // synthesiserFired) plus the new ones (messagesSinceLastPublish,
  // attemptedThisRound, publishedThisRound, lastAttemptTimestamp,
  // lastHandledCheckpoint, interventionHistory, postInterventionUptake,
  // unresolvedNeed, lastCheckedFactors). See CheckpointManager.emptyCheckpointState.
  resetRoundState(game);

  // Set task content for this round
  // MIGRATED from old 2nd (TEMP-BE-006 there): round-scoped, not game-level.
  // Task A and Task B have different generalInfo text; a flat game.set(...)
  // here would be overwritten the moment Round 2's onRoundStart fires, which
  // could race against a Round 1 client still rendering FinalDecision.
  round.set("generalInfo", task["generalInfo"]);
  round.set("decisionOptions", task["decisionOptions"]); // Blair's own line, unchanged -- already round-scoped and correct
  round.set("sequenceId", game.get("sequenceId"));

  // MIGRATED from old 2nd (TEMP-BE-007 there): use the stable profileSlot
  // assigned once in onGameStart -- do NOT reshuffle or reassign name/hexCode
  // here (that was the regression this migration removes). Only this round's
  // task-specific report is selected here, keyed by the player's fixed slot,
  // and saved round-scoped (player.round.set, not flat player.set) so Round 1
  // and Round 2 content can never overwrite each
  // other. player.round is safe to use here: traced the Empirica admin SDK
  // source (chunk-CA6WWEPS.js) and confirmed game.set("stageID",
  // nextStage.id) always runs before nextRound.set("start", true) on every
  // round transition (including Round 1's own start), so player.currentStage
  // / player.currentRound / player.round are already correctly pointing at
  // *this* round by the time this callback runs -- not stale.
  const playerConfig = task["playerConfig"];

  if (game.players.length > playerConfig.length) {
    console.error(`[onRoundStart] Not enough player configs for taskVersion ${taskVersion}: need ${game.players.length}, have ${playerConfig.length}`);
    return;
  }

  game.players.forEach((player) => {
    const slot = player.get("profileSlot");
    if (slot === undefined || slot === null || !playerConfig[slot]) {
      console.error(`[onRoundStart] Player ${player.id} has no valid profileSlot (got ${JSON.stringify(slot)})`);
      return;
    }
    player.round.set("playerContent", playerConfig[slot].playerContent);
    player.round.set("participantId", player.id);
    player.round.set("roundIndex", taskIndex);
    player.round.set("taskVersion", taskVersion);
    player.round.set("facilitation", round.get("facilitation"));
    player.round.set("profileSlot", slot);
  });
});

// ── onStageStart ──────────────────────────────────────────────────────────────

function assignedHumanPlayers(game) {
  // This repository has no explicit withdrawal/admin-removal state. Keep all
  // assigned players required; socket presence and generic `ended` are not
  // treated as proof of withdrawal.
  return game.players;
}

function updateBreakReadySummary(stage) {
  if (!stage || stage.get("name") !== "Break") return { readyCount: 0, totalCount: 0, allReady: false };
  const requiredPlayers = assignedHumanPlayers(stage.currentGame);
  const readyCount = requiredPlayers.filter((participant) => participant.round?.get("breakReadyStatus") === "ready").length;
  const totalCount = requiredPlayers.length;
  const allReady = totalCount > 0 && readyCount === totalCount;
  stage.round.set("breakReadyCount", readyCount);
  stage.round.set("breakRequiredCount", totalCount);
  stage.round.set("breakAllReady", allReady);
  return { readyCount, totalCount, allReady };
}

function finalDecisionDrafts(game) {
  return assignedHumanPlayers(game).map((participant) => ({
    participantId: participant.id,
    choice: participant.round?.get("groupFinalChoice") || "",
    confidence: participant.round?.get("groupChoiceConfidence") ?? null,
    confirmedChoice: participant.round?.get("groupFinalConfirmedChoice") || null,
  }));
}

function publishFinalDecisionStatus(round, summary) {
  round.set("finalDecisionAgreementStatus", summary.status);
  round.set("finalDecisionMatchedChoice", summary.matchedChoice);
}

function clearFinalDecisionConfirmations(game) {
  for (const participant of assignedHumanPlayers(game)) {
    participant.round.set("groupFinalConfirmedChoice", null);
    participant.round.set("groupFinalConfirmedAt", null);
  }
}

function finalizeGroupDecision(stage, { timedOut = false, now = Date.now() } = {}) {
  const round = stage?.round;
  const game = stage?.currentGame;
  if (!round || !game || round.get("finalDecisionConfirmed")) return false;
  const drafts = finalDecisionDrafts(game);
  const summary = summarizeFinalDecisionDrafts(drafts);
  if (!timedOut && (summary.status !== "agreed" || !allFinalDecisionConfirmationsMatch(drafts, summary.matchedChoice))) return false;

  const classification = classifyFinalDecision(summary.matchedChoice, { timedOut });
  // Write the official result once. The latest private drafts are retained
  // separately for analysis and are never used as a first-player fallback.
  round.set("officialGroupFinalChoice", classification.officialChoice);
  round.set("finalDecisionOutcome", classification.outcome);
  round.set("finalDecisionTimedOut", classification.timedOut);
  round.set("finalDecisionFinalizedAt", now);
  round.set("finalDecisionDraftChoices", drafts.map(({ participantId, choice, confidence }) => ({ participantId, choice, confidence })));
  round.set("finalDecisionConfirmed", true);
  publishFinalDecisionStatus(round, { status: "finalized", matchedChoice: summary.matchedChoice });

  for (const participant of assignedHumanPlayers(game)) {
    const choice = participant.round.get("groupFinalChoice") || "";
    const confidence = participant.round.get("groupChoiceConfidence") ?? null;
    participant.round.set("finalDecision", {
      choice,
      confidence,
      submittedAt: now,
      officialGroupFinalChoice: classification.officialChoice,
      finalDecisionOutcome: classification.outcome,
    });
    if (!participant.stage?.get("submit")) participant.stage?.set("submit", true);
  }
  stage.set("ended", true);
  Empirica.flush();
  return true;
}

function appendCanonicalMessage(game, attribute, fields) {
  const counters = { ...(game.get("messageSequenceCounters") || {}) };
  const sequencePosition = allocateSequencePosition(counters, attribute);
  game.set("messageSequenceCounters", counters);
  const message = buildCanonicalMessage({ ...fields, sequencePosition });
  game.append(attribute, message);
  const round = game.currentRound;
  if (round) {
    queueResearchMirror("message", () => researchPersistence().upsertMessage(buildMessageRow({
      gameId: game.id, roundId: round.id, transcriptKey: attribute, message,
    })));
  }
  return message;
}

function appendTimedMessage(stage, attribute, content, messageType = MESSAGE_TYPES.TIMER_REMINDER) {
  if (!stage?.isCurrent?.()) return false;
  const game = stage.currentGame;
  const timestamp = Date.now();
  appendCanonicalMessage(game, attribute, {
    messageId: `${messageType}-${stage.id}-${timestamp}`,
    groupId: game.id,
    speakerId: `system-${messageType}`,
    roundIndex: stage.round.get("index"),
    stage: stage.get("name") === "Task" ? "Discussion" : "IceBreaker",
    messageType,
    speakerType: messageType,
    timestamp,
    content,
    sender: { id: `system-${messageType}`, name: "Timer", hexCode: "4B5563", avatar: "⏱️" },
  });
  // Timer callbacks run outside a player mutation. Flush immediately so the
  // reminder is delivered at its scheduled time instead of waiting for the
  // next chat message or another state change to flush the collector.
  Empirica.flush();
  return true;
}

function icebreakerActivityPrompt(taskVersion) {
  if (taskVersion === "A") {
    return "For this activity, choose whether you would rather speak every language fluently or play every musical instrument expertly, share a short reason, and invite a teammate to answer.";
  }
  return "For this activity, build a word chain starting with Rocket: each new word begins with the last letter of the previous word, one word per turn, with no repeats.";
}

function appendIcebreakerOpening(stage, introChatKey) {
  const game = stage.currentGame;
  const existing = game.get(introChatKey) || [];
  if (existing.some((message) => message?.messageType === MESSAGE_TYPES.ICE_BREAKING_FACILITATOR)) return false;
  const timestamp = Date.now();
  appendCanonicalMessage(game, introChatKey, {
    messageId: `icebreaker-opening-${stage.id}`,
    groupId: game.id,
    speakerId: "icebreaker-ai",
    roundIndex: stage.round.get("index"),
    stage: "IceBreaker",
    messageType: MESSAGE_TYPES.ICE_BREAKING_FACILITATOR,
    speakerType: MESSAGE_TYPES.ICE_BREAKING_FACILITATOR,
    timestamp,
    content: buildIcebreakerOpening({
      participantNames: game.players.map((participant) => participant.get("name")),
      activityPrompt: icebreakerActivityPrompt(stage.round.get("taskVersion")),
    }),
    sender: { id: "ai", name: "Facilitator", avatar: "https://api.dicebear.com/9.x/initials/svg?backgroundColor=000000&seed=F" },
  });
  return true;
}

Empirica.onStageStart(({ stage }) => {
  const game = stage.currentGame;
  stage.set("callbacksInitializedAt", Date.now());
  stage.set("callbacksInstanceId", CALLBACKS_INSTANCE_ID);
  const { gameDuration } = game.get("treatment");
  const now = Date.now();
  const stageName = stage.get("name");
  if (["Task", "InitialDecision", "FinalDecision", "IndividualAssessment"].includes(stageName)) {
    stage.round.set(`${stageName}StartedAt`, now);
  }
  if (stageName === "Task") {
    // gameDuration is a required treatment factor (.empirica/treatments.yaml)
    // -- fail clearly rather than silently substituting a default if it is
    // ever missing/invalid.
    if (!Number.isFinite(gameDuration) || gameDuration <= 0) {
      throw new Error(`[onStageStart] game ${game.id}'s treatment has an invalid/missing gameDuration (${JSON.stringify(gameDuration)}). Check .empirica/treatments.yaml.`);
    }
    game.set("taskStartTime", now);
    game.set("deadline",      now + gameDuration * 60 * 1000);
    const chatKey = `chat_round_${stage.round.get("index")}`;
    const durationMs = gameDuration * 60 * 1000;
    setTimeout(() => appendTimedMessage(stage, chatKey, `${Math.ceil(gameDuration / 2)} minutes remain in the discussion.`), durationMs / 2);
    if (durationMs > 60_000) setTimeout(() => appendTimedMessage(stage, chatKey, "One minute remains in the discussion."), durationMs - 60_000);
  }
  if (stageName === "Introduction") {
    const durationMs = stage.get("duration") * 1000;
    const introChatKey = `intro_round_${stage.round.get("index")}`;
    appendIcebreakerOpening(stage, introChatKey);
    if (durationMs > 30_000) setTimeout(() => appendTimedMessage(stage, introChatKey, "Thirty seconds remain in the IceBreaker."), durationMs - 30_000);
    Empirica.flush();
  }
  if (stageName === "FinalDecision") {
    stage.round.set("finalDecisionAgreementStatus", "not_agreed");
    stage.round.set("finalDecisionMatchedChoice", null);
    stage.round.set("officialGroupFinalChoice", null);
    stage.round.set("finalDecisionOutcome", null);
    stage.round.set("finalDecisionTimedOut", false);
    stage.round.set("finalDecisionFinalizedAt", null);
    stage.round.set("finalDecisionDraftChoices", []);
    stage.round.set("finalDecisionConfirmed", false);
    for (const participant of assignedHumanPlayers(game)) {
      participant.round.set("groupFinalChoice", "");
      participant.round.set("groupChoiceConfidence", null);
      participant.round.set("groupFinalConfirmedChoice", null);
      participant.round.set("groupFinalConfirmedAt", null);
    }
    // Empirica owns the visible stage clock; this server timer is the
    // authoritative fail-safe and remains valid across client refreshes.
    setTimeout(() => {
      if (stage.get("name") === "FinalDecision" && !stage.round.get("finalDecisionConfirmed")) {
        finalizeGroupDecision(stage, { timedOut: true });
      }
    }, 90_000);
    Empirica.flush();
  }
  if (stageName === "IndividualAssessment" && stage.round.get("finalDecisionOutcome") === "consensus_choice") {
    for (const participant of assignedHumanPlayers(game)) {
      participant.stage?.set("submit", true);
    }
    stage.set("ended", true);
    Empirica.flush();
  }
  if (stageName === "Break") {
    const round = stage.round;
    if (!round.get("breakStartedAt")) {
      round.set("breakStartedAt", now);
      round.set("breakScheduledEndAt", now + BREAK_DURATION_SECONDS * 1000);
      for (const player of assignedHumanPlayers(game)) {
        player.round.set("breakReadyStatus", "not_ready");
      }
      updateBreakReadySummary(stage);
    }
  }
});

Empirica.on("player", "breakReadyRequest", (ctx, { player }) => {
  const stage = player.currentGame?.currentStage;
  if (!stage || stage.get("name") !== "Break") return;
  const round = stage.round;
  const now = Date.now();
  const scheduledEnd = round.get("breakScheduledEndAt");
  if (!canConfirmBreak(scheduledEnd, now)) {
    player.round.set("breakReadyRejectedAt", now);
    return;
  }
  if (player.round.get("breakReadyStatus") !== "ready") {
    player.round.set("breakReadyStatus", "ready");
    player.round.set("breakReadyConfirmedAt", now);
  }
  updateBreakReadySummary(stage);
});

Empirica.on("player", "discussionAdvanceRequest", (_ctx, { player, discussionAdvanceRequest }) => {
  const game = player.currentGame;
  const round = game?.currentRound;
  const stage = game?.currentStage;
  if (!game || !round || !stage || stage.get("name") !== "Task" || stage.get("ended")) return;
  if (!discussionAdvanceRequest || discussionAdvanceRequest.stageId !== stage.id || discussionAdvanceRequest.roundId !== round.id) return;

  // Unanimous readiness is already the native Empirica Step transition. A
  // second server-side `stage.ended=true` for the same event races that
  // transition and can produce "from state mismatch" warnings. This recovery
  // listener is therefore reserved for a missed deadline transition only.
  if (discussionAdvanceRequest.reason !== "deadline_reached") return;
  if (game.get("discussionAdvanceCommittedStageId") === stage.id) return;
  const deadline = game.get("deadline");
  const deadlineReached = Number.isFinite(deadline) && Date.now() >= deadline;
  if (!deadlineReached) return;

  // Claim the recovery before writing `ended`, making repeated client timer
  // requests idempotent within the single callbacks process.
  game.set("discussionAdvanceCommittedStageId", stage.id);
  stage.set("ended", true);
  Empirica.flush();
});

Empirica.on("player", "finalDecisionDraftRequest", (_ctx, { player, finalDecisionDraftRequest: request }) => {
  const game = player.currentGame;
  const round = game?.currentRound;
  const stage = game?.currentStage;
  if (!game || !round || !stage || stage.get("name") !== "FinalDecision" || round.get("finalDecisionConfirmed")) return;
  if (!request || request.roundId !== round.id || request.stageId !== stage.id) return;

  const validChoices = new Set([
    ...(round.get("decisionOptions") || []).map((option) => option.id),
    NO_GROUP_FINAL_DECISION,
  ]);
  const choice = typeof request.choice === "string" ? request.choice : "";
  const confidence = request.confidence === null ? null : Number(request.confidence);
  if (!validChoices.has(choice) || (confidence !== null && (!Number.isFinite(confidence) || confidence < 0 || confidence > 100))) return;

  const choiceChanged = player.round.get("groupFinalChoice") !== choice;
  player.round.set("groupFinalChoice", choice);
  player.round.set("groupChoiceConfidence", confidence);
  player.round.set("finalDecision", { choice, confidence, updatedAt: Date.now() });
  if (choiceChanged) {
    // A new draft invalidates every confirmation tied to the previous
    // agreement attempt, including confirmations from other participants.
    clearFinalDecisionConfirmations(game);
  }
  publishFinalDecisionStatus(round, summarizeFinalDecisionDrafts(finalDecisionDrafts(game)));
  Empirica.flush();
});

Empirica.on("player", "finalDecisionConfirmRequest", (_ctx, { player, finalDecisionConfirmRequest: request }) => {
  const game = player.currentGame;
  const round = game?.currentRound;
  const stage = game?.currentStage;
  if (!game || !round || !stage || stage.get("name") !== "FinalDecision" || round.get("finalDecisionConfirmed")) return;
  if (!request || request.roundId !== round.id || request.stageId !== stage.id) return;

  const drafts = finalDecisionDrafts(game);
  const summary = summarizeFinalDecisionDrafts(drafts);
  const ownChoice = player.round.get("groupFinalChoice");
  const allConfidenceRecorded = drafts.every((draft) => Number.isFinite(draft.confidence));
  if (summary.status !== "agreed" || !allConfidenceRecorded || !ownChoice || ownChoice !== summary.matchedChoice) return;

  // Duplicate confirmations are idempotent and always bind to the current
  // matching choice, never merely to a participant identity.
  player.round.set("groupFinalConfirmedChoice", summary.matchedChoice);
  player.round.set("groupFinalConfirmedAt", Date.now());
  finalizeGroupDecision(stage);
  Empirica.flush();
});

Empirica.on("playerStage", "submit", (_ctx, { playerStage, submit }) => {
  if (!submit || !playerStage?.stage?.isCurrent?.()) return;
  const player = playerStage.player;
  const round = playerStage.stage.round;
  const stageName = playerStage.stage.get("name");
  const now = Date.now();
  const fieldsByStage = {
    InitialDecision: ["initialSubmittedAt", "initialCompletionDurationMs", "initialDecisionTimeoutReason"],
    FinalDecision: ["groupFinalSubmittedAt", "groupFinalCompletionDurationMs", "groupFinalTimeoutReason"],
    IndividualAssessment: ["individualAssessmentSubmittedAt", "individualAssessmentCompletionDurationMs", "individualAssessmentTimeoutReason"],
  };
  const fields = fieldsByStage[stageName];
  if (!fields || player.round.get(fields[0])) return;
  player.round.set(fields[0], now);
  const startedAt = round.get(`${stageName}StartedAt`) ?? now;
  player.round.set(fields[1], now - startedAt);
  if (fields[2]) player.round.set(fields[2], null);
});

Empirica.on("player", "humanMessageRequest", (_ctx, { player, humanMessageRequest: request }) => {
  const game = player.currentGame;
  const round = game?.currentRound;
  const stage = game?.currentStage;
  if (!game || !round || !stage) return;
  const dedupeKey = `${player.id}:${request?.requestId ?? "invalid"}`;
  const processed = { ...(game.get("processedHumanMessageRequests") || {}) };
  if (processed[dedupeKey]) {
    player.set("humanMessageRequestResult", processed[dedupeKey]);
    return;
  }
  const now = Date.now();
  const reviewed = reviewHumanMessageRequest({
    request,
    playerId: player.id,
    currentRoundId: round.id,
    currentRoundIndex: round.get("index"),
    currentStageId: stage.id,
    currentStageName: stage.get("name"),
    deadline: game.get("deadline"),
    now,
  });
  const result = { requestId: request?.requestId ?? null, status: reviewed.accepted ? "accepted" : "rejected", reason: reviewed.reason };
  if (reviewed.accepted) {
    appendCanonicalMessage(game, reviewed.attribute, {
      messageId: reviewed.messageId,
      groupId: game.id,
      participantId: player.id,
      roundIndex: round.get("index"),
      stage: reviewed.stage,
      messageType: MESSAGE_TYPES.HUMAN,
      speakerType: MESSAGE_TYPES.HUMAN,
      timestamp: now,
      content: reviewed.content,
      sender: {
        id: player.id,
        name: player.get("name") || player.id,
        hexCode: player.get("hexCode"),
        avatar: `https://api.dicebear.com/8.x/identicon/svg?rowColor=${player.get("hexCode")}`,
      },
    });
  }
  processed[dedupeKey] = result;
  game.set("processedHumanMessageRequests", processed);
  player.set("humanMessageRequestResult", result);
});

// ── Icebreaker-only @Facilitator path ───────────────────────────────────────
// This listener cannot enter the formal detector/generator/validator pipeline.
// Its context builder accepts only the isolated intro_round_N transcript.
async function handleIcebreakerChat(_env, { game }) {
  const round = game.currentRound;
  const stage = game.currentStage;
  if (!round || !stage || stage.get("name") !== "Introduction") return;

  const roundIndex = round.get("index");
  const introChatKey = `intro_round_${roundIndex}`;
  const chat = game.get(introChatKey) || [];
  const lastMessage = chat[chat.length - 1];
  if (
    !lastMessage
    || lastMessage.stage !== "IceBreaker"
    || lastMessage.speakerType !== MESSAGE_TYPES.HUMAN
    || !containsFacilitatorMention(lastMessage.content ?? lastMessage.text ?? "")
  ) return;

  const messageId = lastMessage.messageId;
  if (typeof messageId !== "string" || !messageId) return;
  const handled = { ...(game.get("icebreakerFacilitatorHandledMessageIds") || {}) };
  if (handled[messageId]) return;
  handled[messageId] = { status: "pending", startedAt: Date.now() };
  game.set("icebreakerFacilitatorHandledMessageIds", handled);
  Empirica.flush();

  const originatingRoundId = round.id;
  const originatingStageId = stage.id;
  const llmMessages = buildIcebreakerLLMMessages(chat);
  const response = await getIcebreakerLLMResponse(llmMessages);
  const parsed = response.success ? parseIcebreakerLLMResponse(response.rawText) : { ok: false, reason: response.error };

  if (
    game.currentRound?.id !== originatingRoundId
    || game.currentStage?.id !== originatingStageId
    || game.currentStage?.get("name") !== "Introduction"
  ) return;

  const content = parsed.ok
    ? parsed.message
    : "I can help using only what has been shared in this icebreaker chat. Please rephrase your question or ask about the icebreaker activity.";
  const timestamp = Date.now();
  appendCanonicalMessage(game, introChatKey, {
    messageId: `icebreaker-facilitator-${originatingStageId}-${timestamp}`,
    groupId: game.id,
    speakerId: "icebreaker-ai",
    roundIndex,
    stage: "IceBreaker",
    messageType: MESSAGE_TYPES.ICE_BREAKING_FACILITATOR,
    speakerType: MESSAGE_TYPES.ICE_BREAKING_FACILITATOR,
    timestamp,
    content,
    sender: { id: "ai", name: "Facilitator", avatar: "https://api.dicebear.com/9.x/initials/svg?backgroundColor=000000&seed=F" },
  });
  game.set("icebreakerFacilitatorHandledMessageIds", {
    ...(game.get("icebreakerFacilitatorHandledMessageIds") || {}),
    [messageId]: { status: parsed.ok ? "published" : "safe_fallback", finishedAt: timestamp },
  });
  game.set("icebreakerLLMLog", [
    ...(game.get("icebreakerLLMLog") || []),
    {
      timestamp,
      roundIndex,
      requestMessageId: messageId,
      outcome: parsed.ok ? "PUBLISHED" : "SAFE_FALLBACK",
      failureReason: parsed.ok ? null : parsed.reason,
      contextBoundary: "PUBLIC_ICEBREAKER_CHAT_ONLY",
      model: openaiModel,
    },
  ]);
  Empirica.flush();
}

Empirica.on("game", "intro_round_0", handleIcebreakerChat);
Empirica.on("game", "intro_round_1", handleIcebreakerChat);

// ── on("game", "chat_round_N") ────────────────────────────────────────────────

// GRAIL's single, shared chat-publication path (Static AND Adaptive) --
// final defensive check plus the actual game.append/totalInterventions
// write. By the time this is called from runSharedGeneration, the schema,
// deterministic, and live Semantic Validator checks have passed, so these
// checks are a final defensive guard. Returns true if a message was posted.
function postGeneratorResultIfValid(game, chatKey, llmAction, expectedRole, logEntry) {
  if (!llmAction || typeof llmAction.message !== "string" || !llmAction.message.trim()) {
    logEntry.reason = "LLM response missing a valid non-empty 'message' field (per generation.schema.json)";
    return false;
  }
  if (llmAction.role !== expectedRole) {
    logEntry.reason = `LLM response role "${llmAction.role}" does not match the expected role "${expectedRole}" (base.md OUTPUT CONTRACT requires role to be unchanged) -- not posted`;
    return false;
  }
  const publishedAt = Date.now();
  const publishedMessage = appendCanonicalMessage(game, chatKey, {
    messageId: `facilitator-${game.currentRound?.id}-${publishedAt}`,
    groupId: game.id,
    speakerId: "ai",
    roundIndex: game.currentRound?.get("index"),
    stage: "Discussion",
    messageType: MESSAGE_TYPES.FACILITATOR,
    speakerType: MESSAGE_TYPES.FACILITATOR,
    timestamp: publishedAt,
    content: llmAction.message,
    sender: { id: "ai", name: "Facilitator", avatar: `https://api.dicebear.com/9.x/initials/svg?backgroundColor=000000&seed=F` },
  });
  logEntry.messageAdded = true;
  logEntry.countsAsIntervention = true;
  logEntry.publishedMessageId = publishedMessage.messageId;
  game.set("totalInterventions", (game.get("totalInterventions") || 0) + 1);
  return true;
}

// A participant-requested turn must receive a visible response even when the
// prompt, model, parser, or Validator is unavailable. This deterministic
// fallback is intentionally neutral and reveals no hidden information.
function postParticipantRequestFallback(game, chatKey, logEntry) {
  const publishedAt = Date.now();
  const publishedMessage = appendCanonicalMessage(game, chatKey, {
    messageId: `facilitator-fallback-${game.currentRound?.id}-${publishedAt}`,
    groupId: game.id,
    speakerId: "ai",
    roundIndex: game.currentRound?.get("index"),
    stage: "Discussion",
    messageType: MESSAGE_TYPES.FACILITATOR,
    speakerType: MESSAGE_TYPES.FACILITATOR,
    timestamp: publishedAt,
    content: "I couldn’t produce a verified answer using the shared task information and public discussion. Please rephrase your question or point to the public option, criterion, claim, or message you want me to address.",
    sender: { id: "ai", name: "Facilitator", avatar: `https://api.dicebear.com/9.x/initials/svg?backgroundColor=000000&seed=F` },
  });
  logEntry.messageAdded = true;
  logEntry.countsAsIntervention = false;
  logEntry.publishedMessageId = publishedMessage.messageId;
  logEntry.fallbackUsed = "PARTICIPANT_REQUEST_SAFE_CLARIFICATION";
  logEntry.outcome = "PUBLISHED_REQUEST_FALLBACK";
  game.set("totalFallbackMessages", (game.get("totalFallbackMessages") || 0) + 1);
  return true;
}

async function handleChat(env, { game }) {
  const recovered = recoverInterruptedInFlight(game, CALLBACKS_INSTANCE_ID);
  if (recovered.length > 0) Empirica.flush();
  const previousCallbacksInstanceId = game.get("activeCallbacksInstanceId");
  if (previousCallbacksInstanceId && previousCallbacksInstanceId !== CALLBACKS_INSTANCE_ID) {
    recordOperationalEvent(game, {
      type: "CALLBACKS_RECONNECTED_DURING_GAME",
      previousServerInstanceId: previousCallbacksInstanceId,
    });
    Empirica.flush();
  }
  if (previousCallbacksInstanceId !== CALLBACKS_INSTANCE_ID) {
    game.set("activeCallbacksInstanceId", CALLBACKS_INSTANCE_ID);
  }
  const currentRound = game.currentRound;
  const roundIndex   = currentRound?.get("index");
  const chatKey      = `chat_round_${roundIndex}`;

  // Guard: make sure the chatKey matches what triggered this listener
  if (roundIndex === null || roundIndex === undefined) return;
  if (!game.get(chatKey)) return;

  // Round-level Static/Adaptive routing (Prompt 3A, unchanged): read from
  // the current Round, never from game.get("treatment") -- treatment-level
  // metadata must never override the Round-level facilitation assignment.
  const facilitation = currentRound?.get("facilitation");
  if (!facilitation) {
    recordOperationalEvent(game, { type: "MISSING_ROUND_FACILITATION", roundId: currentRound?.id ?? null });
    Empirica.flush();
    return;
  }

  const players = game.players;
  const chat = game.get(chatKey) || [];
  if (!chat.length) return;

  const lastMessage = chat[chat.length - 1];
  if (!isFormalHumanMessage(lastMessage)) return;

  const currentStageName = game.currentStage?.get("name");
  if (currentStageName !== "Task") return;
  if (!Number.isFinite(game.get("deadline")) || !Number.isFinite(game.get("taskStartTime"))) {
    recordOperationalEvent(game, {
      type: "MISSING_TASK_TIMING_STATE",
      roundId: currentRound.id,
      stageId: game.currentStage?.id ?? null,
    });
    Empirica.flush();
    return;
  }
  const originatingRoundId = currentRound.id;
  const originatingStageId = game.currentStage.id;

  // ── Count the new human message (AI messages do not count, and
  // we already early-returned above if the last message is from AI). ──
  const humanMessageCount = (game.get("humanMessageCount") || 0) + 1;
  game.set("humanMessageCount", humanMessageCount);

  // ── Increment the opportunity counter (Phase 3: also tracked as
  // messagesSinceLastPublish; the legacy messagesSinceLastIntervention
  // field is kept as a derived/legacy alias so existing logs / tests
  // that reference it don't break). ──
  const messagesSinceLastPublish = (game.get("messagesSinceLastPublish") ?? 0) + 1;
  game.set("messagesSinceLastPublish", messagesSinceLastPublish);
  // Legacy alias (was reset to 0 on every attempt in the v1 code; now
  // it tracks the same counter as messagesSinceLastPublish, so old
  // log readers and tests that read it still get a sensible value).
  game.set("messagesSinceLastIntervention", messagesSinceLastPublish);

  const now = new Date().getTime();
  const remainingTime = Math.max(0, game.get("deadline") - now);
  const timeElapsed   = now - game.get("taskStartTime");

  // ── Phase 3: ask CheckpointManager whether the trigger conditions
  // are satisfied. The manager handles cooldown / cap / opportunity
  // gate / dedup / time floor in one place; failed checkpoints no
  // longer consume the participant's opportunity (Q3).
  //
  // Phase 6.4 (Q8 = "即时"): if the latest human message contains an
  // @-Facilitator mention, set `isMentionCheckpoint: true` so the
  // manager treats it as a participant request: it bypasses automatic
  // pacing, cap, and time-floor rules, but retains Task/chat safety and
  // per-message dedup so one request yields one response.
  // The mention detection is based on the latest HUMAN message in
  // the chat, not the full chat, so a participant re-@ing the
  // Facilitator after a Facilitator reply still triggers a fresh
  // checkpoint. ──
  const latestHumanMessages = getHumanMessages(chat);
  const latestHumanText = latestHumanMessages.length > 0
    ? latestHumanMessages[latestHumanMessages.length - 1].text
    : "";
  const isMentionCheckpoint = containsFacilitatorMention(latestHumanText);

  const trigger = shouldEvaluateCheckpoint({
    store: game,
    humanMessageCount,
    currentStageName,
    remainingTimeMs: remainingTime,
    chatKeyPresent: true,
    now,
    isMentionCheckpoint,
  });

  let logEntry = {
    timestamp:                     now,
    roundIndex,
    facilitation,
    humanMessageCount,
    messagesSinceLastPublish,
    messagesSinceLastIntervention: messagesSinceLastPublish,
    remainingTime,
    timeElapsed,
    requestMade:    false,
    requestSuccess: false,
    messageAdded:   false,
    outcome:        "SILENT",
    model:          openaiModel,
    reason:         trigger.trigger ? "" : trigger.reason,
    // Phase 6.4 (Q8 = "即时"): whether the latest human message
    // @-mentioned the Facilitator. Drives the `isMentionCheckpoint`
    // flag the manager uses to bypass the pacing gates. Recorded
    // unconditionally so the post-hoc log can compute the
    // mention-trigger rate even on messages that didn't trigger
    // (e.g. a mention outside the Task stage).
    mentionDetected: isMentionCheckpoint,
    participantRequested: isMentionCheckpoint,
    originatingRoundId,
    originatingStageId,
  };

  // Phase 3: capture the full AgentState snapshot for the audit log
  // (architecture doc §6 节点 13: "记录 features, evidence-use relations,
  // candidate roles, raw/checked factors, scores, eligibility, selected
  // action, required reasoning act, message, validator, repair, fallback,
  // post-intervention uptake, unresolved need, latency and
  // model/prompt/controller versions"). The agentState object is the
  // single canonical shape; downstream readers do not need to chase
  // individual game.get calls.
  logEntry.agentState = buildAgentState(game, currentRound, chat, { now });

  if (!trigger.trigger) {
    // Not an error -- just "not yet" / "this round is full" / etc.
    // Still log so the audit can see the trigger conditions per
    // human message.
    finalizeAuditLog(game, logEntry);
    Empirica.flush();
    return;
  }

  logEntry.auditRequestId = `${game.id}:${roundIndex}:${humanMessageCount}:${now}`;
  logEntry.serverInstanceId = CALLBACKS_INSTANCE_ID;
  beginInFlight(game, { ...logEntry, outcome: "PENDING" });
  Empirica.flush();

  // Explicit @Facilitator request: answer with the participant-requested
  // Generalist before either condition's automatic policy. This path uses
  // only public context, retains all Generator/Validator safeguards, and is
  // accounted separately so it cannot alter Static/Adaptive opportunity
  // matching or automatic intervention caps.
  if (isMentionCheckpoint) {
    recordParticipantRequest(game, humanMessageCount);
    logEntry.triggerType = "PARTICIPANT_REQUEST";
    logEntry.routingDecision = "REQUESTED_GENERALIST";
    logEntry.selectedRole = "REQUESTED_GENERALIST";

    const requestedPrompt = getRequestedGeneralistPromptBundle();
    const requestedBuilt = buildGeneratorContext(
      game,
      players,
      chat,
      remainingTime,
      timeElapsed,
      "adaptive",
      "generalist",
      null,
      requestedPrompt,
    );
    const requestedResult = await runSharedGeneration(
      game,
      chatKey,
      requestedBuilt,
      logEntry,
      originatingRoundId,
      originatingStageId,
      chat,
    );

    if (
      !requestedResult.published &&
      game.currentRound?.id === originatingRoundId &&
      game.currentStage?.id === originatingStageId &&
      game.currentStage?.get("name") === "Task"
    ) {
      postParticipantRequestFallback(game, chatKey, logEntry);
    }
    if (requestedResult.published) {
      recordParticipantRequestedPublish(game, {
        role: "REQUESTED_GENERALIST",
        messageId: requestedResult.candidate?.messageId ?? null,
        now,
      });
    }
    finalizeAuditLog(game, logEntry);
    Empirica.flush();
    return;
  }

  // ── Record the attempt BEFORE the pipeline runs. The dedup field
  // is part of this so a re-entrant call for the same humanMessageCount
  // (e.g. a duplicate Empirica event) cannot double-trigger. ──
  recordAttempt(game, humanMessageCount, now);

  // Static and Adaptive share the checkpoint opportunity above, but not the
  // intervention-permission policy. Static's fixed policy requires a message
  // attempt at every checkpoint, so it bypasses every discussion-state
  // assessment step and goes directly to the shared Generator/validation/
  // publication path. A blocked prompt or technical failure remains SILENT
  // and logged; it is not a discussion-state ABSTAIN and never fabricates a
  // fallback participant-facing message.
  if (facilitation === "static") {
    logEntry.routingDecision = "STATIC_REQUIRED_MESSAGE";
    const built = buildGeneratorContext(
      game,
      players,
      chat,
      remainingTime,
      timeElapsed,
      "static",
      null,
      null,
    );
    const result = await runSharedGeneration(
      game,
      chatKey,
      built,
      logEntry,
      originatingRoundId,
      originatingStageId,
      chat,
    );
    // Phase 3: record a publish so the opportunity gate resets for the
    // next checkpoint. Phase 2 made Static AI's role "STATIC" instead
    // of "generalist"; the publish is recorded with that role so
    // interventionHistory, lastRole, publishedThisRound all stay
    // consistent across both conditions.
    if (result.published) {
      recordPublish(game, { role: "STATIC", messageId: result.candidate?.messageId ?? null, now });
    }
    finalizeAuditLog(game, logEntry);
    Empirica.flush();
    return;
  }

  // Fail closed on an unexpected Round condition without sending it through
  // either policy. The real S1-S4 table assigns only static/adaptive.
  if (facilitation !== "adaptive") {
    logEntry.reason = `Unrecognized facilitation condition: ${JSON.stringify(facilitation)}`;
    finalizeAuditLog(game, logEntry);
    Empirica.flush();
    return;
  }

  // Adaptive detector: one LLM call assesses every semantic factor. There is
  // no feature extraction, feature pre-filter, or feature-weighted score.
  let checkedFactors = null;
  const assessorStart = Date.now();
  const assessorResult = await assessSemanticFactors({
    chat,
    taskGeneralContext: buildStaticSharedTaskOverview({
      generalInfo: currentRound?.get("generalInfo"),
      decisionOptions: currentRound?.get("decisionOptions"),
    }),
    callLLM: getLLMResponse,
  });
  if (
    game.currentRound?.id !== originatingRoundId ||
    game.currentStage?.id !== originatingStageId ||
    game.currentStage?.get("name") !== "Task"
  ) {
    logEntry.reason = "Discarded stale LLM detector result after the originating Discussion stage ended";
    finalizeAuditLog(game, logEntry);
    Empirica.flush();
    return;
  }
  logEntry.detectorLatency = Date.now() - assessorStart;
  if (typeof assessorResult.rawText === "string") logEntry.detectorRawResponse = assessorResult.rawText;

  if (assessorResult.success) {
    logEntry.rawDetectorFactors = assessorResult.factors;
    checkedFactors = checkEvidence(assessorResult.factors, { chat });
    logEntry.checkedDetectorFactors = checkedFactors;
  } else {
    logEntry.detectorError = `${assessorResult.code}: ${assessorResult.error}`;
  }

  // Step 7: Adaptive intervention-permission gate (Phase 4 three-state).
  // The gate's decision is one of: "specialist" (clear winner, run
  // policy compiler + Generator), "generalist" (matched-frequency
  // fallback, run Generalist bundle), or "abstain" (no message at
  // all -- just log and return). Shared between Static and Adaptive,
  // but the Static path never enters this branch (Static always
  // emits; this gate only governs the Adaptive path).
  const lastRole                = game.get("lastRole");
  const gateResult = evaluateGate(checkedFactors, { remainingTime, lastRole });

  logEntry.gateDecision  = gateResult.decision;  // "specialist" | "generalist" | "abstain"
  logEntry.gateReason    = gateResult.reason;
  logEntry.eligibleRoles = gateResult.eligibleRoles;
  logEntry.stateScores   = gateResult.scores;
  logEntry.perRole       = gateResult.perRole;
  logEntry.abstentionKind = gateResult.abstentionKind;
  logEntry.fallbackKind  = gateResult.fallbackKind;

  // Persist this checkpoint's checked factors for the next checkpoint's
  // audit / calibration use. (computePersistence is currently outside
  // the main score, but the per-round history is still valuable.)
  if (checkedFactors) {
    game.set("lastCheckedDetectorFactors", checkedFactors);
  }

  if (gateResult.decision === "abstain") {
    logEntry.reason = gateResult.reason;
    finalizeAuditLog(game, logEntry);
    Empirica.flush();
    return;
  }

  // ── Generalist path: Adaptive's matched-frequency control ─────────
  // No policy compiler, no plan. The Generalist bundle is loaded by
  // llmSystemPrompts("adaptive", "generalist") -- the dispatcher
  // routes to getGeneralistPromptBundle() (Phase 2.4 fail-closed
  // invariant: getAdaptivePromptBundle("generalist") is rejected).
  if (gateResult.decision === "generalist") {
    logEntry.selectedRole = "GENERALIST";
    logEntry.reasoning    = gateResult.reason;

    const built = buildGeneratorContext(game, players, chat, remainingTime, timeElapsed, "adaptive", "generalist", null);
    const result = await runSharedGeneration(
      game, chatKey, built, logEntry, originatingRoundId, originatingStageId, chat
    );

    if (result.published) {
      recordPublish(game, { role: "GENERALIST", messageId: result.candidate?.messageId ?? null, now });
    }

    finalizeAuditLog(game, logEntry);
    Empirica.flush();
    return;
  }

  // ── Specialist path: pick the controller-chosen role and run the
  // policy compiler + Generator. chooseRole cannot return an Abstain
  // (the three-state gate already handled that above).
  const synthesiserFired = game.get("synthesiserFired");
  const chosenRole = chooseRole(gateResult, { remainingTime, lastRole, synthesiserFired });

  logEntry.selectedRole = chosenRole.role;
  logEntry.forced       = chosenRole.forced;
  logEntry.reasoning    = chosenRole.reasoning;

  const chatWithIds        = withMessageIds(chat.filter(isFormalContextMessage));
  const eligibleMessageIds = chatWithIds.filter(isFormalHumanMessage).map((m) => m.messageId);
  const plan = compilePlan(chosenRole.role, checkedFactors, {
    score:     gateResult.scores[chosenRole.role],
    threshold: getRoleThreshold(chosenRole.role),
    eligibleMessageIds,
  });
  logEntry.plan = plan;

  // ── Shared: build context, run the bounded generation/repair/validation
  // pipeline, publish at most once, and log ─────────────────────────────
  const built  = buildGeneratorContext(game, players, chat, remainingTime, timeElapsed, "adaptive", chosenRole.role, plan);
  let result = await runSharedGeneration(
    game,
    chatKey,
    built,
    logEntry,
    originatingRoundId,
    originatingStageId,
    chat
  );

  // Architecture fallback: if a Specialist candidate and its one repair are
  // both semantically rejected, retry this checkpoint with the shared
  // Generalist prompt. Preserve the complete Specialist failure separately
  // so the final Generalist audit fields cannot overwrite its evidence.
  let publishedRole = chosenRole.role;
  if (!result.published && logEntry.outcome === "SILENT_VALIDATOR_REJECTED") {
    logEntry.controllerSelectedRole = chosenRole.role;
    logEntry.specialistFailure = {
      reason: logEntry.reason,
      outcome: logEntry.outcome,
      attempts: result.attempts ?? 2,
      promptMetadata: logEntry.promptMetadata,
      validator: logEntry.validator,
      validatorRepair: logEntry.validatorRepair,
    };
    logEntry.fallbackRoute = "SPECIALIST_TO_GENERALIST";
    delete logEntry.validator;
    delete logEntry.validatorRepair;

    const generalistBuilt = buildGeneratorContext(
      game,
      players,
      chat,
      remainingTime,
      timeElapsed,
      "adaptive",
      "generalist",
      null,
    );
    result = await runSharedGeneration(
      game,
      chatKey,
      generalistBuilt,
      logEntry,
      originatingRoundId,
      originatingStageId,
      chat,
    );
    logEntry.fallbackPublished = result.published;
    logEntry.totalGeneratorAttempts = logEntry.specialistFailure.attempts + (result.attempts ?? 0);
    if (result.published) {
      publishedRole = "GENERALIST";
      logEntry.selectedRole = "GENERALIST";
    }
  }

  if (result.published) {
    // Phase 3: use the manager to record the publish uniformly. This
    // resets messagesSinceLastPublish (so the next 6 human messages
    // are the next opportunity), increments publishedThisRound,
    // appends to interventionHistory, and updates lastRole. The
    // synthesiserFired flag is handled inside recordPublish based on
    // role alone (not on `forced`); callers that need to mark the
    // forced-nudge state still set synthesiserFired directly (this
    // branch is for the Controller's tracking; recordPublish's
    // general bookkeeping is separate).
    recordPublish(game, { role: publishedRole, messageId: result.candidate?.messageId ?? null, now });
    if (publishedRole === chosenRole.role && chosenRole.role === "synthesiser" && chosenRole.forced) {
      game.set("synthesiserFired", true);
    }
  }

  finalizeAuditLog(game, logEntry);
  Empirica.flush();
}

Empirica.on("game", "chat_round_0", handleChat);
Empirica.on("game", "chat_round_1", handleChat);

Empirica.onStageEnded(({ stage }) => {
  const round = stage.round;
  const game = stage.currentGame;
  const stageName = stage.get("name");
  if (["Task", "InitialDecision", "FinalDecision", "IndividualAssessment"].includes(stageName)) {
    round.set(`${stageName}EndedAt`, Date.now());
  }

  if (stageName === "FinalDecision") {
    if (!round.get("finalDecisionConfirmed")) finalizeGroupDecision(stage, { timedOut: true });
    for (const player of assignedHumanPlayers(game)) {
      if (round.get("finalDecisionTimedOut")) player.round.set("groupFinalTimeoutReason", "stage_timeout");
    }
  }

  if (stageName === "InitialDecision") {
    for (const player of assignedHumanPlayers(game)) {
      if (!player.round.get("initialSubmittedAt")) player.round.set("initialDecisionTimeoutReason", "stage_timeout");
    }
  }

  if (stageName === "IndividualAssessment") {
    for (const player of assignedHumanPlayers(game)) {
      if (!player.round.get("individualAssessmentSubmittedAt")) {
        player.round.set("individualAssessmentTimeoutReason", "stage_timeout");
      }
    }
  }

  for (const player of assignedHumanPlayers(game)) {
    const rows = buildRoundResponseRows({
      gameId: game.id,
      roundId: round.id,
      participantId: player.id,
      stageName,
      read: (key) => player.round.get(key),
    });
    if (rows.length) queueResearchMirror(`response_${stageName}`, () => researchPersistence().upsertResponses(rows));
  }

});

Empirica.onRoundEnded(({ round }) => {
  const game = round.currentGame;
  const endedAt = new Date().toISOString();
  queueResearchMirror("round_ended", async () => {
    const persistence = researchPersistence();
    await persistence.upsertRounds({
      round_id: round.id, game_id: game.id, task_index: round.get("taskIndex"),
      task_version: round.get("taskVersion"), facilitation: round.get("facilitation"),
      round_status: "ended", ended_at: endedAt, updated_at: endedAt,
    });
    await persistence.upsertSnapshot({
      snapshot_id: `${game.id}:${round.id}:round_ended`, game_id: game.id, round_id: round.id,
      snapshot_type: "round_ended",
      runtime_status: {
        taskIndex: round.get("taskIndex"), taskVersion: round.get("taskVersion"),
        facilitation: round.get("facilitation"), totalInterventions: game.get("totalInterventions") || 0,
      },
      occurred_at: endedAt,
    });
  });
  console.log(`[Round ${round.get("index")} ended] facilitation: ${round.get("facilitation")}, total interventions so far: ${game.get("totalInterventions")}`);
});

Empirica.onGameEnded(({ game }) => {
  const endedAt = new Date().toISOString();
  queueResearchMirror("game_ended", async () => {
    const persistence = researchPersistence();
    await persistence.upsertParticipants(game.players.map((player) => ({
      participant_id: researchParticipantId(game.id, player.id), game_id: game.id,
      participant_number: player.get("participantNumber"), profile_slot: player.get("profileSlot"),
      participant_status: "completed", completed_at: endedAt, updated_at: endedAt,
    })));
    await persistence.upsertSnapshot({
      snapshot_id: `${game.id}:game_ended`, game_id: game.id, round_id: null,
      snapshot_type: "game_ended",
      runtime_status: {
        sequenceId: game.get("sequenceId"), totalInterventions: game.get("totalInterventions") || 0,
        totalHumanMessages: game.get("humanMessageCount") || 0,
      },
      occurred_at: endedAt,
    });
  });
  console.log(`[Game ended] Total interventions: ${game.get("totalInterventions")}`);
  console.log(`[Game ended] Total human messages: ${game.get("humanMessageCount")}`);
  console.log(`[Game ended] sequenceId: ${game.get("sequenceId")}, allocationBlockId: ${game.get("allocationBlockId")}, allocationPosition: ${game.get("allocationPosition")}`);
});

for (const responseType of ["finalQuestions", "expFeedback"]) {
  Empirica.on("player", responseType, (_ctx, { player }) => {
    const game = player.currentGame;
    const gameId = game?.id || player.get("researchGameId");
    if (!gameId) return;
    const row = buildGlobalResponseRow({
      gameId, participantId: player.id, responseType, stored: player.get(responseType),
    });
    if (row) queueResearchMirror(`response_${responseType}`, () => researchPersistence().upsertResponses(row));
  });
}
