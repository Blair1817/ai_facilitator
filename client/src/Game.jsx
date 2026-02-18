import { useGame, useStage } from "@empirica/core/player/classic/react";
import { Chat } from "./components/CustomChat";
import { PlayerList } from "./components/PlayerList.jsx";
import React, {useEffect, useState} from "react";
import { Profile } from "./Profile";
import { Stage } from "./Stage";
import { StageTransition } from "./components/StageTransition.jsx";


export function Game() {
  const game = useGame();
  const stage = useStage();
  const { playerCount } = game.get("treatment");

  if (stage.get("name") == "transitionToIntroduction") {
    return <StageTransition transitionText="Get ready to meet your group in a quick icebreaker!" />
  }

  if (stage.get("name") == "transitionToTask") {
    return <StageTransition transitionText="Now that we're all acquainted, get ready for the task!" />
  }

  return (
    <div className="h-full w-full flex">
    <div className="h-full flex flex-col" style={{ width: '50%' }}>
      <Profile />
      <div className="h-full flex items-center justify-center">
        <Stage />
      </div>
    </div>
    <div className="flex flex-col h-full border-6 justify-center items-center" style={{ width: '50%' }}>
      <div className="w-full mb-4 mt-5 px-5">
        <PlayerList />
      </div>
      <div className="w-full flex-grow overflow-y-auto overflow-x-hidden">
        <Chat scope={game} attribute={stage.get("name") == "Introduction" ? "intro" : "chat"} />
      </div>
    </div>
  </div>
  );
}