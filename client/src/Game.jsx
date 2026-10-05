import { useStage, useRound } from "@empirica/core/player/classic/react";
import React, { useLayoutEffect } from "react";
import { FinalDecision } from "./stages/FinalDecision.jsx";
import { Discussion } from "./stages/Discussion.jsx";
import { PracticeOnboarding } from "./practice/PracticeOnboarding.jsx";
import { PersonalFlow } from "./PersonalFlow.jsx";

// server/src/callbacks.js still creates a stage literally named "Task" for
// the discussion stage rather than
// "Discussion". This alias list is the minimal compatibility mapping so the
// same Discussion.jsx page renders either way; if the backend is later
// updated to name it "Discussion", this keeps working unchanged and the
// alias can be dropped. See the final report for what the backend currently
// actually creates.
const DISCUSSION_STAGE_NAMES = ["Discussion", "Task"];

export function Game() {
  const stage = useStage();
  const round = useRound();
  const stageName = stage.get("name");
  // MIGRATED from old 2nd: a stable identity for the *current round+stage
  // combination*, used as a React key below so InitialDecision/Discussion/
  // FinalDecision fully remount (resetting all local component state)
  // between Round 1 and Round 2.
  const roundStageKey = `${round?.id ?? "no-round"}-${stageName}`;

  // Each Empirica stage is rendered inside the same outer scroll container.
  // Reset that shared container whenever the stage changes so the next page
  // cannot inherit the previous page's scroll position and hide its header
  // (including the Discussion countdown/profile banner).
  useLayoutEffect(() => {
    document.getElementById("participant-scroll-root")?.scrollTo(0, 0);
    window.scrollTo(0, 0);
  }, [roundStageKey]);

  if (round?.get("isPractice")) {
    return stageName === "FinalDecision"
      ? <FinalDecision key={roundStageKey} />
      : <PracticeOnboarding key={roundStageKey} />;
  }

  if (["Preparation", "Followup"].includes(stageName)) return <PersonalFlow key={roundStageKey} />;

  if (DISCUSSION_STAGE_NAMES.includes(stageName)) {
    return <Discussion key={roundStageKey} />
  }

  if (stageName == "FinalDecision") {
    return <FinalDecision key={roundStageKey} />
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
