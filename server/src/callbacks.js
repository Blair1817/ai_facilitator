import { ClassicListenersCollector } from "@empirica/core/admin/classic";
export const Empirica = new ClassicListenersCollector();
import _ from "lodash";
import dotenv from "dotenv";
import taskConfig from "./HPTConfig.json";
import { llmSystemPrompts } from "./LLMConfig.js";
import { THRESHOLDS, getCandidateRoles, evaluateGate, chooseRole, getRoleThreshold } from "./utils.js";
import { parseGeneratorOutputStrict, validateAgainstGenerationSchema, runDeterministicValidation } from "./prompts/GeneratorContract.mjs";
import { buildDynamicUserContext, withMessageIds } from "./prompts/DynamicContext.mjs";
import { assessSemanticFactors } from "./SemanticAssessor.js";
import { checkEvidence } from "./EvidenceChecker.js";
import { compilePlan } from "./PolicyCompiler.js";

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
    // unchanged) -- it exists so the Adaptive path's strict parser
    // (server/src/prompts/GeneratorContract.mjs) can parse the untouched
    // response text itself, rather than trust this function's own
    // best-effort JSON.parse below (which the Static path still relies on
    // unchanged).
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

function getHumanMessages(chat) {
  if (!chat) return [];
  return chat.filter((m) => m.sender.id !== "ai");
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
  const payload = {
    messages: messages.map((m) => ({ sender: m.sender.name, text: m.text })),
    redundancy_threshold: THRESHOLDS.expander.redundancy_threshold
  };
  try {
    const featureResponse = await fetch("http://localhost:5001/features", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload)
    });
    const data = await featureResponse.json();
    if (!featureResponse.ok) {
      console.error("[callbacks] Feature server error:", data);
      return { success: false, error: data.error || "Feature server returned error" };
    }
    return { success: true, data };
  } catch (error) {
    console.error("[callbacks] Feature server unreachable:", error.message);
    return { success: false, error: error.message };
  }
}

// ── Shared Generator context builder (Static AND Adaptive) ─────────────────────
//
// GRAIL scope-reduction refactor: this is now the ONE context builder both
// facilitation conditions use. The only condition-specific step happens
// BEFORE this function is called (selecting "static"+null vs
// "adaptive"+<controller role> below in handleChat) -- everything after
// prompt selection (context assembly, LLM call, parsing, validation,
// publication, logging) is identical for both conditions.
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
  const checkpointDescriptor = `Checkpoint after ${getHumanMessages(chat).length} human message(s) so far this round. Participants: ${players.map((p) => p.get("name")).join(", ")}. Time remaining: ${formatDuration(remainingTime)}, elapsed: ${formatDuration(timeElapsed)}.`;

  const dynamicContext = buildDynamicUserContext({
    chat,
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
const TASK_CONFIG_INDEX_BY_VERSION = Object.freeze({ A: 0, B: 1 });

// Empirica requires every Stage to have a positive duration. ReviewQuiz has
// no research-defined timeout and normally ends only when every participant
// submits a fully correct attempt; this is an operational safety ceiling, not
// a participant-facing experimental duration.
const REVIEW_QUIZ_SAFETY_DURATION_SECONDS = 24 * 60 * 60;
const TRANSITION_TO_ICEBREAKER_DURATION_SECONDS = 10;
const TASK_INFORMATION_DURATION_SECONDS = 10 * 60;
const WALKTHROUGH_DURATION_SECONDS = 10 * 60;
const TLX_DURATION_SECONDS = 10 * 60;
const SUBJECTIVE_SURVEY_DURATION_SECONDS = 10 * 60;
const BREAK_DURATION_SECONDS = 300;

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
  round1.addStage({ name: "TransitionToIceBreaker",   duration: TRANSITION_TO_ICEBREAKER_DURATION_SECONDS });
  round1.addStage({ name: "Introduction",             duration: introDuration * 60 });
  round1.addStage({ name: "InitialDecision",          duration: phase1Duration * 60 });
  round1.addStage({ name: "Task",                     duration: gameDuration * 60 });
  round1.addStage({ name: "FinalDecision",            duration: 120 });
  round1.addStage({ name: "TLX",                      duration: TLX_DURATION_SECONDS });
  round1.addStage({ name: "SubjectiveSurvey",         duration: SUBJECTIVE_SURVEY_DURATION_SECONDS });
  round1.addStage({ name: "Break",                    duration: BREAK_DURATION_SECONDS });

  const round2 = game.addRound({
    name: "Round 2",
    facilitation: sequence.facilitationOrder[1],
    taskIndex:    1,
    taskVersion:  sequence.taskVersionOrder[1],
  });
  round2.addStage({ name: "TaskInformation",          duration: TASK_INFORMATION_DURATION_SECONDS });
  round2.addStage({ name: "Walkthrough",              duration: WALKTHROUGH_DURATION_SECONDS });
  addReviewQuizStage(round2);
  round2.addStage({ name: "TransitionToIceBreaker",   duration: TRANSITION_TO_ICEBREAKER_DURATION_SECONDS });
  round2.addStage({ name: "Introduction",             duration: introDuration * 60 });
  round2.addStage({ name: "InitialDecision",          duration: phase1Duration * 60 });
  round2.addStage({ name: "Task",                     duration: gameDuration * 60 });
  round2.addStage({ name: "FinalDecision",            duration: 120 });
  round2.addStage({ name: "TLX",                      duration: TLX_DURATION_SECONDS });
  round2.addStage({ name: "SubjectiveSurvey",         duration: SUBJECTIVE_SURVEY_DURATION_SECONDS });

  // MIGRATED from old 2nd (TEMP-BE-007 there): stable, game-level color-
  // alias assignment. Without this, name/hexCode get reshuffled every round
  // (see onRoundStart below, which used to do this itself) -- a participant's
  // Red/Pink/Green alias was not guaranteed to stay the same across Round 1
  // and Round 2. Alias (name) and hexCode are identical across Task A and
  // Task B at the same playerConfig index (verified against the real
  // HPTConfig.json: Red/FF0000, Pink/F90494, Green/39BC21 in both tasks), so
  // Task A's playerConfig is used purely as the source of alias/hexCode
  // ordering, not as a content preference. profileSlot is the durable
  // player.id -> slot mapping; onRoundStart uses it to fetch each round's
  // task-specific private content only, without ever touching name/hexCode
  // again. profileSlot intentionally doubles as both the "alias slot" and
  // the "information role slot" -- HPTConfig.json has no separate concept of
  // an information role that could diverge from playerConfig array position,
  // so there is nothing to decouple today. If a future task design needs a
  // participant's information role to change independently of their visible
  // color across rounds, this would need to become two separate fields.
  const aliasSource = taskConfig["tasks"][0]["playerConfig"];
  if (game.players.length > aliasSource.length) {
    console.error(`[onGameStart] Not enough alias slots: need ${game.players.length}, have ${aliasSource.length}`);
  } else {
    const shuffledSlots = _.shuffle(aliasSource.map((_entry, i) => i));
    game.players.forEach((player, i) => {
      const slot = shuffledSlots[i];
      player.set("name",        aliasSource[slot].playerName);
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
  const taskConfigIndex = TASK_CONFIG_INDEX_BY_VERSION[taskVersion];
  const task = taskConfig["tasks"][taskConfigIndex];

  if (taskConfigIndex === undefined || !task) {
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

  // MIGRATED from old 2nd (TEMP-BE-007 there): use the stable profileSlot
  // assigned once in onGameStart -- do NOT reshuffle or reassign name/hexCode
  // here (that was the regression this migration removes). Only this round's
  // task-specific private content is looked up here, keyed by the player's
  // fixed slot, and saved round-scoped (player.round.set, not flat
  // player.set) so Round 1 and Round 2 content can never overwrite each
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
  });
});

// ── onStageStart ──────────────────────────────────────────────────────────────

Empirica.onStageStart(({ stage }) => {
  const game = stage.currentGame;
  const { gameDuration } = game.get("treatment");
  if (stage.get("name") === "Task") {
    // gameDuration is a required treatment factor (.empirica/treatments.yaml)
    // -- fail clearly rather than silently substituting a default if it is
    // ever missing/invalid.
    if (!Number.isFinite(gameDuration) || gameDuration <= 0) {
      throw new Error(`[onStageStart] game ${game.id}'s treatment has an invalid/missing gameDuration (${JSON.stringify(gameDuration)}). Check .empirica/treatments.yaml.`);
    }
    const now = new Date().getTime();
    game.set("taskStartTime", now);
    game.set("deadline",      now + gameDuration * 60 * 1000);
  }
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
  game.append(chatKey, {
    text:   llmAction.message,
    ts:     new Date().getTime(),
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
  if (lastMessage.sender.id === "ai") return;

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

  // ── Shared Steps 1-3: feature extraction now runs for BOTH conditions.
  // Before 2026-08-07 this whole block was inside `if (facilitation ===
  // "adaptive")` -- Static had NO feature-based gate at all and fired
  // unconditionally whenever static.md's content was ready, while only
  // Adaptive could Abstain on low scores. That directly violated Methods
  // 3.2.2 / the architecture doc's single shared Act/Abstain gate. See
  // server/src/prompts/PROMPT_MODULE_STATUS.md's addendum for the full
  // decision record. ───────────────────────────────────────────────────
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
    logEntry.reason = `Feature server unavailable: ${featureResult.error} — skipping intervention (both conditions share this gate)`;
    game.set("llmLog", [...(game.get("llmLog") || []), logEntry]);
    Empirica.flush();
    return;
  }

  const features = featureResult.data;
  logEntry.featureScores = features;

  // Step 4: Candidate Gate -- shared, deterministic, no LLM call. An empty
  // result resolves straight to Abstain below without ever calling the
  // Semantic Assessor (Brief Step 4: "如果候选角色为空 -> Abstain，不调用LLM").
  const candidateRoles = getCandidateRoles(features);
  logEntry.candidateRoles = candidateRoles;

  // Steps 5-6: Semantic Assessor LLM + Evidence Checker. Only run when the
  // Candidate Gate found something worth investigating. This is the ONE
  // semantic-layer LLM call per checkpoint, made identically regardless of
  // `facilitation` -- Static is bound by its outcome exactly like
  // Adaptive, even though Static ignores which role it points to.
  let checkedFactors = null;
  if (candidateRoles.length > 0) {
    const assessorStart = Date.now();
    const generalInfoForAssessor = game.currentRound?.get("generalInfo") || "";
    const assessorResult = await assessSemanticFactors({
      chat,
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
      checkedFactors = checkEvidence(assessorResult.factors, { chat, features });
      logEntry.checkedFactors = checkedFactors;
    } else {
      // Assessor unavailable/invalid this checkpoint: checkedFactors stays
      // null (never fabricated). evaluateGate() below correctly finds no
      // role can clear its hard gate without checked factors -- for both
      // conditions equally, not just Adaptive.
      logEntry.assessorError = `${assessorResult.code}: ${assessorResult.error}`;
    }
  }

  // Step 7: THE shared Act/Abstain gate. Same call, same inputs, for
  // Static and Adaptive -- this is what actually closes the missing-
  // shared-gate gap.
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
    return; // Abstain applies identically to Static and Adaptive here.
  }

  // ── Condition-specific step: now that the shared gate has said Act,
  // decide the prompt/plan. This is the ONLY remaining difference between
  // Static and Adaptive -- everything after this point (context building,
  // the Generator LLM call, parsing, validation, publication, logging) is
  // the single shared path both conditions use. ─────────────────────────
  let role       = null;  // Static always uses the fixed STATIC prompt, no role.
  let plan       = null;  // Static never gets a PolicyCompiler plan.
  let chosenRole = null;  // Adaptive-only bookkeeping, used after publication below.

  if (facilitation === "adaptive") {
    const synthesiserFired = game.get("synthesiserFired");
    chosenRole = chooseRole(gateResult, { remainingTime, lastRole, synthesiserFired });

    logEntry.selectedRole = chosenRole.role;
    logEntry.forced       = chosenRole.forced;
    logEntry.reasoning    = chosenRole.reasoning;

    const chatWithIds        = withMessageIds(chat);
    const eligibleMessageIds = chatWithIds.filter((m) => m.sender.id !== "ai").map((m) => m.messageId);
    plan = compilePlan(chosenRole.role, checkedFactors, {
      score:     gateResult.scores[chosenRole.role],
      threshold: getRoleThreshold(chosenRole.role),
      eligibleMessageIds,
    });
    logEntry.plan = plan;

    role = chosenRole.role;
  }

  // ── Shared: build context, call the Generator LLM once, validate,
  // publish once, log ──────────────────────────────────────────────────
  const built  = buildGeneratorContext(game, players, chat, remainingTime, timeElapsed, facilitation, role, plan);
  const result = await runSharedGeneration(
    game,
    chatKey,
    built,
    logEntry,
    originatingRoundId,
    originatingStageId
  );

  if (result.published && facilitation === "adaptive") {
    // Adaptive-only Controller cooldown bookkeeping -- not part of the
    // shared publication path itself, just updates state the Controller
    // reads on its next turn.
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

Empirica.onStageEnded(({ stage }) => {});

Empirica.onRoundEnded(({ round }) => {
  const game = round.currentGame;
  console.log(`[Round ${round.get("index")} ended] facilitation: ${round.get("facilitation")}, total interventions so far: ${game.get("totalInterventions")}`);
});

Empirica.onGameEnded(({ game }) => {
  console.log(`[Game ended] Total interventions: ${game.get("totalInterventions")}`);
  console.log(`[Game ended] Total human messages: ${game.get("humanMessageCount")}`);
  console.log(`[Game ended] sequenceId: ${game.get("sequenceId")}, allocationBlockId: ${game.get("allocationBlockId")}, allocationPosition: ${game.get("allocationPosition")}`);
});
