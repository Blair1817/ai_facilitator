import { useGame, useStage, useRound } from "@empirica/core/player/classic/react";
import { Chat } from "./components/CustomChat";
import { PlayerList } from "./components/PlayerList.jsx";
import React from "react";
import { Profile } from "./Profile";
import { Stage } from "./Stage";
import { StageTransition } from "./components/StageTransition.jsx";
import { InitialDecision } from "./stages/InitialDecision.jsx";
import { FinalDecision } from "./stages/FinalDecision.jsx";
import { Discussion } from "./stages/Discussion.jsx";
import { ReviewQuiz } from "./stages/ReviewQuiz.jsx";
import { Introduction } from "./intro-exit/Introduction.jsx";
import { UserInterface } from "./intro-exit/UserInterface.jsx";
import { TLX } from "./intro-exit/TLX.jsx";
import { SubjectiveSurvey } from "./intro-exit/SubjectiveSurvey.jsx";

// Formal stage names used by the current design include round-level task
// information, walkthrough, questionnaire, and decision/discussion screens.
// server/src/callbacks.js still creates a stage literally named "Task" for
// the discussion stage rather than
// "Discussion". This alias list is the minimal compatibility mapping so the
// same Discussion.jsx page renders either way; if the backend is later
// updated to name it "Discussion", this keeps working unchanged and the
// alias can be dropped. See the final report for what the backend currently
// actually creates.
const DISCUSSION_STAGE_NAMES = ["Discussion", "Task"];

export function Game() {
  const game = useGame();
  const stage = useStage();
  const round = useRound();
  const stageName = stage.get("name");
  // MIGRATED from old 2nd: a stable identity for the *current round+stage
  // combination*, used as a React key below so InitialDecision/Discussion/
  // FinalDecision fully remount (resetting all local component state)
  // between Round 1 and Round 2.
  const roundStageKey = `${round?.id ?? "no-round"}-${stageName}`;

  if (stageName == "TaskInformation") {
    return <Introduction key={roundStageKey} />
  }

  if (stageName == "Walkthrough") {
    return <UserInterface key={roundStageKey} />
  }

  if (stageName == "InitialDecision") {
    return <InitialDecision key={roundStageKey} />
  }

  if (stageName == "ReviewQuiz") {
    return <ReviewQuiz key={roundStageKey} />
  }

  if (stageName == "TransitionToIceBreaker") {
    return (
      <StageTransition
        transitionText={(
          <>
            <span className="block">Discussion Preparation</span>
            <span className="mt-2 block text-base font-normal text-gray-600">
              You will begin a short discussion activity next.
              <br />
              Please wait for the next stage to begin.
            </span>
          </>
        )}
      />
    )
  }

  if (DISCUSSION_STAGE_NAMES.includes(stageName)) {
    return <Discussion key={roundStageKey} />
  }

  if (stageName == "FinalDecision") {
    return <FinalDecision key={roundStageKey} />
  }

  if (stageName == "TLX") {
    return <TLX key={roundStageKey} />
  }

  if (stageName == "SubjectiveSurvey") {
    return <SubjectiveSurvey key={roundStageKey} />
  }

  if (stageName == "Break") {
    return (
      <StageTransition transitionText="Break Time — You now have a 5-minute break. The next task will begin automatically when the timer reaches 00:00." />
    )
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
