import { EmpiricaClassic } from "@empirica/core/player/classic";
import { EmpiricaContext } from "@empirica/core/player/classic/react";
import { EmpiricaMenu, EmpiricaParticipant } from "@empirica/core/player/react";
import React from "react";
import { Game } from "./Game";
import { GamesFull } from "./intro-exit/GamesFull";
import { NoGames } from "./intro-exit/NoGames";
import { OverallInstructions } from "./intro-exit/OverallInstructions";
import { PlayerCreate } from "./intro-exit/PlayerCreate"
import { ProlificPlayerCreate } from "./intro-exit/ProlificPlayerCreate";
import { RecruitmentBootstrap } from "./intro-exit/RecruitmentBootstrap";
import { Debriefing } from "./intro-exit/Debriefing";
import { ExpFeedback } from "./intro-exit/ExpFeedback";
import { FinalQuestions } from "./intro-exit/FinalQuestions";
import { CustomLobby } from "./intro-exit/CustomLobby";
import { getRecruitmentMode } from "./prolific";

export default function App() {
  const urlParams = new URLSearchParams(window.location.search);
  const playerKey = urlParams.get("participantKey") || "";

  const { protocol, host } = window.location;
  const url = `${protocol}//${host}/query`;

  const recruitmentMode = getRecruitmentMode();

  function introSteps({ game, player }) {
    // One-time global guidance followed by the invisible metadata bootstrap.
    // Participant-facing task information, walkthrough, and ReviewQuiz remain
    // inside each Round.
    return [OverallInstructions, RecruitmentBootstrap];
  }

  function exitSteps({ game, player }) {
    if (player.get("ended") == "game ended") {
      // FinalDecision is now a per-round Stage
      // (client/src/stages/FinalDecision.jsx), so the
      // exit-step flow now begins only after Round 2's round-level TLX and
      // SubjectiveSurvey.
      //
      // ExpFeedback is unconditional: the formal design is within-subject --
      // every Game includes both a Static and an Adaptive round -- so there is
      // no single per-game `treatment.facilitation` value left to gate on.
      // After Round 2 finishes, the experiment-level flow is always
      // FinalQuestions -> ExpFeedback -> Debriefing.
      return [FinalQuestions, ExpFeedback, Debriefing];
    }
    if (player.get("ended") == "game terminated") {
      // Preserve the existing early-termination exit path without presenting
      // cross-round questions to a participant who did not complete both rounds.
      return [ExpFeedback, Debriefing];
    }
    else{
      return [GamesFull];
    }
  }

  return (
    <EmpiricaParticipant url={url} ns={playerKey} modeFunc={EmpiricaClassic}>
      <div className="h-screen relative">
        <EmpiricaMenu position="bottom-left" />
        <div id="participant-scroll-root" className="h-full overflow-auto">
          <EmpiricaContext
          introSteps={introSteps}
          exitSteps={exitSteps}
          noGames={NoGames}
          disableConsent
          playerCreate={recruitmentMode === "prolific" ? ProlificPlayerCreate : PlayerCreate}
          lobby={CustomLobby}>
            <Game />
          </EmpiricaContext>
        </div>
      </div>
    </EmpiricaParticipant>
  );
}
