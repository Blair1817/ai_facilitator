import React from "react";
import { Button } from "../components/Button";
import { RenderMarkdown } from "../components/RenderMarkdown.jsx";
import { usePlayer, useRound } from "@empirica/core/player/classic/react";

export function taskBackgroundOnly(markdown) {
  if (typeof markdown !== "string") return "";
  const firstCandidateSection = markdown.indexOf("\n## ");
  return firstCandidateSection >= 0 ? markdown.slice(0, firstCandidateSection) : markdown;
}

export function Introduction() {
  const player = usePlayer();
  const round = useRound();
  const generalInfo = round?.get("generalInfo");
  const taskBackground = taskBackgroundOnly(generalInfo);
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

  if (!taskBackground) {
    return (
      <div className="h-full w-full flex items-center justify-center text-gray-500">
        This task information is not available. Please contact the research team.
      </div>
    );
  }

  return (
    <div className="h-full w-full overflow-y-auto bg-gray-50 px-4 py-8 sm:px-8">
      <main className="mx-auto w-full max-w-3xl rounded-lg border border-gray-200 bg-white p-6 shadow-sm sm:p-8">
      <p className="text-xs uppercase tracking-wide text-gray-400 text-center mb-2">
        {round?.get("name")} · Task {taskVersion}
      </p>
      <RenderMarkdown markdownText={taskBackground} />
      <div className="mt-8 text-right">
        <Button handleClick={() => player.stage.set("submit", true)}>
          <p>Continue</p>
        </Button>
      </div>
      </main>
    </div>
  );
}
