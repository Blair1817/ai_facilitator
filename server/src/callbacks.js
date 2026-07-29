import { ClassicListenersCollector } from "@empirica/core/admin/classic";
export const Empirica = new ClassicListenersCollector();
import _, { method, template } from 'lodash';
import dotenv from "dotenv";
import { taskRegistry } from "./TaskRegistry.mjs";
import { llmSystemPrompts } from "./LLMConfig";
import { resolveFacilitationDispatch } from "./ConditionRouting.mjs";

dotenv.config();

const openaiModel = process.env.OPENAI_MODEL || "gpt-4o";
const llmAPIEndpoint = process.env.LLM_API_ENDPOINT || "https://api.openai.com/v1/responses";
const llmMaxOutputTokens = Number.parseInt(process.env.LLM_MAX_OUTPUT_TOKENS ?? "1000", 10);


async function getLLMResponse(messages) {

  // # Uncomment to debug
  // console.log("LLM Configuration:");
  // console.log(`Model: ${openaiModel}`);
  // console.log(`Max Output Tokens: ${llmMaxOutputTokens}`);
  // console.log(`API Endpoint: ${llmAPIEndpoint}`);
  
  const data = {
    model: openaiModel,
    max_output_tokens: llmMaxOutputTokens,
    input: messages,
    text: { format: { type: "json_object" } }
  };

  try {
    const completion = await fetch(llmAPIEndpoint, {
      method: "POST",
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${process.env.OPENAI_API_KEY}`
      },
      body: JSON.stringify(data)
    });

    const isJson = completion.headers
      .get("content-type")
      ?.includes("application/json");
    const responseBody = isJson
      ? await completion.json()
      : await completion.text();

    if (!completion.ok) {
      const errorPayload = isJson ? responseBody : { error: responseBody };
      console.error("LLM endpoint HTTP error:", {
        status: completion.status,
        statusText: completion.statusText,
        error: errorPayload?.error || errorPayload
      });
      return {
        success: false,
        error: errorPayload?.error?.message || completion.statusText
      };
    }

    const message = responseBody?.output?.find((item) => item.type === "message");
    const text = message?.content?.find((c) => c.type === "output_text")?.text;
    if (!text) {
      console.error("LLM endpoint response missing output text:", responseBody);
      return { success: false, error: "LLM response missing output text" };
    }

    const llmAction = JSON.parse(text);
    return { success: true, data: llmAction };
  } catch (error) {
    console.error('LLM endpoint Error: ', error);
    return { success: false, error: error.message };
  }
}


function formatDuration(duration) {
  const totalSeconds = Math.floor(duration / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;

  const formattedMinutes = minutes > 0 ? `${minutes} mins` : '';
  const formattedSeconds = `${seconds} seconds`;

  return `${formattedMinutes}${formattedMinutes && formattedSeconds ? ', ' : ''}${formattedSeconds}`;
}



Empirica.onGameStart(({ game }) => {
  const { playerCount, facilitation, gameDuration, introDuration, phase1Duration, llmRequestInterval, fullInfo, taskVersion} = game.get("treatment");

  const taskEntry = taskRegistry[taskVersion];
  if (!taskEntry || !taskEntry.readyForFlowTesting) {
    console.error(`[GRAIL] BLOCKED game start: taskVersion "${taskVersion}" is not readyForFlowTesting (game ID: ${game.id}, treatment: ${JSON.stringify(game.get("treatment"))}). No rounds/stages will be created for this game.`);
    return;
  }

  game.set("llmLog", []);
  game.set("generalInfo", taskEntry.generalInfo)
  game.set("taskDecisionOptions", taskEntry.decisionOptions)
  const shuffleTaskConfig = _.shuffle(taskEntry.playerConfig);
  const players = game.players;
  const randomFacilitatorPlayerIndex = Math.floor(Math.random() * players.length);
  const nonFacilitatorPlayers = players.filter((_, i) => i !== randomFacilitatorPlayerIndex);



  // Create the round/stage structure 
  const round = game.addRound({
    name: "Round 1"
  });
  round.addStage({ name: "transitionToIntroduction", duration: 10 });
  round.addStage({ name: "Introduction", duration: introDuration * 60 });
  round.addStage({ name: "transitionToTask", duration: 10 });
  round.addStage({ name: "InitialDecision", duration: phase1Duration * 60 });
  round.addStage({ name: "Task", duration: gameDuration * 60 });

  // Randomly assign private content to players 
  if (facilitation == "human") {
    nonFacilitatorPlayers.forEach((player, i) => {
      player.set("name", shuffleTaskConfig[i].playerName);
      player.set("playerContent", fullInfo ? shuffleTaskConfig[i].playerContent_fullinfo : shuffleTaskConfig[i].playerContent);
      player.set("hexCode", shuffleTaskConfig[i].hexCode);
    });
    players[randomFacilitatorPlayerIndex].set("name", "Facilitator");
    players[randomFacilitatorPlayerIndex].set("playerContent", llmSystemPrompts("human", false));
  }
  else {
    players.forEach((player, i) => {
      player.set("name", shuffleTaskConfig[i].playerName);
      player.set("playerContent", fullInfo ? shuffleTaskConfig[i].playerContent_fullinfo : shuffleTaskConfig[i].playerContent);
      player.set("hexCode", shuffleTaskConfig[i].hexCode);
    });
  }

});

Empirica.onRoundStart(({ round }) => { });

Empirica.onStageStart(({ stage }) => {
  const game = stage.currentGame;
  const { playerCount, facilitation, gameDuration, introDuration, llmRequestInterval, requireLLMMessage} = game.get("treatment");
  const players = game.players;

  if (stage.get("name") == "Task") {
    game.set("taskStartTime", new Date().getTime());
    game.set("deadline", game.get("taskStartTime") + gameDuration * 60 * 1000);
  }

  const dispatch = resolveFacilitationDispatch(facilitation);
  if (stage.get("name") == "Task" && !dispatch.eligible && dispatch.kind !== "none") {
    console.error(`[GRAIL] Facilitation condition routing: ${dispatch.reason} (game ID: ${game.id}). No LLM requests will be made for this game.`);
  }

  // Kick off LLM listener if needed by treatment
  if (dispatch.eligible && stage.get("name") == "Task") {
    // Every llmRequestInterval seconds, query the LLM for a response, then kill the interval
    const interval = setInterval(async () => {
      const remainingTime = game.get("deadline") - new Date().getTime();
      const timeElapsed = new Date().getTime() - game.get("taskStartTime");
      
      let logEntry = {
        timestamp: new Date().getTime(),
        remainingTime: remainingTime,
        timeElapsed: timeElapsed,
        intervalTriggered: true,
        requestMade: false,
        requestSuccess: false,
        reason: "",
        model: openaiModel,
        directlyRequested: false,
        requireLLMMessage: requireLLMMessage
      };

      if (game.get("chat")) {
        const lastSender = game.get("chat")[game.get("chat").length - 1].sender.id;

        if (lastSender != "ai") {
          logEntry.requestMade = true;

          const messagesOAIFormat = [{
            content: game.get("chat").map((message) => `[${formatDuration(new Date().getTime() - message.ts)} ago] ${message.sender.name}: ${message.text}`).join("\n"),
            role: "user"
          }];

          messagesOAIFormat.unshift({ content: `[TIME REMAINING: ${formatDuration(remainingTime)}]`, role: "system" });
          messagesOAIFormat.unshift({ content: `[TIME ELAPSED: ${formatDuration(timeElapsed)}]`, role: "system" });
          messagesOAIFormat.unshift({ content: `Meeting attendees: ${players.map((player) => player.get("name")).join(", ")}`, role: "system" });
          messagesOAIFormat.unshift({ content: llmSystemPrompts(facilitation, requireLLMMessage), role: "system" });

          logEntry.messagesOAIFormat = messagesOAIFormat;

          const llmResponse = await getLLMResponse(messagesOAIFormat);

          if (llmResponse.success) {
            const llmAction = llmResponse.data;
            logEntry.requestSuccess = true;
            logEntry.llmAction = llmAction;

            if (llmAction.DECISION == "INTERVENE" || requireLLMMessage) {
              game.append("chat", {
                text: llmAction.MESSAGE, ts: new Date().getTime(),
                sender: { id: "ai", name: "Facilitator", avatar: `https://api.dicebear.com/9.x/initials/svg?backgroundColor=000000&seed=F` }
              });
              logEntry.messageAdded = true;
            } else {
              logEntry.messageAdded = false;
              logEntry.reason = "LLM decided not to intervene";
            }
          } else {
            logEntry.reason = `API Error: ${llmResponse.error}`;
          }
        } else {
          logEntry.reason = "Last message was from AI, no request made";
        }
      } else {
        logEntry.reason = "No chat messages available";
      }

      game.set("llmLog", [...game.get("llmLog"), logEntry]);
      Empirica.flush();
    }, llmRequestInterval * 1000);

    setTimeout(() => {
      clearInterval(interval);
    }, (gameDuration * 60 - 20) * 1000);
  }
});

Empirica.onStageEnded(({ stage }) => { });

Empirica.onRoundEnded(({ round }) => { });

Empirica.onGameEnded(({ game }) => { });


// Allowing users to explicitly trigger a facilitator message 
Empirica.on("game", "chat", async function (env, { game }) {
  const { playerCount, facilitation, gameDuration, introDuration, llmRequestInterval, requireLLMMessage} = game.get("treatment");
  const players = game.players;
  const lastSender = game.get("chat")[game.get("chat").length - 1].sender.id
  const isFacilitatorTagged = game.get("chat")[game.get("chat").length - 1].text.includes("@[Facilitator]")

  const dispatch = resolveFacilitationDispatch(facilitation);
  if (dispatch.eligible && lastSender != "ai" && isFacilitatorTagged) {
    const remainingTime = game.get("deadline") - new Date().getTime();
    const timeElapsed = new Date().getTime() - game.get("taskStartTime");

    let logEntry = {
      timestamp: new Date().getTime(),
      remainingTime: remainingTime,
      timeElapsed: timeElapsed,
      intervalTriggered: false,
      requestMade: true,
      requestSuccess: false,
      reason: "",
      model: openaiModel,
      directlyRequested: true,
      requireLLMMessage: requireLLMMessage
    };

    const messagesOAIFormat = [{
      content: game.get("chat").map((message) => `[${formatDuration(new Date().getTime() - message.ts)} ago] ${message.sender.name}: ${message.text}`).join("\n"),
      role: "user"
    }]

    // Add the deadline and current time to the beginning of the messages 
    messagesOAIFormat.unshift({ content: `[TIME REMAINING: ${formatDuration(remainingTime)}]`, role: "system" })
    messagesOAIFormat.unshift({ content: `[TIME ELAPSED: ${formatDuration(timeElapsed)}]`, role: "system" })

    // Add the list of meeting attendees 
    messagesOAIFormat.unshift({ content: `Meeting attendees: ${players.map((player) => player.get("name")).join(", ")}`, role: "system" })

    // Add the system prompt to the beginning of the messages
    messagesOAIFormat.unshift({ content: llmSystemPrompts(facilitation, true), role: "system" })

    logEntry.messagesOAIFormat = messagesOAIFormat;

    try {
      const llmResponse = await getLLMResponse(messagesOAIFormat);

      if (llmResponse.success) {
        const llmAction = llmResponse.data;
        logEntry.requestSuccess = true;
        logEntry.llmAction = llmAction;

        game.append("chat", {
          text: llmAction.MESSAGE, 
          ts: new Date().getTime(),
          sender: { id: "ai", name: "Facilitator", avatar: `https://api.dicebear.com/9.x/initials/svg?backgroundColor=000000&seed=F` }
        });

        logEntry.messageAdded = true;
      } else {
        logEntry.reason = `API Error: ${llmResponse.error}`;
        logEntry.messageAdded = false;
      }
    } catch (error) {
      logEntry.reason = `Unexpected Error: ${error.message}`;
      logEntry.messageAdded = false;
    }

    game.set("llmLog", [...game.get("llmLog"), logEntry]);
    Empirica.flush();
  }
});