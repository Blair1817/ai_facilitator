import { ClassicListenersCollector } from "@empirica/core/admin/classic";
export const Empirica = new ClassicListenersCollector();
import _ from "lodash";
import dotenv from "dotenv";
import taskConfig from "./HPTConfig.json";
import { llmSystemPrompts } from "./LLMConfig.js";
import { THRESHOLDS, selectRole } from "./utils.js";

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
    return { success: true, data: JSON.parse(text) };
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

function formatMessages(messages) {
  return messages.map((m) => `[${m.sender.name}]: ${m.text}`).join("\n");
}

// ── Feature extraction (calls Python sidecar) ─────────────────────────────────
// Feature server failure → skip intervention, log error.
// Returning default values would silently change the detector behavior.

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

// ── Build LLM messages ────────────────────────────────────────────────────────

function buildLLMMessages(game, players, facilitation, localMessages, allHumanMessages, stateResult, remainingTime, timeElapsed) {
  const systemPrompt = llmSystemPrompts(facilitation, stateResult?.role || null);
  const cumulativeContext = formatMessages(allHumanMessages);
  const localContext = formatMessages(localMessages);
  const userContent = [
    `[TIME REMAINING: ${formatDuration(remainingTime)}]`,
    `[TIME ELAPSED: ${formatDuration(timeElapsed)}]`,
    `[PARTICIPANTS: ${players.map((p) => p.get("name")).join(", ")}]`,
    ``,
    `[Full discussion so far]`,
    cumulativeContext,
    ``,
    `[Last 6 human messages]`,
    localContext,
  ].join("\n");
  const adaptiveContext = facilitation === "adaptive" && stateResult
    ? `\n[Detected state: ${stateResult.role}]${stateResult.scores ? `\n[Feature scores: ${JSON.stringify(stateResult.scores)}]` : ""}`
    : "";
  return [
    { content: systemPrompt,                  role: "system" },
    { content: userContent + adaptiveContext,  role: "user"   },
  ];
}

// ── onGameStart ───────────────────────────────────────────────────────────────

Empirica.onGameStart(({ game }) => {
  const { gameDuration, phase1Duration, introDuration } = game.get("treatment");
  // facilitation is no longer read from treatment.
  // It is assigned per-round below and read from round.get("facilitation") at runtime.

  // Initialize game-level state
  game.set("llmLog",              []);
  game.set("totalInterventions",  0);
  game.set("chat_round_0",        []);
  game.set("chat_round_1",        []);
  game.set("systemInfo", {
    model:           openaiModel,
    featureServer:   "http://localhost:5001",
    thresholdSource: "hardcoded_placeholder",
    thresholds:      THRESHOLDS,
  });

  // Randomly assign facilitation order across the two rounds
  const facilitationOrder = Math.random() < 0.5
    ? ["static", "adaptive"]
    : ["adaptive", "static"];
  game.set("facilitationOrder", facilitationOrder);

  // Round 1
  const round1 = game.addRound({ name: "Round 1" });
  round1.set("facilitation", facilitationOrder[0]);
  round1.set("taskIndex",    0);
  round1.addStage({ name: "transitionToIntroduction", duration: 10 });
  round1.addStage({ name: "Introduction",             duration: (introDuration  || 2) * 60 });
  round1.addStage({ name: "transitionToTask",         duration: 10 });
  round1.addStage({ name: "InitialDecision",          duration: (phase1Duration || 3) * 60 });
  round1.addStage({ name: "Task",                     duration: (gameDuration   || 10) * 60 });
  round1.addStage({ name: "FinalDecision",            duration: 120 });

  // Round 2
  const round2 = game.addRound({ name: "Round 2" });
  round2.set("facilitation", facilitationOrder[1]);
  round2.set("taskIndex",    1);
  round2.addStage({ name: "transitionToIntroduction", duration: 10 });
  round2.addStage({ name: "Introduction",             duration: (introDuration  || 2) * 60 });
  round2.addStage({ name: "transitionToTask",         duration: 10 });
  round2.addStage({ name: "InitialDecision",          duration: (phase1Duration || 3) * 60 });
  round2.addStage({ name: "Task",                     duration: (gameDuration   || 10) * 60 });
  round2.addStage({ name: "FinalDecision",            duration: 120 });
});

// ── onRoundStart ──────────────────────────────────────────────────────────────

Empirica.onRoundStart(({ round }) => {
  const game = round.currentGame;
  const taskIndex = round.get("taskIndex");
  const task = taskConfig["tasks"][taskIndex];

  if (!task) {
    console.error(`[onRoundStart] No task found for taskIndex ${taskIndex}`);
    return;
  }

  // Reset per-round counters
  game.set("messagesSinceLastIntervention", 0);
  game.set("lastRole",                      null);
  game.set("synthesiserFired",              false);
  game.set("humanMessageCount",             0);

  // Set task content for this round
  game.set("generalInfo", task["generalInfo"]);

  // Assign player profiles for this round's task
  const shuffledConfig = _.shuffle(task["playerConfig"]);

  if (game.players.length > shuffledConfig.length) {
    console.error(`[onRoundStart] Not enough player configs for taskIndex ${taskIndex}: need ${game.players.length}, have ${shuffledConfig.length}`);
    return;
  }

  game.players.forEach((player, i) => {
    player.set("name",          shuffledConfig[i].playerName);
    player.set("playerContent", shuffledConfig[i].playerContent);
    player.set("hexCode",       shuffledConfig[i].hexCode);
  });
});

// ── onStageStart ──────────────────────────────────────────────────────────────

Empirica.onStageStart(({ stage }) => {
  const game = stage.currentGame;
  const { gameDuration } = game.get("treatment");
  if (stage.get("name") === "Task") {
    const now = new Date().getTime();
    game.set("taskStartTime", now);
    game.set("deadline",      now + (gameDuration || 10) * 60 * 1000);
  }
});

// ── on("game", "chat_round_N") ────────────────────────────────────────────────

async function handleChat(env, { game }) {
  const currentRound = game.currentRound;
  const roundIndex   = currentRound?.get("index");
  const chatKey      = `chat_round_${roundIndex}`;

  // Guard: make sure the chatKey matches what triggered this listener
  if (roundIndex === null || roundIndex === undefined) return;
  if (!game.get(chatKey)) return;

  const facilitation = currentRound?.get("facilitation");
  if (!facilitation) return;

  const players = game.players;
  const chat = game.get(chatKey) || [];
  if (!chat.length) return;

  const lastMessage = chat[chat.length - 1];
  if (lastMessage.sender.id === "ai") return;

  const currentStageName = game.currentStage?.get("name");
  if (currentStageName !== "Task") return;

  const humanMessageCount = (game.get("humanMessageCount") || 0) + 1;
  game.set("humanMessageCount", humanMessageCount);

  let messagesSince = (game.get("messagesSinceLastIntervention") || 0) + 1;
  game.set("messagesSinceLastIntervention", messagesSince);

  if (messagesSince < 6) return;

  const now = new Date().getTime();
  const remainingTime = Math.max(0, game.get("deadline") - now);
  const timeElapsed   = now - game.get("taskStartTime");
  const allHumanMessages = getHumanMessages(chat);
  const localMessages    = buildLocalContext(allHumanMessages, 6);

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
    model:          openaiModel,
    reason:         "",
  };

  // ── Static ──────────────────────────────────────────────────────────────────
  if (facilitation === "static") {
    logEntry.requestMade = true;
    const messages = buildLLMMessages(game, players, "static", localMessages, allHumanMessages, null, remainingTime, timeElapsed);
    logEntry.messagesOAIFormat = messages;
    const llmResponse = await getLLMResponse(messages);
    if (llmResponse.success) {
      const llmAction = llmResponse.data;
      logEntry.requestSuccess = true;
      logEntry.llmAction = llmAction;
      if (llmAction.DECISION === "INTERVENE") {
        game.append(chatKey, {
          text:   llmAction.MESSAGE,
          ts:     new Date().getTime(),
          sender: { id: "ai", name: "Facilitator", avatar: `https://api.dicebear.com/9.x/initials/svg?backgroundColor=000000&seed=F` },
        });
        logEntry.messageAdded = true;
        game.set("totalInterventions", (game.get("totalInterventions") || 0) + 1);
      } else {
        logEntry.reason = "LLM decided not to intervene";
      }
    } else {
      logEntry.reason = `API Error: ${llmResponse.error}`;
    }
    game.set("messagesSinceLastIntervention", 0);
  }

  // ── Adaptive ────────────────────────────────────────────────────────────────
  else if (facilitation === "adaptive") {
    const featureStart  = Date.now();
    const featureResult = await extractFeatures(localMessages);
    logEntry.featureLatency = Date.now() - featureStart;

    if (!featureResult.success) {
      logEntry.reason = `Feature server unavailable: ${featureResult.error} — skipping intervention`;
      game.set("messagesSinceLastIntervention", 0);
      game.set("llmLog", [...(game.get("llmLog") || []), logEntry]);
      Empirica.flush();
      return;
    }

    const features         = featureResult.data;
    const lastRole         = game.get("lastRole");
    const synthesiserFired = game.get("synthesiserFired");
    const stateResult      = selectRole(features, remainingTime, lastRole, synthesiserFired);

    logEntry.featureScores = features;
    logEntry.eligibleRoles = stateResult.eligibleRoles;
    logEntry.selectedRole  = stateResult.role;
    logEntry.stateScores   = stateResult.scores;
    logEntry.forced        = stateResult.forced;
    logEntry.reasoning     = stateResult.reasoning;

    if (stateResult.role !== "silent") {
      logEntry.requestMade = true;
      const messages = buildLLMMessages(game, players, "adaptive", localMessages, allHumanMessages, stateResult, remainingTime, timeElapsed);
      logEntry.messagesOAIFormat = messages;
      const llmStart    = Date.now();
      const llmResponse = await getLLMResponse(messages);
      logEntry.apiLatency = Date.now() - llmStart;

      if (llmResponse.success) {
        const llmAction = llmResponse.data;
        logEntry.requestSuccess = true;
        logEntry.llmAction = llmAction;

        if (stateResult.role === "synthesiser" && stateResult.forced) {
          game.set("synthesiserFired", true);
        }

        if (llmAction.DECISION === "INTERVENE") {
          game.append(chatKey, {
            text:   llmAction.MESSAGE,
            ts:     new Date().getTime(),
            sender: { id: "ai", name: "Facilitator", avatar: `https://api.dicebear.com/9.x/initials/svg?backgroundColor=000000&seed=F` },
          });
          logEntry.messageAdded = true;
          game.set("totalInterventions", (game.get("totalInterventions") || 0) + 1);
          game.set("lastRole",           stateResult.role);
        } else {
          logEntry.reason = "LLM decided not to intervene";
        }
      } else {
        logEntry.reason = `API Error: ${llmResponse.error}`;
      }
    } else {
      logEntry.reason = "State = silent, no intervention";
    }
    game.set("messagesSinceLastIntervention", 0);
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
  console.log(`[Game ended] Facilitation order: ${JSON.stringify(game.get("facilitationOrder"))}`);
});