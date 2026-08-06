import React from "react";
import { Button } from "../components/Button";
import { RenderMarkdown } from "../components/RenderMarkdown.jsx";
import { usePlayer, useRound } from "@empirica/core/player/classic/react";

export function Introduction() {
  const player = usePlayer();
  const round = useRound();
  const generalInfo = round?.get("generalInfo");
  const taskVersion = round?.get("taskVersion");

  if (player.stage.get("submit")) {
    return (
      <div className="h-full w-full flex items-center justify-center">
        <div className="text-center text-gray-400 pointer-events-none">
          Task information reviewed.
          <br />
          Please wait for the other participant(s).
        </div>
      </div>
    );
  }

  if (!generalInfo) {
    return (
      <div className="h-full w-full flex items-center justify-center text-gray-500">
        This task information is not available. Please contact the research team.
      </div>
    );
  }

  return (
    <div className="flex-col justify-center mx-20% mt-5%">
      <p className="text-xs uppercase tracking-wide text-gray-400 text-center mb-2">
        {round?.get("name")} · Task {taskVersion}
      </p>
      <RenderMarkdown markdownText={generalInfo} />
      <div className="text-right pb-10px">
        <Button handleClick={() => player.stage.set("submit", true)}>
          <p>Next</p>
        </Button>
      </div>
    </div>
  );
}
