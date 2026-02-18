import {
  usePlayer,
  usePlayers,
  useRound,
  useStage
} from "@empirica/core/player/classic/react";
import { Loading } from "@empirica/core/player/react";
import React from "react";
import { PlayerSpecificInfo } from "./components/PlayerSpecificInfo.jsx";
import { RenderMarkdown } from "./components/RenderMarkdown.jsx";



export function Stage() {
  const player = usePlayer();
  const players = usePlayers();
  const round = useRound();
  const stage = useStage();
  const introInstructions = `## Before we start the main task, take a minute to get to know your group
  * Try using "@" in the chat window to tag at least 2 other group members in a message
  * When the timer for this icebreaker stage ends, you'll automatically proceed to the next stage where you will discuss the decision of where to host the event`

  if (player.stage.get("submit")) {
    if (players.length === 1) {
      return <Loading />;
    }

    return (
      <div className="text-center text-gray-400 pointer-events-none">
        Please wait for other player(s).
      </div>
    );
  }


  if (stage.get("name") == "Introduction") {
    return (
      <div className="items-center mx-15">
      <RenderMarkdown markdownText={introInstructions} />
      </div>
    )
  }
  else {
    return <PlayerSpecificInfo />;
  }



}


