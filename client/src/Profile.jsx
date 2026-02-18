import {
  usePlayer,
  useRound,
  useStage,
} from "@empirica/core/player/classic/react";
import React from "react";
import { Avatar } from "./components/Avatar";
import { Timer } from "./components/Timer";

export function Profile() {
  const player = usePlayer();
  const hexCode = player.get("hexCode");
  const coloredNameClass = `font-bold text-[#${hexCode}]`; 
  const round = useRound();
  const stage = useStage();

  const score = player.get("score") || 0;

  return (
    <div className="min-w-lg md:min-w-2xl mt-5 m-x-auto px-3 py-2 text-gray-500 rounded-md grid grid-cols-2 items-center border-.5">
      {/* <div className="leading-tight ml-1">
        <div className="text-gray-600 font-semibold">
          {round ? round.get("name") : ""}
        </div>
        <div className="text-empirica-500 font-medium">
          {stage ? stage.get("name") : ""}
        </div>
      </div> */}

      <div className="flex items-center gap-5">
        <div className="text-gray-600 font-bold">Time remaining: </div>
      <Timer />
      </div>

      

      <div className="flex space-x-3 items-center justify-end">
      <div className="leading-tight ml-1">
        <div className="text-gray-600 font-semibold">
          You are:
        </div>
        <div className="font-bold" style={{color: "#"+hexCode}}>
          {player.get("name")}
        </div>
      </div>
        {/* <div className="flex flex-col items-center">
          <div className="text-xs font-semibold uppercase tracking-wide leading-none text-gray-400">
            Score
          </div>
          <div className="text-3xl font-semibold !leading-none tabular-nums">
            {score}
          </div>
        </div> */}
        <div className="h-11 w-11">
          <Avatar player={player} />
        </div>
      </div>
    </div>
  );
}
