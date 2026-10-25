import { createAdaptiveBudget, ADAPTIVE_FLOOR_MS, runAdaptiveSelection } from "./AdaptiveRecovery.mjs";
import { selectAdaptiveAssessment } from "./AdaptiveEvidence.mjs";
import { createCloseoutScheduler } from "./AdaptiveCloseoutScheduler.mjs";
import { isPublicParticipantMessage, countPublicMessagesByName, quietParticipants } from "./CognitiveOperations.mjs";
import { acceptIndependentDecision, finalizeIndependentDecision } from "./FinalDecisionSubmission.mjs";
import { DECISION_NUDGE } from "../../shared/decisionSubmission.mjs";
import { ClassicListenersCollector } from "@empirica/core/admin/classic";
export const Empirica = new ClassicListenersCollector();
import { DISCUSSION_OPENING_MESSAGE } from "../../shared/discussionOpening.mjs";
import _ from "lodash";
import dotenv from "dotenv";
import taskConfig from "./HPTConfig.json";
import { llmSystemPrompts } from "./LLMConfig.js";
import { evaluateNeedGate, chooseRole, THRESHOLDS } from "./utils.js";
import { parseGeneratorOutputStrict, validateAgainstGenerationSchema, runDeterministicValidation } from "./prompts/GeneratorContract.mjs";
import { buildDynamicUserContext, withMessageIds, formatMessagesWithIds } from "./prompts/DynamicContext.mjs";
import { getRequestedGeneralistPromptBundle } from "./prompts/promptLoader.js";
import { buildStaticSharedTaskOverview, buildStaticUserContext } from "./prompts/StaticContext.mjs";
import {
  buildChatCompletionPayload,
  buildSuccessfulLLMResult,
  extractChatCompletionResponseMetadata,
  resolveLLMRequestTimeoutMs,
  withLLMRequestTimeout,
  isOfficialOpenAIChatEndpoint,
} from "./LLMTransport.mjs";
import { buildSynthesisPointContract, decodeSynthesisPoints } from "./SynthesisPointContract.mjs";
import { assessSemanticFactors } from "./SemanticAssessor.js";
import { checkNeedAssessment } from "./EvidenceChecker.js";
import { compilePlan } from "./PolicyCompiler.js";
import { preflightPlan } from "./PlanPreflight.mjs";
import { AUTOMATIC_MAX_WORDS, isSpecialistRole } from "./prompts/PromptRuntime.mjs";
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
import { normalizeGeneratorCandidate } from "../../client/src/components/facilitatorPresentation.mjs";
import { initializeTestControls, registerTestControls, canPublishTestResult } from "./TestControls.mjs";
import { claimSequenceForStudy } from "./RandomizationLedger.mjs";
import { randomUUID } from "node:crypto";
import { initialiseTaskOptionOrder, orderTaskSections } from "./TaskOptionOrder.mjs";
import {
  beginInFlight,
  finalizeAuditLog as finalizeAuditLogBase,
  recoverInterruptedInFlight,
  ensureLlmLogIndex,
  setVisibleResponsePending,
} from "./InFlightAudit.mjs";
import { appendToAttribute, ensureAppendOnlyAttribute } from "./AppendOnlyAttribute.mjs";
import {
  allFinalDecisionConfirmationsMatch,
  classifyFinalDecision,
  FACILITATOR_ROLES,
  MESSAGE_TYPES,
  NO_GROUP_FINAL_DECISION,
  allocateSequencePosition,
  buildCanonicalMessage,
  reviewFinalDecisionConfirmation,
  reviewHumanMessageRequest,
  summarizeFinalDecisionDrafts,
} from "./ExperimentPolicies.mjs";
import {
  FORMAL_INITIAL_DECISION_SECONDS,
  GROUP_DECISION_SECONDS,
} from "../../shared/personalFlow.mjs";
import { PRACTICE_CHAT } from "../../shared/practice.mjs";
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
import { countLobbyReadyPlayers } from "./LobbyReadiness.mjs";
import { addPracticeRound, initialisePractice, handlePracticeStageStart, registerPractice, handlePracticeMessage, logPractice } from "./PracticeOnboarding.mjs";
import { handlePersonalFlowStageStart, registerPersonalFlow } from "./PersonalFlow.mjs";

registerPractice(Empirica, appendCanonicalMessage);
registerTestControls(Empirica);
registerPersonalFlow(Empirica, (player, round, stageName) => {
  const rows = buildRoundResponseRows({ gameId: round.currentGame.id, roundId: round.id,
    participantId: player.id, stageName, read: (key) => player.round.get(key) });
  if (rows.length) queueResearchMirror(`response_${stageName}`, () => researchPersistence().upsertResponses(rows));
});

dotenv.config();

let researchMirrorQueue = Promise.resolve();
function queueResearchMirror(operation, task) {
  researchMirrorQueue = mirrorNonBlocking(researchMirrorQueue.then(task), {
    operation,
    onError: (failure) => console.warn("[research mirror] non-blocking write failed", failure),
  });
  return researchMirrorQueue;
}

async function finalizeAuditLog(store, entry) {
  const round = store.currentRound;
  const formalRoundIndex = round?.get("taskIndex");
  const chat = round ? [...(store.get(`chat_round_${formalRoundIndex}`) || [])] : [];
  const completed = await finalizeAuditLogBase(store, entry, () => Empirica.flush());
  if (!round) return;
  queueResearchMirror("intervention", async () => {
    const persistence = researchPersistence();
    for (const message of chat) {
      await persistence.upsertMessage(buildMessageRow({
        gameId: store.id, roundId: round.id,
        transcriptKey: `chat_round_${formalRoundIndex}`, message,
      }));
    }
    await persistence.mirrorIntervention(buildInterventionMirror({
      gameId: store.id, roundId: round.id, facilitation: round.get("facilitation"), chat, entry: completed,
    }));
  });
}

function canPublishFacilitatorResult(game, origin) {
  if (origin?.phase !== "practice") return canPublishTestResult(game, origin)
    && !(origin.facilitation === "adaptive" && !origin.participantRequested
      && (!Number.isFinite(game.get("deadline")) || Date.now() >= game.get("deadline") || game.currentRound?.get("ended")));
  const stage = game.currentStage;
  return game.currentRound?.id === origin.originatingRoundId
    && game.currentRound?.get("isPractice") === true
    && stage?.id === origin.originatingStageId
    && stage?.get("name") === origin.originatingStageName
    && ["PracticeWelcome", "PracticeDiscussion"].includes(origin.originatingStageName)
    && !stage.get("ended")
    && !game.get("ended")
    && !game.get("endedAt");
}

async function whileFacilitatorPublishesVisibleResponse(game, logEntry, task) {
  const stillCurrent = () => canPublishFacilitatorResult(game, logEntry)
    && (logEntry.participantRequested === true || game.get("humanMessageCount") === logEntry.humanMessageCount)
    && (!logEntry.publicContextFingerprint || publicContextFingerprint(game.get(`chat_round_${logEntry.roundIndex}`) || []) === logEntry.publicContextFingerprint);
  const rejectStale = () => {
    logEntry.reason = "Discarded stale AI result before publication because the originating Discussion stage or automatic discussion context changed";
    logEntry.outcome = "SILENT";
    return false;
  };
  if (!stillCurrent()) return rejectStale();
  await setVisibleResponsePending(game, logEntry.auditRequestId, true, () => Empirica.flush());
  try {
    if (!stillCurrent()) return rejectStale();
    return await task();
  } finally {
    await setVisibleResponsePending(game, logEntry.auditRequestId, false, () => Empirica.flush());
  }
}

// The participant client does not reliably receive ParticipantChange events
// before a Classic game starts, so usePlayers() can remain undefined for the
// entire lobby. Keep the lobby count on the authoritative server instead.
// This listener is serialized with Empirica's other attribute listeners and
// avoids the previous read/append/write race between participant browsers.
Empirica.on("player", "introDone", (_ctx, { player }) => {
  const game = player.currentGame;
  if (!game || game.hasStarted) return;

  game.set("lobbyReadyCount", countLobbyReadyPlayers(game.players));
});

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
// 2026-10-21: matched-latency delay for Static checkpoints. Adaptive makes
// one extra LLM call (the need detector) before generating, so Static waits
// this long before its own generation to keep checkpoint-to-message timing
// comparable across conditions. Placeholder default: set it to the median
// Adaptive `detectorLatency` observed in pilot logs. 0 disables it. Read at
// call time so tests and operators can change it without a rebuild.
function staticMatchedDelayMs() {
  return Math.max(0, Number(process.env.STATIC_MATCHED_DELAY_MS ?? 6000) || 0);
}
const CALLBACKS_INSTANCE_ID = randomUUID();
const AUTOMATIC_PIPELINE_GROUP = "AUTOMATIC_INTERVENTION";
export const adaptiveCloseoutScheduler = createCloseoutScheduler({
  run: (game, adaptiveTrigger) => handleChat(undefined, { game, adaptiveTrigger }),
  flush: () => Empirica.flush(),
  onError: error => console.warn("Adaptive closeout callback failed", { message: error.message }),
});
Empirica.on("game", "deadline", (_ctx, { game }) => adaptiveCloseoutScheduler.register(game));

function publicContextFingerprint(chat) {
  return JSON.stringify(chat.filter(isFormalContextMessage).map(m => [m.messageId, m.text ?? m.content]));
}


// ── LLM API call ──────────────────────────────────────────────────────────────

async function requestChatCompletion(messages, maxTokens = llmMaxOutputTokens, options = {}) {
  const data = buildChatCompletionPayload({
    model: openaiModel,
    maxTokens,
    messages,
    endpoint: llmAPIEndpoint,
    responseSchema: options.responseSchema,
    reasoningEffort: options.reasoningEffort,
    // Strict audit schemas and reasoning overrides are provider-scoped in
    // LLMTransport. MiniMax's unsupported response_format remains omitted;
    // every provider response still passes the existing local parsers.
  });
  try {
    return await withLLMRequestTimeout(async (signal) => {
      const completion = await fetch(llmAPIEndpoint, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
        },
        body: JSON.stringify(data),
        signal,
      });
      const isJson = completion.headers.get("content-type")?.includes("application/json");
      const responseBody = isJson ? await completion.json() : await completion.text();
      if (!completion.ok) {
        const errorPayload = isJson ? responseBody : { error: responseBody };
        console.error("LLM endpoint HTTP error:", { status: completion.status, error: errorPayload?.error || errorPayload });
        return { success: false, error: errorPayload?.error?.message || completion.statusText };
      }
      const responseMetadata = {
        ...extractChatCompletionResponseMetadata(responseBody),
        requestPolicy: {
          reasoningEffort: data.reasoning_effort ?? null,
          responseFormat: data.response_format?.type ?? null,
          responseSchemaName: data.response_format?.json_schema?.name ?? null,
          maxCompletionTokens: data.max_completion_tokens ?? data.max_tokens,
        },
      };
      const text = responseBody?.choices?.[0]?.message?.content;
      if (typeof text !== "string" || text.length === 0) {
        console.error("LLM response missing message content", {
          model: openaiModel,
          ...responseMetadata,
          reasoningDetailsPresent: Array.isArray(responseBody?.choices?.[0]?.message?.reasoning_details),
        });
        const finishReason = responseMetadata.finish_reason || "unknown";
        return {
          success: false,
          error: `LLM response missing message content (finish_reason=${finishReason})`,
          responseMetadata,
        };
      }
      // Provider envelopes are parsed by the schema-owning downstream stage.
      // In particular, MiniMax may wrap valid JSON in one Markdown code fence;
      // rejecting that here would bypass the Generator/Assessor/Validator
      // parsers that explicitly and safely support the envelope.
      return buildSuccessfulLLMResult(text, responseMetadata);
    }, Math.min(options.timeoutMs ?? Infinity, resolveLLMRequestTimeoutMs(process.env.LLM_REQUEST_TIMEOUT_MS)));
  } catch (error) {
    console.error("LLM endpoint error:", { code: error?.code || "LLM_REQUEST_ERROR", message: error?.message || String(error) });
    return { success: false, error: error.message };
  }
}

// The transport above stores no conversation and adds no context. Formal
// callers provide messages from their own locked context builders.
async function getLLMResponse(messages, maxTokens = llmMaxOutputTokens, options = {}) {
  return requestChatCompletion(messages, maxTokens, options);
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

// ── operationalEvents (bounded Tajriba storage) ──────────────────────────────
//
// `operationalEvents` used to be stored as a single Tajriba Attribute
// whose value was the entire growing array, mirroring the `llmLog`
// pattern that caused `bufio.Scanner: token too long` on reload. We now
// store each event as its own per-entry Attribute plus a small index,
// reusing the helper from AppendOnlyAttribute.mjs.
const OPERATIONAL_EVENTS_NAMESPACE = "operationalEvents";

let operationalEventCounter = 0;

function recordOperationalEvent(game, event) {
  const timestamp = Date.now();
  // Sequence id is unique within a single process and the timestamp
  // disambiguates across restarts. Stays well under 64 bytes.
  const id = `${timestamp}-${(++operationalEventCounter).toString(36)}`;
  const entry = { id, timestamp, serverInstanceId: CALLBACKS_INSTANCE_ID, ...event };
  appendToAttribute(game, OPERATIONAL_EVENTS_NAMESPACE, entry);
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
// only called once the Adaptive gate -- utils.js's evaluateNeedGate() -- has
// returned "specialist") for Adaptive, or null for Static and for Adaptive's
// Static-policy route (which reuses the Static context). `plan` is
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

  const interventionHistory = game.currentRound?.get("cognitiveInterventionHistory") || [];
  const planPreflight = plan ? preflightPlan(plan, { chat: chat.filter(isFormalContextMessage), taskGeneralContext: publicTaskOverview, activeParticipantNames: players.map(p => p.get("name")), interventionHistory }) : null;
  if (plan && planPreflight.status !== "passed") return { blocked: true, reason: "Specialist plan failed preflight", metadata: promptResult.metadata, planPreflight };
  const dynamicContext = buildDynamicUserContext({
    chat: chat.filter(isFormalContextMessage),
    checkpointDescriptor,
    selectedRoleForDisplay: promptResult.metadata.generationRole,
    generalInfo: publicTaskOverview,
    plan, planPreflight, interventionHistory,
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
    interventionPlan: plan, planPreflight, interventionHistory, contextScope: "complete_current_round",
    userContent: promptResult.metadata.triggerType === "PARTICIPANT_REQUEST"
      ? `${dynamicContext.userContent}\n\n[TRIGGER_TYPE]\nPARTICIPANT_REQUEST\n\n[PARTICIPANT_REQUEST]\n${formatMessagesWithIds(withMessageIds(chat).filter(isPublicParticipantMessage).slice(-1))}`
      : dynamicContext.userContent,
    eligibleMessageIds: dynamicContext.eligibleMessageIds,
    aiOrSystemMessageIds: dynamicContext.aiOrSystemMessageIds,
    recentAiMessageTexts: dynamicContext.recentAiMessageTexts,
    allowedGroundingIds: dynamicContext.allowedGroundingIds,
    activeParticipantNames: dynamicContext.activeParticipantNames,
    remainingTimeMs: remainingTime,
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
async function runSharedGeneration(game, chatKey, built, logEntry, originatingRoundId, originatingStageId, chat, { allowValidatorRepair = true, adaptiveBudget = null } = {}) {
  logEntry.promptMetadata = built.metadata;
  if (built.planPreflight) logEntry.planPreflight = built.planPreflight;

  if (built.blocked) {
    logEntry.reason = `AI request blocked: ${built.reason}`;
    logEntry.outcome = "SILENT";
    return { published: false, attempts: 0 };
  }

  let generatorAttempts = 0;
  // Returns false if the originating round/stage has changed (a later
  // attempt would be responding to a stale world). True if the same
  // stage is still active.
  function isOriginatingStageActive() {
    return (!adaptiveBudget || adaptiveBudget.check()) && canPublishFacilitatorResult(game, {
      ...logEntry,
      originatingRoundId,
      originatingStageId,
      roundId: originatingRoundId,
      stageId: originatingStageId,
    });
  }

  // One Generator attempt: LLM call + strict parse + schema + deterministic.
  // The user content defaults to the original `built.userContent`; the
  // repair attempt passes a modified version (with [PRIOR_FAILED_CRITERIA]
  // appended) via `userContentOverride`. Returns:
  //   {ok: true, candidate}
  //   {discarded: true}                       round/stage changed
  //   {silent: true, reason, logField?}       any failure
  async function attemptGeneration(userContentOverride = null) {
    if (adaptiveBudget && !adaptiveBudget.check()) return { discarded: true };
    const repairKind = userContentOverride && adaptiveBudget
      ? (isSpecialistRole(built.metadata.generationRole) ? "generatorRepair" : "staticRepair") : null;
    if (repairKind && adaptiveBudget.counts[repairKind] >= 1) return { silent: true, reason: `${repairKind} already used` };
    const pointContract = built.metadata.generationRole === "INFORMATION_SYNTHESISER"
      && ["EVIDENCE_CONSOLIDATION", "CROSS_OPTION_COMPARISON"].includes(built.interventionPlan?.requiredReasoningAct)
      && isOfficialOpenAIChatEndpoint(llmAPIEndpoint)
      ? buildSynthesisPointContract(built.interventionPlan.target.optionLabels, built.allowedGroundingIds)
      : null;
    const messages = [
      { role: "system", content: built.systemPrompt + (pointContract?.instruction || "") },
      { role: "user",   content: userContentOverride ?? built.userContent },
    ];
    logEntry.messagesOAIFormat = messages;
    const generatorStartedAt = Date.now();
    const generationOptions = isSpecialistRole(built.metadata.generationRole)
        ? { reasoningEffort: built.metadata.generationRole === "INFORMATION_SYNTHESISER" ? "medium" : "low" }
        : {};
    if (pointContract) generationOptions.responseSchema = pointContract.responseSchema;
    const invoke = (timing = {}) => {
      generatorAttempts += 1;
      logEntry.requestMade = true;
      return getLLMResponse(messages, llmMaxOutputTokens, { ...generationOptions, ...timing });
    };
    const llmResponse = adaptiveBudget
      ? await adaptiveBudget.call("generator", invoke, repairKind)
      : await invoke();
    logEntry.generatorLatenciesMs = [
      ...(logEntry.generatorLatenciesMs || []),
      Date.now() - generatorStartedAt,
    ];
    if (llmResponse.responseMetadata) {
      logEntry.generatorResponseMetadata = [
        ...(logEntry.generatorResponseMetadata || []),
        {
          attempt: (logEntry.generatorResponseMetadata?.length || 0) + 1,
          ...llmResponse.responseMetadata,
        },
      ];
    }
    if (!isOriginatingStageActive()) return { discarded: true };
    if (!llmResponse.success) {
      logEntry.failureStage = "generator_api";
      return { silent: true, reason: `API Error: ${llmResponse.error}` };
    }
    logEntry.generatorRawResponses = [
      ...(logEntry.generatorRawResponses || []),
      { attempt: (logEntry.generatorRawResponses?.length || 0) + 1, rawText: llmResponse.rawText },
    ];
    logEntry.requestSuccess = true;

    const parseResult = parseGeneratorOutputStrict(llmResponse.rawText);
    if (!parseResult.ok) {
      logEntry.failureStage = "parse";
      return { silent: true, reason: `Invalid Generator output: ${parseResult.error}` };
    }

    if (pointContract) {
      const decoded = decodeSynthesisPoints(parseResult.parsed, pointContract);
      if (!decoded.ok) {
        logEntry.failureStage = "schema";
        return { silent: true, reason: decoded.error, logField: { schemaErrors: decoded.errors } };
      }
      parseResult.parsed = decoded.parsed;
    }

    const schemaResult = validateAgainstGenerationSchema(parseResult.parsed, built.metadata.generationRole, built.metadata.triggerType);
    if (!schemaResult.ok) {
      logEntry.failureStage = "schema";
      return {
        silent: true,
        reason: "Generator output failed generation.schema.json",
        logField: { schemaErrors: schemaResult.errors },
      };
    }

    const candidate = normalizeGeneratorCandidate(parseResult.parsed);
    const deterministicResult = runDeterministicValidation(candidate, {
      selectedRole: built.metadata.generationRole,
      eligibleMessageIds: built.eligibleMessageIds,
      aiOrSystemMessageIds: built.aiOrSystemMessageIds,
      recentAiMessageTexts: built.recentAiMessageTexts,
      allowedGroundingIds: built.allowedGroundingIds,
      // Word cap applies to every automatically triggered facilitator path
      // (Static + Adaptive Generalist/Specialist). It is deliberately not
      // applied to the participant-requested (@Facilitator) bundle, which
      // is tagged triggerType: "PARTICIPANT_REQUEST" in its prompt metadata
      // -- that role needs more room to ground a substantive answer.
      maxWords: built.metadata.triggerType === "PARTICIPANT_REQUEST" ? null : built.metadata.maxWords ?? AUTOMATIC_MAX_WORDS,
      enforcePlanGrounding: isSpecialistRole(built.metadata.generationRole),
      forbidInternalDisclosure: isSpecialistRole(built.metadata.generationRole),
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
      logEntry.failureStage = "deterministic";
      return {
        silent: true,
        reason: `Generator output failed validation: ${deterministicResult.failedCriteria.join(", ")}`,
        // Adaptive can repair this same plan once; all routes revalidate.
        deterministicFailedCriteria: deterministicResult.failedCriteria,
        priorCandidate: candidate,
      };
    }

    return { ok: true, candidate };
  }

  // Legacy control/requested routes retain their word-limit-only repair.
  function isWordLimitOnlyFailure(failedCriteria) {
    return (
      Array.isArray(failedCriteria) &&
      failedCriteria.length === 1 &&
      failedCriteria[0] === "MESSAGE_EXCEEDS_WORD_LIMIT"
    );
  }

  // Build the repair-attempt user content for a word-limit-only rejection.
  // Distinct from buildRepairUserContent (semantic Validator repair, defined
  // below) because the feedback here is deterministic and mechanical: keep
  // the same content/intent, just shorten it.
  function buildWordLimitRepairUserContent(priorCandidate) {
    const maxWords = built.metadata.maxWords ?? AUTOMATIC_MAX_WORDS;
    const priorJson = JSON.stringify(
      { role: priorCandidate.role, message: priorCandidate.message, groundingMessageIds: priorCandidate.groundingMessageIds },
      null,
      2
    );
    return `${built.userContent}\n\n---\n\n[PRIOR_FAILED_CRITERIA]\nThe previous candidate at this checkpoint was rejected for exceeding the ${maxWords}-word limit on \`message\`.\nPrevious candidate (do NOT repeat it verbatim -- shorten the SAME idea/intent to at most ${maxWords} words):\n${priorJson}\nRegenerate a candidate with the same intent and role, at most ${maxWords} words.`;
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
    return `${built.userContent}\n\n---\n\n[PRIOR_FAILED_CRITERIA]\nThe previous candidate at this checkpoint was rejected by the semantic Validator for: ${failedList}.\nPrevious candidate (do NOT repeat it -- generate a NEW message):\n${priorJson}\n${adaptiveBudget && isSpecialistRole(built.metadata.generationRole) ? `Repair the SAME need and plan using only the original allowed grounding IDs ${JSON.stringify(built.allowedGroundingIds)}. Remove unsupported claims; never expand evidence. ` : ""}Regenerate a candidate that does NOT violate the listed criteria.`;
  }

  // One Validator LLM call. Treats the LLM-side failure (API / parse /
  // schema) as a Validator-unavailable signal distinct from a
  // passed:false verdict -- we have no failedCriteria to feed back in
  // the unavailable case, so no repair is triggered. The caller logs
  // this strongly and goes silent.
  async function runValidator(candidate, priorFailedCriteria = null, priorCandidate = null) {
    const validatorStartedAt = Date.now();
    const result = await validateCandidate({
      chat: built.metadata.condition === "static" ? chat : chat.filter(isFormalContextMessage),
      candidate,
      selectedRole: built.metadata.generationRole,
      taskGeneralContext: built.taskGeneralContext,
      callLLM: (messages, options) => adaptiveBudget
        ? adaptiveBudget.call("validator", timing => getLLMResponse(messages, llmMaxOutputTokens, { ...options, ...timing }))
        : getLLMResponse(messages, llmMaxOutputTokens, options),
      priorFailedCriteria,
      priorCandidate,
      interventionPlan: built.interventionPlan, planPreflight: built.planPreflight,
      interventionHistory: built.interventionHistory, recentAiMessages: built.recentAiMessageTexts,
      activeParticipantNames: built.activeParticipantNames, contextScope: built.contextScope,
      triggerType: built.metadata.triggerType,
      remainingTimeMs: adaptiveBudget?.remainingTime() ?? built.remainingTimeMs,
    });
    logEntry.validatorLatenciesMs = [
      ...(logEntry.validatorLatenciesMs || []),
      Date.now() - validatorStartedAt,
    ];
    if (result.responseMetadata) {
      logEntry.validatorResponseMetadata = [
        ...(logEntry.validatorResponseMetadata || []),
        {
          attempt: (logEntry.validatorResponseMetadata?.length || 0) + 1,
          ...result.responseMetadata,
        },
      ];
    }
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
  let a1 = await attemptGeneration();
  if (a1.discarded) {
    logEntry.reason = "Discarded stale AI result after the originating Discussion stage ended";
    logEntry.outcome = "SILENT";
    return { published: false, attempts: generatorAttempts };
  }

  // Repetition returns to selection; other Adaptive Specialist structure,
  // format, grounding and length errors may use one same-plan repair.
  const exactSpecialistRepeat = candidate => adaptiveBudget && isSpecialistRole(built.metadata.generationRole)
    && candidate.deterministicFailedCriteria?.includes("DUPLICATE_OF_RECENT_AI_MESSAGE");
  if (a1.silent && !exactSpecialistRepeat(a1) && (isWordLimitOnlyFailure(a1.deterministicFailedCriteria)
    || (adaptiveBudget && isSpecialistRole(built.metadata.generationRole) && ["parse", "schema", "deterministic"].includes(logEntry.failureStage)))
    && (!adaptiveBudget || adaptiveBudget.counts[isSpecialistRole(built.metadata.generationRole) ? "generatorRepair" : "staticRepair"] < 1)) {
    logEntry.wordLimitRepairAttempted = isWordLimitOnlyFailure(a1.deterministicFailedCriteria);
    const repairContent = logEntry.wordLimitRepairAttempted ? buildWordLimitRepairUserContent(a1.priorCandidate)
      : `${built.userContent}\n\n[PRIOR_FAILED_CRITERIA]\n${a1.reason}\nPrevious output: ${logEntry.generatorRawResponses?.at(-1)?.rawText ?? ""}\nRepair the SAME need/plan once. Allowed grounding IDs remain exactly ${JSON.stringify(built.allowedGroundingIds)}. Do not expand evidence, change role, invent facts or increase the visible word limit. Return the required JSON.`;
    const beforeRepair = generatorAttempts;
    const wordLimitRepair = await attemptGeneration(repairContent);
    logEntry.wordLimitRepairAttempted &&= generatorAttempts > beforeRepair;
    if (wordLimitRepair.discarded) {
      logEntry.reason = "Discarded stale AI result after the originating Discussion stage ended";
      logEntry.outcome = "SILENT";
      return { published: false, attempts: generatorAttempts };
    }
    a1 = wordLimitRepair;
  }

  if (a1.silent) {
    logEntry.reason = a1.reason;
    if (a1.logField) Object.assign(logEntry, a1.logField);
    logEntry.outcome = "SILENT";
    return { published: false, attempts: generatorAttempts, repetition: !!exactSpecialistRepeat(a1) };
  }

  const v1 = await runValidator(a1.candidate);
  if (!isOriginatingStageActive()) {
    logEntry.reason = "Discarded stale Validator result after the originating Discussion stage ended";
    logEntry.outcome = "SILENT";
    return { published: false, attempts: generatorAttempts };
  }
  if (v1.validatorFailed) {
    logEntry.failureStage = "validator_unavailable";
    logEntry.reason = `Validator LLM unavailable on attempt 1 (${v1.code}): ${v1.error}`;
    logEntry.outcome = "SILENT_VALIDATOR_UNAVAILABLE";
    return { published: false, attempts: generatorAttempts };
  }
  logEntry.validator = v1.verdict;
  if (v1.verdict.passed) {
    logEntry.llmAction = a1.candidate;
    logEntry.visibleWordCount = a1.candidate.message.trim().split(/\s+/).filter(Boolean).length;
    const posted = await postGeneratorResultIfValid(game, chatKey, a1.candidate, built.metadata.generationRole, logEntry);
    logEntry.attempts = generatorAttempts;
    logEntry.outcome = posted ? "PUBLISHED" : "SILENT";
    return { published: posted, candidate: a1.candidate, attempts: generatorAttempts, validator: v1.verdict };
  }

  // Repetition is a selection failure, not a request to paraphrase. Other
  // semantic failures may repair the same plan once under the shared budget.
  const specialistRepetition = adaptiveBudget && isSpecialistRole(built.metadata.generationRole) && v1.verdict.failedCriteria.includes("repetition");
  const repairKind = isSpecialistRole(built.metadata.generationRole) ? "generatorRepair" : "staticRepair";
  const noSharedRepair = adaptiveBudget && adaptiveBudget.counts[repairKind] >= 1;
  if (generatorAttempts >= 2 || !allowValidatorRepair || specialistRepetition || noSharedRepair) {
    logEntry.attempts = generatorAttempts;
    logEntry.reason = specialistRepetition ? "Repeated semantic target rejected; returning to Controller for bounded reselection"
      : !allowValidatorRepair ? "Validator rejected candidate; repair disabled for this route"
      : `Validator rejected candidate; available repair already used (${generatorAttempts} generator calls)`;
    logEntry.outcome = "SILENT_VALIDATOR_REJECTED";
    return { published: false, attempts: generatorAttempts, validator: v1.verdict };
  }
  // ── Attempt 2: repair Generator (with Validator feedback) + re-audit ─
  const a2 = await attemptGeneration(buildRepairUserContent(v1.verdict.failedCriteria, a1.candidate));
  if (a2.discarded) {
    logEntry.reason = "Discarded stale AI result during repair (originating Discussion stage ended)";
    logEntry.outcome = "SILENT";
    return { published: false, attempts: generatorAttempts };
  }
  if (a2.silent) {
    logEntry.reason = `Repair Generator attempt failed: ${a2.reason}`;
    if (a2.logField) Object.assign(logEntry, a2.logField);
    logEntry.outcome = "SILENT_GENERATOR_FAILED_AFTER_VALIDATOR_REJECT";
    return { published: false, attempts: generatorAttempts };
  }

  const v2 = await runValidator(a2.candidate, v1.verdict.failedCriteria, a1.candidate);
  if (!isOriginatingStageActive()) {
    logEntry.reason = "Discarded stale repair Validator result after the originating Discussion stage ended";
    logEntry.outcome = "SILENT";
    return { published: false, attempts: generatorAttempts };
  }
  if (v2.validatorFailed) {
    logEntry.failureStage = "validator_unavailable";
    logEntry.reason = `Validator LLM unavailable on repair (${v2.code}): ${v2.error}`;
    logEntry.outcome = "SILENT_VALIDATOR_UNAVAILABLE";
    return { published: false, attempts: generatorAttempts };
  }
  logEntry.validatorRepair = v2.verdict;
  logEntry.attempts = 2;
  if (v2.verdict.passed) {
    logEntry.llmAction = a2.candidate;
    logEntry.visibleWordCount = a2.candidate.message.trim().split(/\s+/).filter(Boolean).length;
    const posted = await postGeneratorResultIfValid(game, chatKey, a2.candidate, built.metadata.generationRole, logEntry);
    logEntry.outcome = posted ? "PUBLISHED" : "SILENT";
    return { published: posted, candidate: a2.candidate, attempts: 2, validator: v2.verdict };
  }

  // Persistent failure: both attempts failed the Validator. Silent +
  // strong log marker. Never a fallback stub message -- participants
  // never see a Validator-rejected attempt. The full failedCriteria
  // (both attempts) are logged so the researcher can audit post-hoc
  // which criteria the model couldn't satisfy.
  logEntry.failureStage = "validator_rejected";
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
  if (game.get("testControlsEnabled") === undefined) initializeTestControls(game);
  const games = [...ctx.scopesByKind("game").values()];
  const { ledger, claim, ledgerKey } = claimSequenceForStudy(ctx.globals, games, game, SEQUENCE_IDS);

  game.set("sequenceId",           claim.sequenceId);
  game.set("allocationNumber",     claim.allocationNumber);
  game.set("allocationBlockId",    claim.allocationBlockId);
  game.set("allocationPosition",   claim.allocationPosition);
  game.set("allocationClaimedAt",  claim.claimedAt);
  game.set("allocationMethod",     "global_persisted_least-count-permuted-block-v1");
  game.set("allocationLedgerKey",  ledgerKey);
  game.batch?.set("sequenceAllocationSummaryV1", {
    ledgerKey,
    allocationNumber: ledger.allocationNumber,
    counts: ledger.counts,
    updatedAt: Date.now(),
  });

  try {
    const persisted = await persistAssignmentOrBlock(researchPersistence(), {
      game_id: game.id,
      sequence_id: claim.sequenceId,
      allocation_number: claim.allocationNumber,
      allocation_block_id: claim.allocationBlockId,
      allocation_position: claim.allocationPosition,
      allocation_claimed_at: new Date(claim.claimedAt).toISOString(),
      allocation_method: "global_persisted_least-count-permuted-block-v1",
      ledger_key: ledgerKey,
      assignment_status: "confirmed",
      updated_at: new Date().toISOString(),
    });
    // The obsolete Supabase production mirror is disabled, so its adapter
    // returns a Tajriba-only result. The authoritative allocation claim
    // already lives on Tajriba's persistent Global and Game scopes.
    game.set(
      "assignmentPersistenceStatus",
      persisted?.persistenceMode === "tajriba-only" ? "tajriba-only" : "confirmed",
    );
  } catch (error) {
    game.set("assignmentPersistenceStatus", "blocked");
    game.set("assignmentPersistenceError", error.message);
    throw error;
  }
});

// ── onGameStart ───────────────────────────────────────────────────────────────

Empirica.onGameStart(({ game }) => {
  const persistenceStatus = game.get("assignmentPersistenceStatus");
  // Accept both legacy "confirmed" claims and current "tajriba-only"
  // authoritative claims. Only "blocked" or missing status fails the game
  // start.
  if (persistenceStatus !== "confirmed" && persistenceStatus !== "tajriba-only") {
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
  if (phase1Duration * 60 !== FORMAL_INITIAL_DECISION_SECONDS) {
    throw new Error(`[onGameStart] phase1Duration must be ${FORMAL_INITIAL_DECISION_SECONDS / 60} minutes; got ${JSON.stringify(phase1Duration)}.`);
  }

  // Initialize game-level state
  // `llmLog` and `operationalEvents` use the bounded per-entry storage
  // pattern (see AppendOnlyAttribute.mjs + InFlightAudit.mjs). Each
  // event becomes its own Tajriba Attribute; the index here is the
  // ordered list of ids. We never write a single large `llmLog` array
  // attribute, which is what previously caused `tajriba.json` to grow
  // a single line to >1 MB and trip `bufio.Scanner: token too long`.
  ensureLlmLogIndex(game);
  ensureAppendOnlyAttribute(game, "operationalEvents");
  if (!Number.isFinite(game.get("totalInterventions"))) game.set("totalInterventions", 0);
  if (!Number.isFinite(game.get("totalFallbackMessages"))) game.set("totalFallbackMessages", 0);
  if (!game.get("llmInFlight")) game.set("llmInFlight", {});
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
  // Empirica Classic synchronous multiplayer stages must live in a Round.
  // This container is explicitly non-formal: it has no taskVersion,
  // facilitation, or taskIndex, and exists only to synchronize the shared
  // practice activity before the two experimental rounds.
  addPracticeRound(game, 2);

  const round1 = game.addRound({
    name: "Round 1",
    decisionFlowVersion: 2,
    facilitation: sequence.facilitationOrder[0],
    taskIndex:    0,
    taskVersion:  sequence.taskVersionOrder[0],
  });
  round1.addStage({ name: "Preparation", duration: 1e9 });
  round1.addStage({ name: "Task",                     duration: gameDuration * 60 });
  round1.addStage({ name: "FinalDecision",            duration: GROUP_DECISION_SECONDS });
  round1.addStage({ name: "Followup", duration: 1e9 });

  const round2 = game.addRound({
    name: "Round 2",
    decisionFlowVersion: 2,
    facilitation: sequence.facilitationOrder[1],
    taskIndex:    1,
    taskVersion:  sequence.taskVersionOrder[1],
  });
  round2.addStage({ name: "Preparation", duration: 1e9 });
  round2.addStage({ name: "Task",                     duration: gameDuration * 60 });
  round2.addStage({ name: "FinalDecision",            duration: GROUP_DECISION_SECONDS });
  round2.addStage({ name: "Followup", duration: 1e9 });

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
  adaptiveCloseoutScheduler.cancel(game, "round_started");
  round.set("callbacksInitializedAt", Date.now());
  round.set("callbacksInstanceId", CALLBACKS_INSTANCE_ID);
  if (round.get("isPractice") === true) {
    initialisePractice(round);
    return;
  }
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
  const orderedOptions = initialiseTaskOptionOrder(round, task);
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
    player.round.set("playerContent", orderTaskSections(playerConfig[slot].playerContent, orderedOptions));
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

function finalizeGroupDecision(stage, { timedOut = false, now = Date.now(), endStage = true } = {}) {
  if (stage?.get("testSkippedAt")) return false;
  if (stage?.round?.get("decisionFlowVersion") === 2) {
    const finalized = finalizeIndependentDecision(stage, { timedOut, now, endStage });
    if (finalized) {
      if (stage.round.get("isPractice")) logPractice(stage.currentGame, "group_choice", null, { choice: stage.round.get("officialGroupFinalChoice") });
      Empirica.flush();
    }
    return finalized;
  }
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
  if (round.get("isPractice")) logPractice(game, "group_choice", null, { choice: classification.officialChoice });
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
  if (endStage) stage.set("ended", true);
  Empirica.flush();
  return true;
}

function appendCanonicalMessage(game, attribute, fields) {
  const counters = { ...(game.get("messageSequenceCounters") || {}) };
  const sequencePosition = allocateSequencePosition(counters, attribute);
  game.set("messageSequenceCounters", counters);
  const message = {
    ...buildCanonicalMessage({ ...fields, sequencePosition }),
    ...(fields.phase === "practice" ? {
      phase: "practice", source: fields.source, group_id: game.id,
      speaker_id: fields.participantId ?? fields.speakerId,
      speaker_colour: fields.speaker_colour ?? null,
      exclude_from_primary_analysis: true,
    } : {}),
  };
  game.append(attribute, message);
  const round = game.currentRound;
  // The existing research.rounds schema deliberately contains only the two
  // formal task rounds. Practice remains durably stored in Tajriba on the
  // Game transcript without being misclassified as a formal Supabase round.
  if (round && round.get("isPractice") !== true) {
    queueResearchMirror("message", () => researchPersistence().upsertMessage(buildMessageRow({
      gameId: game.id, roundId: round.id, transcriptKey: attribute, message,
    })));
  }
  return message;
}

function appendTimedMessage(stage, attribute, content, messageType = MESSAGE_TYPES.TIMER_REMINDER) {
  if (!stage?.isCurrent?.() || stage.get("ended")) return false;
  const game = stage.currentGame;
  const timestamp = Date.now();
  appendCanonicalMessage(game, attribute, {
    messageId: `${messageType}-${stage.id}-${timestamp}`,
    groupId: game.id,
    speakerId: `system-${messageType}`,
    roundIndex: stage.round.get("taskIndex") ?? stage.round.get("index"),
    stage: "Discussion",
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

// One-shot facilitator-authored nudge (opening message / cold-discussion
// prompt). Mirrors appendTimedMessage's stage-liveness guard exactly, but
// publishes under the Facilitator identity (matches the existing
// postParticipantRequestFallback sender shape) instead of the Timer
// identity, and is guarded by a per-attribute `game` flag so a duplicate
// scheduling call can never post the same nudge twice. Does not touch
// CheckpointManager state (humanMessageCount, messagesSinceLastPublish,
// lastRole, etc.) or llmLog -- same "outside the checkpoint pipeline"
// treatment as the opening message historically had (see
// IMPLEMENTATION_LOGIC.md section 8) and as the "minutes remain" timer
// reminders already get.
function appendFacilitatorNudge(stage, attribute, content, onceFlagKey, facilitatorTrigger = "SILENCE_NUDGE") {
  if (!stage?.isCurrent?.() || stage.get("ended")) return false;
  const game = stage.currentGame;
  if (onceFlagKey && game.get(onceFlagKey)) return false;
  const timestamp = Date.now();
  appendCanonicalMessage(game, attribute, {
    messageId: `facilitator-nudge-${stage.id}-${timestamp}`,
    groupId: game.id,
    speakerId: "ai",
    roundIndex: stage.round.get("taskIndex") ?? stage.round.get("index"),
    stage: "Discussion",
    messageType: MESSAGE_TYPES.FACILITATOR,
    speakerType: MESSAGE_TYPES.FACILITATOR,
    timestamp,
    content,
    role: FACILITATOR_ROLES.FIXED_MESSAGE,
    facilitatorOrigin: "DETERMINISTIC_FIXED",
    facilitatorTrigger,
    sender: { id: "ai", name: "Facilitator", avatar: `https://api.dicebear.com/9.x/initials/svg?backgroundColor=000000&seed=F` },
  });
  if (onceFlagKey) game.set(onceFlagKey, true);
  // Timer/nudge callbacks run outside a player mutation, same reasoning as
  // appendTimedMessage: flush immediately so the message is delivered at
  // its scheduled time instead of waiting for the next state change.
  Empirica.flush();
  return true;
}

// Two fixed, non-LLM nudge variants for the SAME silence watchdog (see
// armSilenceWatchdog below) -- distinguished only by whether the group has
// ever sent a message yet at the moment the watchdog fires:
//   - nobody has spoken at all yet (a dead-silent opening)
//   - the group HAD been talking and has now gone quiet for the same delay
// Wording differs because "jump in" reads oddly once people have already
// been participating.
const SILENCE_NUDGE_OPENING =
  "Whenever you\u2019re ready, feel free to jump in \u2014 sharing what you each know about the options is a good place to start.";

const SILENCE_NUDGE_LULL =
  "No rush \u2014 feel free to keep sharing your thoughts whenever you\u2019re ready.";

// Placeholder, not calibrated against real discussion pacing -- see
// IMPLEMENTATION_LOGIC.md's convention of flagging uncalibrated constants
// explicitly rather than presenting them as tuned values. Confirm with the
// research team before a real pilot.
const SILENCE_NUDGE_DELAY_MS = 90_000;

// Per-game/round silence-watchdog timer handles. Not persisted -- same
// non-restart-safe nature as every other setTimeout-based reminder in this
// file (appendTimedMessage, the "minutes remain" reminders, etc): a server
// restart mid-round loses the pending timer, same as those. Keyed by
// `${game.id}:${chatKey}` so concurrent games/rounds never collide.
const silenceWatchdogTimers = new Map();

// (Re)arm a single-shot watchdog: if SILENCE_NUDGE_DELAY_MS passes with no
// further call to this function (i.e. no new human message, see the
// handleChat call site below), post exactly one nudge, choosing the
// opening/lull wording based on whether the group has ever spoken yet.
// Called once at Task-stage start (covers a dead-silent opening) and again
// on every real human message (covers a lull after the group has already
// been talking) -- the same mechanism naturally covers both cases, since
// each call cancels and replaces any still-pending timer for this
// game+round. Does not consume/interact with CheckpointManager state, same
// isolation as appendFacilitatorNudge's other callers.
function armSilenceWatchdog(stage, chatKey) {
  if (!stage?.isCurrent?.()) return;
  const game = stage.currentGame;
  const timerKey = `${game.id}:${chatKey}`;
  const existing = silenceWatchdogTimers.get(timerKey);
  if (existing) clearTimeout(existing);
  const handle = setTimeout(() => {
    silenceWatchdogTimers.delete(timerKey);
    if (!stage.isCurrent()) return;
    const hasTalked = (stage.currentGame.get("humanMessageCount") || 0) > 0;
    const content = hasTalked ? SILENCE_NUDGE_LULL : SILENCE_NUDGE_OPENING;
    // No once-flag: a fresh silence episode (rearmed after the group talks
    // again) is allowed to post another nudge later in the same round.
    appendFacilitatorNudge(stage, chatKey, content, null, "SILENCE_NUDGE");
  }, SILENCE_NUDGE_DELAY_MS);
  silenceWatchdogTimers.set(timerKey, handle);
}

// Cancel a pending watchdog (round/stage ending). Safe to call even if no
// timer is currently pending.
function clearSilenceWatchdog(gameId, chatKey) {
  const timerKey = `${gameId}:${chatKey}`;
  const existing = silenceWatchdogTimers.get(timerKey);
  if (existing) {
    clearTimeout(existing);
    silenceWatchdogTimers.delete(timerKey);
  }
}

export function handleFormalStageStart(stage) {
  const game = stage.currentGame;
  const stageName = stage.get("name");
  if (stage.round.get("isPractice") && stageName !== "FinalDecision") return;
  if (stage.get("formalStageStartHandled")) { adaptiveCloseoutScheduler.register(game); return; }
  stage.set("formalStageStartHandled", true);
  stage.set("callbacksInitializedAt", Date.now());
  stage.set("callbacksInstanceId", CALLBACKS_INSTANCE_ID);
  const { gameDuration } = game.get("treatment");
  const now = Date.now();
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
    adaptiveCloseoutScheduler.register(game);
    const chatKey = `chat_round_${stage.round.get("taskIndex")}`;
    const durationMs = gameDuration * 60 * 1000;
    const reminderMinutes = Math.ceil(gameDuration / 2);
    const reminderAt = game.get("deadline") - reminderMinutes * 60 * 1000;
    const reminderDelayMs = Math.max(0, reminderAt - Date.now());
    setTimeout(() => appendTimedMessage(stage, chatKey, `${reminderMinutes} minutes remain in the discussion. ${DECISION_NUDGE}`), reminderDelayMs);
    if (durationMs > 60_000) setTimeout(() => appendTimedMessage(stage, chatKey, `One minute remains in the discussion. ${DECISION_NUDGE}`), durationMs - 60_000);

    // Opening message: one fixed, non-LLM Facilitator message at the very
    // start of every Task-stage discussion. Independent of the checkpoint
    // pipeline (no Generator/Validator call, no CheckpointManager state).
    appendFacilitatorNudge(stage, chatKey, DISCUSSION_OPENING_MESSAGE, `openingPosted_${chatKey}`, "DISCUSSION_OPENING");

    // Silence watchdog: covers both a dead-silent opening AND a later lull
    // after the group has already been talking (see armSilenceWatchdog).
    // Only schedules when the round is long enough for the delay to make
    // sense.
    if (durationMs > SILENCE_NUDGE_DELAY_MS + THRESHOLDS.gate.min_time_for_intervention_seconds * 1000) {
      armSilenceWatchdog(stage, chatKey);
    }
  }
  if (stageName === "FinalDecision") {
    stage.round.set("FinalDecisionStartedAt", now);
    stage.round.set("finalDecisionAgreementStatus", "not_agreed");
    stage.round.set("finalDecisionMatchedChoice", null);
    stage.round.set("officialGroupFinalChoice", null);
    stage.round.set("finalDecisionOutcome", null);
    stage.round.set("finalDecisionTimedOut", false);
    stage.round.set("finalDecisionFinalizedAt", null);
    stage.round.set("finalDecisionDraftChoices", []);
    stage.round.set("finalDecisionConfirmed", false);
    stage.round.set("finalDecisionDeadline", now + GROUP_DECISION_SECONDS * 1000);
    for (const participant of assignedHumanPlayers(game)) {
      if (stage.round.get("decisionFlowVersion") === 2) {
        for (const key of ["finalDecisionSubmission", "finalDecisionSubmissionResult", "finalDecision",
          "agreesWithGroupChoice", "finalPersonalChoice", "finalPersonalChoiceRationale",
          "groupFinalSubmittedAt", "groupFinalTimeoutReason"]) participant.round.set(key, null);
      }
      participant.round.set("groupFinalChoice", "");
      participant.round.set("groupChoiceConfidence", null);
      participant.round.set("groupFinalConfirmedChoice", null);
      participant.round.set("groupFinalConfirmedAt", null);
    }
    // Empirica's native 90-second stage timer is the single mechanism that
    // ends this stage. onStageEnded below records timeout_fail exactly once.
    Empirica.flush();
  }
  if (stageName === "IndividualAssessment" && stage.round.get("finalDecisionOutcome") === "consensus_choice") {
    for (const participant of assignedHumanPlayers(game)) {
      participant.stage?.set("submit", true);
    }
    stage.set("ended", true);
    Empirica.flush();
  }
}

Empirica.onStageStart(({ stage }) => {
  handlePracticeStageStart(stage, appendCanonicalMessage, Empirica);
  handlePersonalFlowStageStart(stage);
  handleFormalStageStart(stage);
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

Empirica.on("player", "finalDecisionSubmitRequest", (_ctx, { player, finalDecisionSubmitRequest: request }) => {
  const round = player.currentGame?.currentRound;
  const wasFinalized = round?.get("finalDecisionConfirmed");
  acceptIndependentDecision(player, request);
  if (!wasFinalized && round?.get("isPractice") && round.get("finalDecisionConfirmed")) {
    logPractice(player.currentGame, "group_choice", null, { choice: round.get("officialGroupFinalChoice") });
  }
  Empirica.flush();
});

Empirica.on("player", "finalDecisionDraftRequest", (_ctx, { player, finalDecisionDraftRequest: request }) => {
  const game = player.currentGame;
  const round = game?.currentRound;
  const stage = game?.currentStage;
  if (!game || !round || !stage || stage.get("name") !== "FinalDecision" || round.get("finalDecisionConfirmed")) return;
  if (round.get("decisionFlowVersion") === 2 || stage.get("testSkippedAt")) return;
  if (!request || request.roundId !== round.id || request.stageId !== stage.id) return;
  if (Date.now() >= round.get("finalDecisionDeadline")) {
    finalizeGroupDecision(stage, { timedOut: true });
    return;
  }

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
  if (round.get("decisionFlowVersion") === 2 || stage.get("testSkippedAt")) return;
  if (!request || request.roundId !== round.id || request.stageId !== stage.id) return;
  if (Date.now() >= round.get("finalDecisionDeadline")) {
    finalizeGroupDecision(stage, { timedOut: true });
    return;
  }

  const drafts = finalDecisionDrafts(game);
  const review = reviewFinalDecisionConfirmation({
    drafts,
    participantId: player.id,
    requestChoice: request.choice,
  });
  if (!review.accepted) return;

  // Duplicate confirmations are idempotent and always bind to the current
  // matching choice, never merely to a participant identity.
  player.round.set("groupFinalConfirmedChoice", review.matchedChoice);
  player.round.set("groupFinalConfirmedAt", Date.now());
  finalizeGroupDecision(stage);
  Empirica.flush();
});

Empirica.on("playerStage", "submit", (_ctx, { playerStage, submit }) => {
  if (!submit || !playerStage?.stage?.isCurrent?.()) return;
  const player = playerStage.player;
  const round = playerStage.stage.round;
  const stageName = playerStage.stage.get("name");
  if (stageName === "FinalDecision" && round.get("decisionFlowVersion") === 2) return;
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

Empirica.on("player", "humanMessageRequest", async (_ctx, { player, humanMessageRequest: request }) => {
  const game = player.currentGame;
  const round = game?.currentRound;
  const stage = game?.currentStage;
  if (!game || !round || !stage) return;
  if (round.get("isPractice")) {
    const practiceResult = handlePracticeMessage(player, request, appendCanonicalMessage, Empirica);
    Empirica.flush();
    if (practiceResult?.status === "accepted" && containsFacilitatorMention(practiceResult.content)) {
      try {
        await handlePracticeFacilitatorRequest(game, {
          ...practiceResult,
          participantId: player.id,
        });
      } catch (error) {
        recordOperationalEvent(game, {
          type: "PRACTICE_FACILITATOR_REQUEST_FAILED",
          roundId: round.id,
          stageId: stage.id,
          messageId: practiceResult.messageId,
          error: error instanceof Error ? error.message : String(error),
        });
        Empirica.flush();
      }
    }
    return;
  }
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
    currentRoundIndex: round.get("taskIndex"),
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
      roundIndex: round.get("taskIndex") ?? round.get("index"),
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

// ── on("game", "chat_round_N") ────────────────────────────────────────────────

// GRAIL's single, shared chat-publication path (Static AND Adaptive) --
// final defensive check plus the actual game.append/totalInterventions
// write. By the time this is called from runSharedGeneration, the schema,
// deterministic, and live Semantic Validator checks have passed, so these
// checks are a final defensive guard. Returns true if a message was posted.
async function postGeneratorResultIfValid(game, chatKey, llmAction, expectedRole, logEntry) {
  if (!llmAction || typeof llmAction.message !== "string" || !llmAction.message.trim()) {
    logEntry.reason = "LLM response missing a valid non-empty 'message' field (per generation.schema.json)";
    return false;
  }
  if (llmAction.role !== expectedRole) {
    logEntry.reason = `LLM response role "${llmAction.role}" does not match the expected role "${expectedRole}" (base.md OUTPUT CONTRACT requires role to be unchanged) -- not posted`;
    return false;
  }
  return whileFacilitatorPublishesVisibleResponse(game, logEntry, () => {
    const publishedAt = Date.now();
    const practice = logEntry.phase === "practice";
    const publishedMessage = appendCanonicalMessage(game, chatKey, {
      messageId: `facilitator-${game.currentRound?.id}-${publishedAt}`,
      groupId: game.id,
      speakerId: "ai",
      roundIndex: practice ? game.currentRound?.get("index") : game.currentRound?.get("taskIndex"),
      stage: practice ? logEntry.originatingStageName : "Discussion",
      messageType: MESSAGE_TYPES.FACILITATOR,
      speakerType: MESSAGE_TYPES.FACILITATOR,
      timestamp: publishedAt,
      content: llmAction.message,
      ...(practice ? { phase: "practice", source: "facilitator_api", exclude_from_primary_analysis: true } : {}),
      role: llmAction.role,
      facilitatorOrigin: "LLM_GENERATED",
      facilitatorTrigger: logEntry.triggerType === "PARTICIPANT_REQUEST"
        ? "PARTICIPANT_REQUEST"
        : "AUTOMATIC_CHECKPOINT",
      auditRequestId: logEntry.auditRequestId,
      presentation: llmAction.presentation,
      sender: { id: "ai", name: "Facilitator", avatar: `https://api.dicebear.com/9.x/initials/svg?backgroundColor=000000&seed=F` },
    });
    logEntry.messageAdded = true;
    logEntry.countsAsIntervention = !practice;
    logEntry.publishedMessageId = publishedMessage.messageId;
    if (!practice) game.set("totalInterventions", (game.get("totalInterventions") || 0) + 1);
    return true;
  });
}

// A participant-requested turn must receive a visible response even when the
// prompt, model, parser, or Validator is unavailable. This deterministic
// fallback is intentionally neutral and reveals no hidden information.
async function postParticipantRequestFallback(game, chatKey, logEntry) {
  return whileFacilitatorPublishesVisibleResponse(game, logEntry, () => {
    const publishedAt = Date.now();
    const practice = logEntry.phase === "practice";
    const publishedMessage = appendCanonicalMessage(game, chatKey, {
      messageId: `facilitator-fallback-${game.currentRound?.id}-${publishedAt}`,
      groupId: game.id,
      speakerId: "ai",
      roundIndex: practice ? game.currentRound?.get("index") : game.currentRound?.get("taskIndex"),
      stage: practice ? logEntry.originatingStageName : "Discussion",
      messageType: MESSAGE_TYPES.FACILITATOR,
      speakerType: MESSAGE_TYPES.FACILITATOR,
      timestamp: publishedAt,
      content: "Sorry, I couldn’t complete that reply. Please try asking me again; I can help explain terms or summarise and compare what your group has shared.",
      ...(practice ? { phase: "practice", source: "facilitator_fallback", exclude_from_primary_analysis: true } : {}),
      role: FACILITATOR_ROLES.NON_LLM_FALLBACK,
      facilitatorOrigin: "NON_LLM_FALLBACK",
      facilitatorTrigger: "PARTICIPANT_REQUEST",
      auditRequestId: logEntry.auditRequestId,
      sender: { id: "ai", name: "Facilitator", avatar: `https://api.dicebear.com/9.x/initials/svg?backgroundColor=000000&seed=F` },
    });
    logEntry.messageAdded = true;
    logEntry.countsAsIntervention = false;
    logEntry.publishedMessageId = publishedMessage.messageId;
    logEntry.fallbackUsed = "PARTICIPANT_REQUEST_SAFE_CLARIFICATION";
    logEntry.outcome = "PUBLISHED_REQUEST_FALLBACK";
    if (!practice) game.set("totalFallbackMessages", (game.get("totalFallbackMessages") || 0) + 1);
    return true;
  });
}

function practiceRequestedContext(chat, stageName) {
  return chat
    .filter((message) => message?.phase === "practice"
      && message?.stage === stageName
      && [MESSAGE_TYPES.HUMAN, MESSAGE_TYPES.FACILITATOR].includes(message?.messageType))
    .map((message) => ({ ...message, stage: "Discussion" }));
}

async function handlePracticeFacilitatorRequest(game, requestMessage) {
  const round = game.currentRound;
  const stage = game.currentStage;
  const stageName = requestMessage?.stage;
  if (!round?.get("isPractice")
    || !stage
    || stage.id !== game.currentStage?.id
    || stage.get("name") !== stageName
    || !["PracticeWelcome", "PracticeDiscussion"].includes(stageName)
    || stage.get("ended")
    || !containsFacilitatorMention(requestMessage?.content)) return;

  const now = Date.now();
  const auditRequestId = `practice:${requestMessage.messageId}`;
  const contextChat = practiceRequestedContext(game.get(PRACTICE_CHAT) || [], stageName);
  const humanMessageCount = getHumanMessages(contextChat).length;
  const logEntry = {
    stageId: stage.id,
    roundId: round.id,
    auditRequestId,
    timestamp: now,
    roundIndex: round.get("index"),
    facilitation: "practice_requested",
    phase: "practice",
    excludeFromPrimaryAnalysis: true,
    humanMessageCount,
    messagesSinceLastPublish: 0,
    messagesSinceLastIntervention: 0,
    remainingTime: Number.isFinite(round.get("practiceDeadline"))
      ? Math.max(0, round.get("practiceDeadline") - now)
      : 0,
    timeElapsed: Number.isFinite(round.get("practiceDiscussionStartedAt"))
      ? Math.max(0, now - round.get("practiceDiscussionStartedAt"))
      : Math.max(0, now - (stage.get("practiceStartedAt") || now)),
    requestMade: false,
    requestSuccess: false,
    messageAdded: false,
    outcome: "PENDING",
    model: openaiModel,
    mentionDetected: true,
    participantRequested: true,
    triggerType: "PARTICIPANT_REQUEST",
    routingDecision: "REQUESTED_GENERALIST",
    selectedRole: "REQUESTED_GENERALIST",
    originatingRoundId: round.id,
    originatingStageId: stage.id,
    originatingStageName: stageName,
    originatingMessageId: requestMessage.messageId,
    serverInstanceId: CALLBACKS_INSTANCE_ID,
  };

  const beganInFlight = await beginInFlight(game, logEntry, () => Empirica.flush());
  if (!beganInFlight) return;
  logPractice(game, "facilitator_requested", null, {
    speaker_id: requestMessage.participantId,
    message_id: requestMessage.messageId,
    stage: stageName,
  });

  try {
    const requestedPrompt = getRequestedGeneralistPromptBundle();
    const built = buildGeneratorContext(
      game,
      game.players,
      contextChat,
      logEntry.remainingTime,
      logEntry.timeElapsed,
      "adaptive",
      "generalist",
      null,
      requestedPrompt,
    );
    const result = await runSharedGeneration(
      game,
      PRACTICE_CHAT,
      built,
      logEntry,
      round.id,
      stage.id,
      contextChat,
    );
    if (!result.published && canPublishFacilitatorResult(game, logEntry)) {
      await postParticipantRequestFallback(game, PRACTICE_CHAT, logEntry);
    }
  } catch (error) {
    logEntry.failureStage = "practice_requested_pipeline";
    logEntry.reason = error instanceof Error ? error.message : String(error);
    logEntry.outcome = "SILENT_ERROR";
    if (canPublishFacilitatorResult(game, logEntry)) {
      await postParticipantRequestFallback(game, PRACTICE_CHAT, logEntry);
    }
  } finally {
    logPractice(game, "facilitator_request_completed", null, {
      speaker_id: requestMessage.participantId,
      message_id: requestMessage.messageId,
      response_message_id: logEntry.publishedMessageId ?? null,
      outcome: logEntry.outcome,
      stage: stageName,
    });
    await finalizeAuditLogBase(game, logEntry, () => Empirica.flush());
  }
}

async function handleChat(env, { game, adaptiveTrigger = null }) {
  if (game.currentRound?.get("isPractice")) return;
  await recoverInterruptedInFlight(
    game,
    CALLBACKS_INSTANCE_ID,
    Date.now(),
    () => Empirica.flush(),
  );
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
  const roundIndex   = currentRound?.get("taskIndex");
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
  if (!chat.length && !adaptiveTrigger) return;

  const lastMessage = chat[chat.length - 1];
  if (!adaptiveTrigger && !isFormalHumanMessage(lastMessage)) return;

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
  // Attribute listeners may replay the same full chat value. Claim the
  // canonical final human message synchronously after the stage/timing guards
  // so a duplicate callback cannot increment pacing counters or start a
  // second pipeline, while a transiently incomplete stage can still retry.
  if (!adaptiveTrigger && typeof lastMessage.messageId === "string" && lastMessage.messageId.length > 0) {
    if (game.get("lastProcessedHumanMessageId") === lastMessage.messageId) return;
    game.set("lastProcessedHumanMessageId", lastMessage.messageId);
  }
  const originatingRoundId = currentRound.id;
  const originatingStageId = game.currentStage.id;

  // ── Count the new human message (AI messages do not count, and
  // we already early-returned above if the last message is from AI). ──
  const humanMessageCount = (game.get("humanMessageCount") || 0) + (adaptiveTrigger ? 0 : 1);
  game.set("humanMessageCount", humanMessageCount);

  // A real human message breaks any silence -- rearm the watchdog so a
  // LATER lull (the group goes quiet again after this) can still be
  // caught, same delay as the opening case.
  if (!adaptiveTrigger) armSilenceWatchdog(game.currentStage, chatKey);

  // ── Increment the opportunity counter (Phase 3: also tracked as
  // messagesSinceLastPublish; the legacy messagesSinceLastIntervention
  // field is kept as a derived/legacy alias so existing logs / tests
  // that reference it don't break). ──
  const messagesSinceLastPublish = (game.get("messagesSinceLastPublish") ?? 0) + (adaptiveTrigger ? 0 : 1);
  game.set("messagesSinceLastPublish", messagesSinceLastPublish);
  // Legacy alias (was reset to 0 on every attempt in the v1 code; now
  // it tracks the same counter as messagesSinceLastPublish, so old
  // log readers and tests that read it still get a sensible value).
  game.set("messagesSinceLastIntervention", messagesSinceLastPublish);

  const now = Date.now();
  const remainingTime = Math.max(0, game.get("deadline") - now);
  const timeElapsed   = now - game.get("taskStartTime");

  // ── Phase 3: ask CheckpointManager whether the trigger conditions
  // are satisfied. Ordinary Static/Adaptive messages share the six-message
  // gate and 30-second cooldown. Adaptive uses a 20-second floor and its
  // independent closeout scheduler shares the same in-flight lock. Neither has a
  // per-round automatic-attempt cap. Task/chat guards and per-message
  // deduplication remain shared.
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
  const isMentionCheckpoint = !adaptiveTrigger && containsFacilitatorMention(latestHumanText);

  let trigger = shouldEvaluateCheckpoint({
    store: game,
    humanMessageCount,
    currentStageName,
    remainingTimeMs: remainingTime,
    chatKeyPresent: true,
    now,
    isMentionCheckpoint,
    config: facilitation === "adaptive" ? { ...CHECKPOINT_DEFAULTS, minTimeForInterventionMs: ADAPTIVE_FLOOR_MS } : CHECKPOINT_DEFAULTS,
  });
  let triggerSource = "message";
  if (facilitation === "adaptive" && !isMentionCheckpoint) {
    adaptiveCloseoutScheduler.register(game);
    if (adaptiveTrigger) {
      triggerSource = trigger.trigger ? "message" : adaptiveTrigger.triggerSource;
      const cooldown = now - (game.get("lastAttemptTimestamp") || 0) < CHECKPOINT_DEFAULTS.cooldownMs;
      trigger = { trigger: remainingTime > ADAPTIVE_FLOOR_MS && !cooldown, reason: cooldown ? "cooldown" : "adaptive_20s_floor" };
    } else {
      // Any new public message invalidates an earlier intent snapshot. The
      // next semantic scan recalculates withdrawals/objections from context.
      if (currentRound.get("adaptiveEarlyCloseout")) currentRound.set("adaptiveEarlyCloseout", { active: false, reason: "new_message_requires_review" });
      if (!trigger.trigger && new Set(latestHumanMessages.map(m => m.sender.id)).size >= 2 && remainingTime > ADAPTIVE_FLOOR_MS) adaptiveCloseoutScheduler.request(game);
    }
  }

  // Every callback audit event needs an identity, including ordinary
  // non-trigger outcomes (opportunity/cooldown/time-floor/dedup). Keep the
  // same id for a later beginInFlight/finalize lifecycle when the checkpoint
  // does trigger.
  const auditRequestId = `${game.id}:${roundIndex}:${humanMessageCount}:${now}${adaptiveTrigger ? `:${randomUUID()}` : ""}`;
  let logEntry = {
    stageId: originatingStageId, roundId: currentRound.id,
    auditRequestId,
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
    triggerSource,
    triggerSources: adaptiveTrigger?.triggerSources ?? ["message"],
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
    await finalizeAuditLog(game, logEntry);
    return { deferred: remainingTime > ADAPTIVE_FLOOR_MS, outcome: logEntry.outcome };
  }

  logEntry.serverInstanceId = CALLBACKS_INSTANCE_ID;
  const beganInFlight = await beginInFlight(
    game,
    { ...logEntry, outcome: "PENDING" },
    () => Empirica.flush(),
    isMentionCheckpoint ? undefined : { exclusiveGroup: AUTOMATIC_PIPELINE_GROUP },
  );
  if (!beganInFlight) {
    if (facilitation === "adaptive" && !isMentionCheckpoint && !adaptiveTrigger) adaptiveCloseoutScheduler.request(game);
    logEntry.outcome = "SILENT_AUTOMATIC_IN_FLIGHT";
    logEntry.reason = "Skipped automatic checkpoint because an earlier automatic intervention pipeline is still in flight";
    await finalizeAuditLog(game, logEntry);
    return { deferred: remainingTime > ADAPTIVE_FLOOR_MS, outcome: logEntry.outcome };
  }

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
      await postParticipantRequestFallback(game, chatKey, logEntry);
    }
    if (requestedResult.published) {
      recordParticipantRequestedPublish(game, {
        role: "REQUESTED_GENERALIST",
        messageId: logEntry.publishedMessageId ?? requestedResult.candidate?.messageId ?? null,
        now,
      });
    }
    await finalizeAuditLog(game, logEntry);
    return;
  }

  // ── Record the attempt BEFORE the pipeline runs. The dedup field
  // is part of this so a re-entrant call for the same humanMessageCount
  // (e.g. a duplicate Empirica event) cannot double-trigger. ──
  recordAttempt(game, humanMessageCount, now);

  // Static and Adaptive share the checkpoint pacing above. Static's fixed
  // policy requires a message attempt at every eligible checkpoint, so it bypasses every discussion-state
  // assessment step and goes directly to the shared Generator/validation/
  // publication path. A blocked prompt or technical failure remains SILENT
  // and logged; it is not a discussion-state ABSTAIN and never fabricates a
  // fallback participant-facing message.
  if (facilitation === "static") {
    logEntry.routingDecision = "STATIC_REQUIRED_MESSAGE";
    // 2026-10-21: matched-latency delay (see staticMatchedDelayMs()).
    const matchedDelayMs = staticMatchedDelayMs();
    if (matchedDelayMs > 0) {
      logEntry.staticMatchedDelayMs = matchedDelayMs;
      await new Promise((resolve) => setTimeout(resolve, matchedDelayMs));
      if (
        game.currentRound?.id !== originatingRoundId ||
        game.currentStage?.id !== originatingStageId ||
        game.currentStage?.get("name") !== "Task"
      ) {
        logEntry.reason = "Discarded Static checkpoint: the originating Discussion stage ended during the matched delay";
        await finalizeAuditLog(game, logEntry);
        return;
      }
    }
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
    // Phase 3: record a publish so Static's opportunity gate resets for the
    // next paced checkpoint. Phase 2 made Static AI's role "STATIC" instead
    // of "generalist"; the publish is recorded with that role so
    // interventionHistory, lastRole, publishedThisRound all stay
    // consistent across both conditions.
    if (result.published) {
      recordPublish(game, { role: "STATIC", messageId: logEntry.publishedMessageId ?? result.candidate?.messageId ?? null, now });
    }
    await finalizeAuditLog(game, logEntry);
    return;
  }

  // Fail closed on an unexpected Round condition without sending it through
  // either policy. The real S1-S4 table assigns only static/adaptive.
  if (facilitation !== "adaptive") {
    logEntry.reason = `Unrecognized facilitation condition: ${JSON.stringify(facilitation)}`;
    await finalizeAuditLog(game, logEntry);
    return;
  }

  const formalChat = chat.filter(isFormalContextMessage);
  const cognitiveHistory = currentRound.get("cognitiveInterventionHistory") || [];
  const rosterNames = players.map(p => p.get("name")).filter(Boolean);
  const participationCounts = countPublicMessagesByName(formalChat, rosterNames);
  const quietNames = quietParticipants(participationCounts);
  logEntry.participationCounts = participationCounts;
  logEntry.quietParticipants = quietNames;
  logEntry.publicContextFingerprint = publicContextFingerprint(chat);
  const budget = createAdaptiveBudget({
    deadline: () => game.get("deadline"), log: logEntry,
    isCurrent: () => canPublishFacilitatorResult(game, logEntry)
      && publicContextFingerprint(game.get(chatKey) || []) === logEntry.publicContextFingerprint,
  });
  let publishedPlan = null;
  async function assess(excluded = []) {
    if (!budget.check()) return null;
    const start = Date.now();
    const remaining = budget.remainingTime();
    const scheduling = { remainingTimeMs: remaining, triggerSource: logEntry.triggerSource,
      fixedIntegrationPriority: remaining <= 120_000, closeoutOpportunity: remaining <= 180_000,
      priority: remaining <= 120_000 ? ["INTEGRATE", "SCRUTINIZE", "ELICIT"] : ["SCRUTINIZE", "INTEGRATE", "ELICIT"],
      evaluateEarlyCloseout: true };
    const assessorResult = await assessSemanticFactors({
      chat: formalChat, contextScope: "complete_current_round", interventionHistory: cognitiveHistory,
      activeParticipantNames: rosterNames, participationCounts, quietParticipants: quietNames,
      scheduling, excludedTargets: excluded, allowStructureRepair: true,
      taskGeneralContext: buildStaticSharedTaskOverview({ generalInfo: currentRound.get("generalInfo"), decisionOptions: currentRound.get("decisionOptions") }),
      callLLM: (messages, options) => budget.call("assessor", timing => getLLMResponse(messages,
        Math.max(Number(llmMaxOutputTokens) || 1000, 4096), { reasoningEffort: "low", ...timing }),
        options?.structureRepair ? "assessorRepair" : null),
    });
    const attempt = { latencyMs: Date.now() - start, rawText: assessorResult.rawText, success: assessorResult.success,
      code: assessorResult.code, error: assessorResult.error, structureFailures: assessorResult.attempts, responseMetadata: assessorResult.responseMetadata };
    logEntry.assessments = [...(logEntry.assessments || []), attempt];
    logEntry.detectorLatency = attempt.latencyMs;
    logEntry.detectorRawResponse = attempt.rawText;
    logEntry.detectorResponseMetadata = assessorResult.responseMetadata;
    if (!assessorResult.success) {
      logEntry.detectorError = `${attempt.code}: ${attempt.error}`;
      const gate = evaluateNeedGate(null, { remainingTime: budget.remainingTime() });
      Object.assign(logEntry, { gateDecision: gate.decision, gateReason: gate.reason, fallbackKind: gate.fallbackKind, abstentionKind: gate.abstentionKind });
      return null;
    }
    if (!budget.check()) return null;
    logEntry.rawDetectorFactors = assessorResult.factors;
    const checked = selectAdaptiveAssessment(assessorResult.factors, {
      chat: formalChat, roster: rosterNames,
      optionLabels: (currentRound.get("decisionOptions") || []).map(o => o.label),
      remainingTimeMs: budget.remainingTime(), triggerSource: logEntry.triggerSource, history: cognitiveHistory, excluded,
      validateIntegration: (candidate, semanticReview) => {
        const plan = compilePlan("synthesiser", candidate.checkedFactors, {
          eligibleMessageIds: withMessageIds(formalChat).filter(isFormalHumanMessage).map(m => m.messageId),
          interventionHistory: cognitiveHistory, semanticReview, excludedTargets: excluded,
        });
        return preflightPlan(plan, { chat: formalChat, activeParticipantNames: rosterNames,
          interventionHistory: cognitiveHistory, taskGeneralContext: buildStaticSharedTaskOverview({
            generalInfo: currentRound.get("generalInfo"), decisionOptions: currentRound.get("decisionOptions"),
          }) });
      },
    });
    checked.excludedTargets = excluded;
    logEntry.checkedDetectorFactors = { need: checked.need, rawNeed: checked.rawNeed, role: checked.role,
      operation: checked.operation, target: checked.target, downgradedReason: checked.downgradedReason,
      ...(checked.defer ? { defer: checked.defer } : {}), evidenceRelations: [] };
    logEntry.scheduling = checked.scheduling;
    logEntry.earlyCloseout = checked.early;
    logEntry.integrationObservation = checked.integrationObservation;
    logEntry.semanticReview = checked.semanticReview ?? checked.semantic ?? null;
    currentRound.set("adaptiveEarlyCloseout", { ...checked.early, humanMessageCount, assessedAt: Date.now() });
    if (checked.semanticReview) {
      const states = { ...(currentRound.get("adaptiveTargetStates") || {}) };
      for (const match of checked.semanticReview.matches) states[match.id] = { ...match, assessedAt: Date.now(), publicMessageBoundary: formalChat.length };
      currentRound.set("adaptiveTargetStates", states);
    }
    game.set("lastCheckedDetectorFactors", logEntry.checkedDetectorFactors);
    const gate = evaluateNeedGate(checked, { remainingTime: budget.remainingTime(), scheduling: checked.scheduling });
    Object.assign(logEntry, { gateDecision: gate.decision, gateReason: gate.reason, eligibleRoles: gate.eligibleRoles,
      stateScores: gate.scores, perRole: gate.perRole, abstentionKind: gate.abstentionKind, fallbackKind: gate.fallbackKind });
    return checked;
  }
  async function fallback() {
    logEntry.selectedRole = "STATIC";
    logEntry.routingDecision = "ADAPTIVE_STATIC_POLICY";
    delete logEntry.validator;
    delete logEntry.validatorRepair;
    delete logEntry.failureStage;
    const built = buildGeneratorContext(game, players, chat, budget.remainingTime(), Date.now() - game.get("taskStartTime"), "static", null, null);
    const result = await runSharedGeneration(game, chatKey, built, logEntry, originatingRoundId, originatingStageId, chat, { adaptiveBudget: budget });
    return { ...result, role: "STATIC", outcome: logEntry.outcome };
  }
  async function generate(selection) {
    const gate = evaluateNeedGate(selection, { remainingTime: budget.remainingTime(), scheduling: selection.scheduling });
    if (gate.decision !== "specialist") return { published: false };
    const chosen = chooseRole(gate);
    logEntry.selectedRole = chosen.role;
    logEntry.controllerSelectedRole = chosen.role;
    logEntry.forced = false;
    logEntry.reasoning = gate.reason;
    const plan = compilePlan(chosen.role, selection.checkedFactors, {
      eligibleMessageIds: withMessageIds(formalChat).filter(isFormalHumanMessage).map(m => m.messageId),
      interventionHistory: cognitiveHistory, scheduling: selection.scheduling, semanticReview: selection.semanticReview,
      excludedTargets: selection.excludedTargets,
    });
    logEntry.plan = plan;
    delete logEntry.validator;
    delete logEntry.validatorRepair;
    const built = buildGeneratorContext(game, players, chat, budget.remainingTime(), Date.now() - game.get("taskStartTime"), "adaptive", chosen.role, plan);
    const result = await runSharedGeneration(game, chatKey, built, logEntry, originatingRoundId, originatingStageId, chat, { adaptiveBudget: budget });
    if (result.published) publishedPlan = plan;
    return { ...result, role: chosen.role, outcome: logEntry.outcome, reason: logEntry.reason, failureStage: logEntry.failureStage,
      repetition: result.repetition || built.planPreflight?.failureReasons?.includes("TARGET_ALREADY_ADDRESSED") || false };
  }
  try {
    const initial = await assess();
    const result = await runAdaptiveSelection({ assess, generate, fallback, budget, log: logEntry, initial,
      closeoutOnly: logEntry.triggerSource !== "message" });
    logEntry.totalGeneratorAttempts = budget.calls.filter(c => c.kind === "generator").length;
    logEntry.modelCallCount = budget.calls.length;
    if (result.published) {
      recordPublish(game, { role: result.role, messageId: logEntry.publishedMessageId, now: Date.now() });
      if (publishedPlan) currentRound.set("cognitiveInterventionHistory", [...cognitiveHistory, {
        planId: publishedPlan.planId, signature: publishedPlan.signature, role: result.role,
        requiredReasoningAct: publishedPlan.requiredReasoningAct, target: publishedPlan.target,
        evidence: publishedPlan.evidence, semanticKey: publishedPlan.semanticReview?.key ?? publishedPlan.target.label,
        expectedUptake: publishedPlan.expectedUptake, messageId: logEntry.publishedMessageId,
        publicMessageBoundary: formalChat.length, message: result.candidate?.message, timestamp: Date.now(),
      }]);
    }
  } catch (error) {
    logEntry.outcome = "SILENT_CONTROLLER_ERROR";
    logEntry.reason = String(error?.message || error);
  } finally {
    logEntry.modelCallCount = budget.calls.length;
    logEntry.totalGeneratorAttempts = budget.calls.filter(c => c.kind === "generator").length;
    if (logEntry.cancellation) logEntry.reason = logEntry.cancellation.reason;
    await finalizeAuditLog(game, logEntry);
    adaptiveCloseoutScheduler.resume(game);
  }
  return { deferred: logEntry.cancellation?.reason === "discussion_context_changed", outcome: logEntry.outcome };

}

Empirica.on("game", "chat_round_0", handleChat);
Empirica.on("game", "chat_round_1", handleChat);

Empirica.onStageEnded(({ stage }) => {
  if (stage.get("name") === "Task") adaptiveCloseoutScheduler.cancel(stage.currentGame, "stage_ended");
  const round = stage.round;
  const game = stage.currentGame;
  const stageName = stage.get("name");
  if (stageName === "FinalDecision" && !round.get("finalDecisionConfirmed") && !(game.get("testControlsEnabled") === true && stage.get("testSkippedAt"))) {
    finalizeGroupDecision(stage, { timedOut: true, endStage: false });
  }
  if (round.get("isPractice")) {
    if (stageName === "PracticeDiscussion" && !round.get("practiceDiscussionEnded")) {
      round.set("practiceDiscussionEnded", "timeout");
      logPractice(game, "discussion_timeout");
    }
    return;
  }
  if (["Task", "InitialDecision", "FinalDecision", "IndividualAssessment"].includes(stageName)) {
    round.set(`${stageName}EndedAt`, Date.now());
  }
  if (stageName === "Task") {
    clearSilenceWatchdog(game.id, `chat_round_${round.get("taskIndex")}`);
  }

  if (stageName === "FinalDecision") {
    for (const player of assignedHumanPlayers(game)) {
      if (round.get("finalDecisionTimedOut") && (round.get("decisionFlowVersion") !== 2 || !player.round.get("finalDecisionSubmission"))) player.round.set("groupFinalTimeoutReason", "stage_timeout");
    }
  }

  if (stageName === "InitialDecision") {
    for (const player of assignedHumanPlayers(game)) {
      if (!player.round.get("initialSubmittedAt") && !player.round.get("initialDecisionTimeoutReason")) {
        player.round.set("initialDecisionTimeoutReason", "stage_timeout");
      }
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
  if (round.get("isPractice") === true) return;
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
  adaptiveCloseoutScheduler.cancel(game, "game_ended");
  const storedEndedAt = game.get("endedAt");
  const endedAt = typeof storedEndedAt === "string" && storedEndedAt.trim()
    ? storedEndedAt
    : new Date().toISOString();
  if (endedAt !== storedEndedAt) game.set("endedAt", endedAt);
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
