import { ClassicListenersCollector } from "@empirica/core/admin/classic";
export const Empirica = new ClassicListenersCollector();
import _ from "lodash";
import dotenv from "dotenv";
import taskConfig from "./HPTConfig.json";
import { llmSystemPrompts } from "./LLMConfig.js";
import { THRESHOLDS, getCandidateRoles, evaluateGate, chooseRole, getRoleThreshold } from "./utils.js";
import { parseGeneratorOutputStrict, validateAgainstGenerationSchema, runDeterministicValidation } from "./prompts/GeneratorContract.mjs";
import { buildDynamicUserContext, withMessageIds } from "./prompts/DynamicContext.mjs";
import { buildStaticSharedTaskOverview, buildStaticUserContext } from "./prompts/StaticContext.mjs";
import { assessSemanticFactors } from "./SemanticAssessor.js";
import { checkEvidence } from "./EvidenceChecker.js";
import { compilePlan } from "./PolicyCompiler.js";
import {
  canConfirmBreak,
  MESSAGE_TYPES,
  allocateSequencePosition,
  buildCanonicalMessage,
  requestFeatureScores,
  reviewHumanMessageRequest,
} from "./ExperimentPolicies.mjs";

dotenv.config();

const openaiModel = process.env.OPENAI_MODEL || "gpt-4o";
const llmAPIEndpoint = process.env.LLM_API_ENDPOINT || "https://api.openai.com/v1/responses";
const llmMaxOutputTokens = Number.parseInt(process.env.LLM_MAX_OUTPUT_TOKENS ?? "1000", 10);

// ── LLM API call ──────────────────────────────────────────────────────────────

async function getLLMResponse(messages) {
  const data = {
    model: openaiModel,
    max_output_tokens: llmMaxOutputTokens,
    input: messages,
    text: { format: { type: "json_object" } },
  };
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
    const message = responseBody?.output?.find((item) => item.type === "message");
    const text = message?.content?.find((c) => c.type === "output_text")?.text;
    if (!text) {
      console.error("LLM response missing output text:", responseBody);
      return { success: false, error: "LLM response missing output text" };
    }
    // rawText is additive (existing "data" field/behavior for callers is
    // unchanged) -- it exists so the shared Generator path's strict parser
    // (server/src/prompts/GeneratorContract.mjs) can parse the untouched
    // response text itself, rather than trust this function's own
    // best-effort JSON.parse below.
    return { success: true, data: JSON.parse(text), rawText: text };
  } catch (error) {
    console.error("LLM endpoint error:", error);
    return { success: false, error: error.message };
  }
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

// ── Feature extraction (calls Python sidecar) ─────────────────────────────────
// Feature server failure → skip intervention, log error.
// Returning default values would silently change the detector behavior.
// Adaptive-only (the Controller boundary) -- unmodified by the scope-reduction
// refactor; feature extraction/thresholds/role-selection logic is out of scope.

async function extractFeatures(messages) {
  try {
    const data = await requestFeatureScores({
      fetchImpl: fetch,
      url: "http://localhost:5001/features",
      messages,
      redundancyThreshold: THRESHOLDS.expander.redundancy_threshold,
    });
    return { success: true, data };
  } catch (error) {
    console.error("[callbacks] Feature server unreachable:", error.message);
    return { success: false, error: error.message };
  }
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
function buildGeneratorContext(game, players, chat, remainingTime, timeElapsed, facilitation, role, plan = null) {
  const promptResult = llmSystemPrompts(facilitation, role);
  if (promptResult.blocked) {
    return { blocked: true, reason: promptResult.reason, metadata: promptResult.metadata };
  }

  const generalInfo = game.currentRound?.get("generalInfo") || "";
  if (facilitation === "static") {
    const sharedTaskOverview = buildStaticSharedTaskOverview({
      generalInfo,
      decisionOptions: game.currentRound?.get("decisionOptions") || [],
    });
    const staticContext = buildStaticUserContext({
      chat,
      remainingTimeMs: remainingTime,
      elapsedTimeMs: timeElapsed,
    });
    return {
      blocked: false,
      metadata: promptResult.metadata,
      systemPrompt: promptResult.content.replace("{{sharedTaskOverview}}", sharedTaskOverview),
      ...staticContext,
    };
  }

  const checkpointDescriptor = `Checkpoint after ${getHumanMessages(chat).length} human message(s) so far this round. Participants: ${players.map((p) => p.get("name")).join(", ")}. Time remaining: ${formatDuration(remainingTime)}, elapsed: ${formatDuration(timeElapsed)}.`;

  const dynamicContext = buildDynamicUserContext({
    chat: chat.filter(isFormalContextMessage),
    checkpointDescriptor,
    selectedRoleForDisplay: promptResult.metadata.generationRole,
    generalInfo,
    plan,
  });

  return {
    blocked: false,
    metadata: promptResult.metadata,
    systemPrompt: promptResult.content,
    userContent: dynamicContext.userContent,
    eligibleMessageIds: dynamicContext.eligibleMessageIds,
    aiOrSystemMessageIds: dynamicContext.aiOrSystemMessageIds,
    recentAiMessageTexts: dynamicContext.recentAiMessageTexts,
    allowedGroundingIds: dynamicContext.allowedGroundingIds,
  };
}

// ── Shared generation/validation/publication path (Static AND Adaptive) ────────
//
// The single post-selection path required by the scope-reduction refactor:
// one LLM call (getLLMResponse, GRAIL's existing client), one strict parse,
// one basic schema/role/length/grounding validator
// (server/src/prompts/GeneratorContract.mjs -- generation.schema.json +
// deterministic checks; no semantic Validator LLM, no regeneration/attempt
// loop), one publication call (postGeneratorResultIfValid, GRAIL's existing
// game.append/llmLog path). Invalid output at any stage is logged and
// treated as Silent -- nothing is ever published before every check passes,
// and there is no second attempt.
async function runSharedGeneration(game, chatKey, built, logEntry, originatingRoundId, originatingStageId) {
  logEntry.promptMetadata = built.metadata;

  if (built.blocked) {
    logEntry.reason = `AI request blocked: ${built.reason}`;
    logEntry.outcome = "SILENT";
    return { published: false };
  }

  const messages = [
    { role: "system", content: built.systemPrompt },
    { role: "user",   content: built.userContent  },
  ];
  logEntry.requestMade = true;
  logEntry.messagesOAIFormat = messages;

  const llmResponse = await getLLMResponse(messages);
  if (
    game.currentRound?.id !== originatingRoundId ||
    game.currentStage?.id !== originatingStageId ||
    game.currentStage?.get("name") !== "Task"
  ) {
    logEntry.reason = "Discarded stale AI result after the originating Discussion stage ended";
    logEntry.outcome = "SILENT";
    return { published: false };
  }
  if (!llmResponse.success) {
    logEntry.reason = `API Error: ${llmResponse.error}`;
    logEntry.outcome = "SILENT";
    return { published: false };
  }
  logEntry.requestSuccess = true;

  const parseResult = parseGeneratorOutputStrict(llmResponse.rawText);
  if (!parseResult.ok) {
    logEntry.reason = `Invalid Generator output: ${parseResult.error}`;
    logEntry.outcome = "SILENT";
    return { published: false };
  }

  const schemaResult = validateAgainstGenerationSchema(parseResult.parsed, built.metadata.generationRole);
  if (!schemaResult.ok) {
    logEntry.reason = "Generator output failed generation.schema.json";
    logEntry.schemaErrors = schemaResult.errors;
    logEntry.outcome = "SILENT";
    return { published: false };
  }

  const deterministicResult = runDeterministicValidation(parseResult.parsed, {
    selectedRole: built.metadata.generationRole,
    eligibleMessageIds: built.eligibleMessageIds,
    aiOrSystemMessageIds: built.aiOrSystemMessageIds,
    recentAiMessageTexts: built.recentAiMessageTexts,
    allowedGroundingIds: built.allowedGroundingIds,
  });
  logEntry.deterministic = deterministicResult;
  if (!deterministicResult.passed) {
    logEntry.reason = `Generator output failed validation: ${deterministicResult.failedCriteria.join(", ")}`;
    logEntry.outcome = "SILENT";
    return { published: false };
  }

  logEntry.llmAction = parseResult.parsed;
  const posted = postGeneratorResultIfValid(game, chatKey, parseResult.parsed, built.metadata.generationRole, logEntry);
  logEntry.outcome = posted ? "PUBLISHED" : "SILENT";
  return { published: posted, candidate: parseResult.parsed };
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

// ── Randomized-block S1-S4 allocation (one claim per Game) ─────────────────
//
// Every 4 Games get a shuffled permutation of {S1,S2,S3,S4} (a permuted
// block), guaranteeing each sequence appears exactly once per 4 Games,
// instead of two independent Math.random() < 0.5 coin flips (which cannot
// guarantee balance). A new block is generated only once the current one is
// fully claimed.
//
// STATE LIMIT (explicit, not glossed over): this is plain server-process
// module state, held only in memory. It is NOT persisted to Tajriba, a
// database, or disk. If the Empirica server process restarts while a block
// is partially claimed, that block's remaining positions are lost -- the
// next claim after restart starts a brand-new block from position 1. This
// does not survive a server restart, and must not be described as if it
// did.
let currentSequenceBlock = [];
let allocationBlockId = 0;
let nextAllocationPosition = 0; // number of items already claimed from currentSequenceBlock (0-4)

// Synchronous, no `await` anywhere in this function. Node.js's single-
// threaded event loop already runs this function to completion before any
// other code (including another call to this same function) can run, so
// two Games' onGameStart callbacks can never interleave mid-claim within
// one process. No additional lock is added for this reason.
function claimNextSequence() {
  if (nextAllocationPosition >= currentSequenceBlock.length) {
    currentSequenceBlock = _.shuffle(SEQUENCE_IDS);
    allocationBlockId += 1;
    nextAllocationPosition = 0;
  }
  const sequenceId = currentSequenceBlock[nextAllocationPosition];
  nextAllocationPosition += 1;
  return {
    sequenceId,
    allocationBlockId,
    allocationPosition: nextAllocationPosition, // 1-4
  };
}

// ── onGameStart ───────────────────────────────────────────────────────────────

Empirica.onGameStart(({ game }) => {
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
  game.set("llmLog",              []);
  game.set("totalInterventions",  0);
  game.set("systemInfo", {
    model:           openaiModel,
    featureServer:   "http://localhost:5001",
    thresholdSource: "hardcoded_placeholder",
    thresholds:      THRESHOLDS,
  });

  // ── Randomized-block S1-S4 allocation ──────────────────────────────────────
  // Idempotency: reuse an already-claimed sequence verbatim (never claim a
  // second slot from the block for the same Game -- e.g. if onGameStart were
  // ever re-invoked for this Game).
  let sequenceId = game.get("sequenceId");
  if (!sequenceId) {
    const claim = claimNextSequence();
    sequenceId = claim.sequenceId;
    game.set("sequenceId",           claim.sequenceId);
    game.set("allocationBlockId",    claim.allocationBlockId);
    game.set("allocationPosition",   claim.allocationPosition);
    game.set("allocationBlockOrder", [...currentSequenceBlock]); // audit trail: the full permutation this Game's slot came from
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
  round1.addStage({ name: "FinalDecision",            duration: 120 });
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
  round2.addStage({ name: "FinalDecision",            duration: 120 });
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
    });
  }
});

// ── onRoundStart ──────────────────────────────────────────────────────────────

Empirica.onRoundStart(({ round }) => {
  const game = round.currentGame;
  const taskIndex = round.get("taskIndex");
  const taskVersion = round.get("taskVersion");
  const matchingTasks = taskConfig.tasks.filter((candidate) => candidate.taskVersion === taskVersion);
  const task = matchingTasks.length === 1 ? matchingTasks[0] : null;

  if (!task) {
    console.error(`[onRoundStart] No task found for taskVersion ${JSON.stringify(taskVersion)} (exposure taskIndex ${taskIndex})`);
    return;
  }

  // Reset per-round counters
  game.set("messagesSinceLastIntervention", 0);
  game.set("lastRole",                      null);
  game.set("synthesiserFired",              false);
  game.set("humanMessageCount",             0);

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

function appendCanonicalMessage(game, attribute, fields) {
  const counters = { ...(game.get("messageSequenceCounters") || {}) };
  const sequencePosition = allocateSequencePosition(counters, attribute);
  game.set("messageSequenceCounters", counters);
  const message = buildCanonicalMessage({ ...fields, sequencePosition });
  game.append(attribute, message);
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

Empirica.onStageStart(({ stage }) => {
  const game = stage.currentGame;
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
    if (durationMs > 30_000) setTimeout(() => appendTimedMessage(stage, introChatKey, "Thirty seconds remain in the IceBreaker."), durationMs - 30_000);
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

  const allReady = assignedHumanPlayers(game).length > 0
    && assignedHumanPlayers(game).every((participant) => Boolean(participant.stage?.get("submit")));
  const deadline = game.get("deadline");
  const deadlineReached = Number.isFinite(deadline) && Date.now() >= deadline;
  if (!allReady && !deadlineReached) return;

  // Server-authoritative recovery path for the same two conditions that end
  // the native Step. Setting Stage.ended also lets Classic advance correctly
  // if its in-memory Step-to-Stage map was lost during a development reload.
  stage.set("ended", true);
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

// ── on("game", "chat_round_N") ────────────────────────────────────────────────

// GRAIL's single, shared chat-publication path (Static AND Adaptive) --
// final defensive check plus the actual game.append/totalInterventions
// write. By the time this is called from runSharedGeneration, the full
// basic schema/role/length/grounding validation has already passed, so
// these checks are trivially satisfied; they remain as a cheap final
// guard. Returns true if a message was posted. (There is no semantic
// Validator LLM in the live path -- see server/src/prompts/validatorPlaceholder.js's
// header comment for why, and validation.schema.json's own status as an
// offline/pilot evaluation artifact only.)
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
  appendCanonicalMessage(game, chatKey, {
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
  game.set("totalInterventions", (game.get("totalInterventions") || 0) + 1);
  return true;
}

async function handleChat(env, { game }) {
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
  if (!facilitation) return;

  const players = game.players;
  const chat = game.get(chatKey) || [];
  if (!chat.length) return;

  const lastMessage = chat[chat.length - 1];
  if (!isFormalHumanMessage(lastMessage)) return;

  const currentStageName = game.currentStage?.get("name");
  if (currentStageName !== "Task") return;
  const originatingRoundId = currentRound.id;
  const originatingStageId = game.currentStage.id;

  const humanMessageCount = (game.get("humanMessageCount") || 0) + 1;
  game.set("humanMessageCount", humanMessageCount);

  let messagesSince = (game.get("messagesSinceLastIntervention") || 0) + 1;
  game.set("messagesSinceLastIntervention", messagesSince);

  if (messagesSince < 6) return;

  // Minimal per-Round checkpoint marker (Part C: checkpoint protection).
  // Not a new concurrency/publication subsystem -- one field read plus one
  // write, checked before any LLM work begins, guarding only against this
  // exact checkpoint (same humanMessageCount, this Round) being handled a
  // second time. Reset immediately below (before the outcome is even
  // known), so a failed/blocked/Silent request consumes the checkpoint
  // exactly like a published one.
  if (currentRound.get("lastHandledCheckpoint") === humanMessageCount) return;
  currentRound.set("lastHandledCheckpoint", humanMessageCount);
  game.set("messagesSinceLastIntervention", 0);

  const now = new Date().getTime();
  const remainingTime = Math.max(0, game.get("deadline") - now);
  const timeElapsed   = now - game.get("taskStartTime");

  let logEntry = {
    timestamp:                     now,
    roundIndex,
    facilitation,
    humanMessageCount,
    messagesSinceLastIntervention: messagesSince,
    remainingTime,
    timeElapsed,
    requestMade:    false,
    requestSuccess: false,
    messageAdded:   false,
    outcome:        "SILENT",
    model:          openaiModel,
    reason:         "",
  };

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
    await runSharedGeneration(
      game,
      chatKey,
      built,
      logEntry,
      originatingRoundId,
      originatingStageId,
    );
    game.set("llmLog", [...(game.get("llmLog") || []), logEntry]);
    Empirica.flush();
    return;
  }

  // Fail closed on an unexpected Round condition without sending it through
  // either policy. The real S1-S4 table assigns only static/adaptive.
  if (facilitation !== "adaptive") {
    logEntry.reason = `Unrecognized facilitation condition: ${JSON.stringify(facilitation)}`;
    game.set("llmLog", [...(game.get("llmLog") || []), logEntry]);
    Empirica.flush();
    return;
  }

  // ── Adaptive-only Steps 1-3: discussion feature extraction ───────────
  const localMessages = buildLocalContext(getHumanMessages(chat), 6);
  const featureStart  = Date.now();
  const featureResult = await extractFeatures(localMessages);
  if (
    game.currentRound?.id !== originatingRoundId ||
    game.currentStage?.id !== originatingStageId ||
    game.currentStage?.get("name") !== "Task"
  ) {
    logEntry.reason = "Discarded stale feature result after the originating Discussion stage ended";
    game.set("llmLog", [...(game.get("llmLog") || []), logEntry]);
    Empirica.flush();
    return;
  }
  logEntry.featureLatency = Date.now() - featureStart;

  if (!featureResult.success) {
    logEntry.reason = `Feature server unavailable: ${featureResult.error} — Adaptive intervention skipped`;
    game.set("llmLog", [...(game.get("llmLog") || []), logEntry]);
    Empirica.flush();
    return;
  }

  const features = featureResult.data;
  logEntry.featureScores = features;

  // Step 4: Candidate Gate -- Adaptive-only, deterministic, no LLM call. An empty
  // result resolves straight to Abstain below without ever calling the
  // Semantic Assessor (Brief Step 4: "如果候选角色为空 -> Abstain，不调用LLM").
  const candidateRoles = getCandidateRoles(features);
  logEntry.candidateRoles = candidateRoles;

  // Steps 5-6: Semantic Assessor LLM + Evidence Checker. Only run for
  // Adaptive and only when the Candidate Gate found something worth
  // investigating.
  let checkedFactors = null;
  if (candidateRoles.length > 0) {
    const assessorStart = Date.now();
    const generalInfoForAssessor = game.currentRound?.get("generalInfo") || "";
    const formalChat = chat.filter(isFormalContextMessage);
    const assessorResult = await assessSemanticFactors({
      chat: formalChat,
      candidateRoles,
      taskGeneralContext: generalInfoForAssessor,
      callLLM: getLLMResponse,
    });
    if (
      game.currentRound?.id !== originatingRoundId ||
      game.currentStage?.id !== originatingStageId ||
      game.currentStage?.get("name") !== "Task"
    ) {
      logEntry.reason = "Discarded stale Semantic Assessor result after the originating Discussion stage ended";
      game.set("llmLog", [...(game.get("llmLog") || []), logEntry]);
      Empirica.flush();
      return;
    }
    logEntry.assessorLatency = Date.now() - assessorStart;

    if (assessorResult.success) {
      logEntry.rawFactors = assessorResult.factors;
      checkedFactors = checkEvidence(assessorResult.factors, { chat: formalChat, features });
      logEntry.checkedFactors = checkedFactors;
    } else {
      // Assessor unavailable/invalid this checkpoint: checkedFactors stays
      // null (never fabricated). evaluateGate() below correctly finds no
      // role can clear its hard gate without checked factors.
      logEntry.assessorError = `${assessorResult.code}: ${assessorResult.error}`;
    }
  }

  // Step 7: Adaptive intervention-permission gate. ABSTAIN returns before
  // any Generator prompt is built or any Generator request is made.
  const lastRole                = game.get("lastRole");
  const previousCheckedFactors  = game.get("lastCheckedFactors") || null;
  const gateResult = evaluateGate(features, checkedFactors, candidateRoles, {
    remainingTime,
    previousCheckedFactors,
    lastRole,
  });

  logEntry.gateDecision  = gateResult.act ? "ACT" : "ABSTAIN";
  logEntry.gateReason    = gateResult.reason;
  logEntry.eligibleRoles = gateResult.eligibleRoles;
  logEntry.stateScores   = gateResult.scores;

  // Persist this checkpoint's checked factors for the next checkpoint's
  // persistence term (utils.js's computePersistence -- currently weighted
  // at 0 via THRESHOLDS.weights.persistence, but wired end-to-end so a
  // future calibration pass doesn't also need to add this storage step).
  if (checkedFactors) {
    game.set("lastCheckedFactors", checkedFactors);
  }

  if (!gateResult.act) {
    logEntry.reason = gateResult.reason;
    game.set("llmLog", [...(game.get("llmLog") || []), logEntry]);
    Empirica.flush();
    return;
  }

  // Adaptive-only role selection and plan compilation. The Generator receives
  // the already-selected E/C/S identity and has no WAIT/INTERVENE decision.
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

  // ── Shared: build context, call the Generator LLM once, validate,
  // publish once, log ──────────────────────────────────────────────────
  const built  = buildGeneratorContext(game, players, chat, remainingTime, timeElapsed, "adaptive", chosenRole.role, plan);
  const result = await runSharedGeneration(
    game,
    chatKey,
    built,
    logEntry,
    originatingRoundId,
    originatingStageId
  );

  if (result.published) {
    // Controller cooldown bookkeeping is updated only after an Adaptive
    // specialist message is actually published.
    game.set("lastRole", chosenRole.role);
    if (chosenRole.role === "synthesiser" && chosenRole.forced) {
      game.set("synthesiserFired", true);
    }
  }

  game.set("llmLog", [...(game.get("llmLog") || []), logEntry]);
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
    for (const player of assignedHumanPlayers(game)) {
      if (!player.round.get("groupFinalSubmittedAt")) player.round.set("groupFinalTimeoutReason", "stage_timeout");
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

});

Empirica.onRoundEnded(({ round }) => {
  const game = round.currentGame;
  console.log(`[Round ${round.get("index")} ended] facilitation: ${round.get("facilitation")}, total interventions so far: ${game.get("totalInterventions")}`);
});

Empirica.onGameEnded(({ game }) => {
  console.log(`[Game ended] Total interventions: ${game.get("totalInterventions")}`);
  console.log(`[Game ended] Total human messages: ${game.get("humanMessageCount")}`);
  console.log(`[Game ended] sequenceId: ${game.get("sequenceId")}, allocationBlockId: ${game.get("allocationBlockId")}, allocationPosition: ${game.get("allocationPosition")}`);
});
