import { useGame, useStage } from "@empirica/core/player/classic/react";
import { Chat } from "./components/CustomChat";
import { PlayerList } from "./components/PlayerList.jsx";
import React from "react";
import { Profile } from "./Profile";
import { Stage } from "./Stage";
import { StageTransition } from "./components/StageTransition.jsx";
import { InitialDecision } from "./stages/InitialDecision.jsx";
import { FinalDecision } from "./stages/FinalDecision.jsx";
import { Discussion } from "./stages/Discussion.jsx";

// Formal stage names used by the current design:
//   InitialDecision, Discussion, FinalDecision
// server/src/callbacks.js (not modified by this change) still creates a
// stage literally named "Task" for the discussion stage rather than
// "Discussion". This alias list is the minimal compatibility mapping so the
// same Discussion.jsx page renders either way; if the backend is later
// updated to name it "Discussion", this keeps working unchanged and the
// alias can be dropped. See the final report for what the backend currently
// actually creates.
const DISCUSSION_STAGE_NAMES = ["Discussion", "Task"];

export function Game() {
  const game = useGame();
  const stage = useStage();
  const stageName = stage.get("name");

  if (stageName == "transitionToIntroduction") {
    return <StageTransition transitionText="Get ready to meet your group in a quick icebreaker!" />
  }

  if (stageName == "transitionToTask") {
    return <StageTransition transitionText="Now that we're all acquainted, get ready for the task!" />
  }

  if (stageName == "InitialDecision") {
    return <InitialDecision />
  }

  if (DISCUSSION_STAGE_NAMES.includes(stageName)) {
    return <Discussion />
  }

  if (stageName == "FinalDecision") {
    return <FinalDecision />
  }

  if (stageName == "Introduction") {
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
            <Chat scope={game} attribute="intro" />
          </div>
        </div>
      </div>
    );
  }

  // Unrecognized stage name: fail safe with a clear message instead of a
  // blank screen.
  return (
    <div className="h-full w-full flex items-center justify-center">
      <div className="text-center text-gray-500 max-w-md px-6">
        This part of the experiment isn't recognized by this version of the
        interface (stage: "{stageName}"). Please contact the research team.
      </div>
    </div>
  );
}
