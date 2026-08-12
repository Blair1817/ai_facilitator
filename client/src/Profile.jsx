import { usePlayer } from "@empirica/core/player/classic/react";
import React from "react";
import { Avatar } from "./components/Avatar";
import { Timer } from "./components/Timer";

export function Profile() {
  const player = usePlayer();
  const hexCode = player.get("hexCode");
  return (
    <div className="grid w-full grid-cols-2 items-center rounded-lg border border-gray-200 bg-white px-4 py-3 text-gray-500 shadow-sm">
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
        <div className="h-11 w-11">
          <Avatar player={player} />
        </div>
      </div>
    </div>
  );
}
