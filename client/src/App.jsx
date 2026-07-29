import { EmpiricaClassic } from "@empirica/core/player/classic";
import { EmpiricaContext } from "@empirica/core/player/classic/react";
import { EmpiricaMenu, EmpiricaParticipant } from "@empirica/core/player/react";
import React from "react";
import { Game } from "./Game";
import { Introduction } from "./intro-exit/Introduction";
import { UserInterface } from "./intro-exit/UserInterface";
import { AttentionCheck } from "./intro-exit/AttentionCheck";
import { SubjectiveSurvey } from "./intro-exit/SubjectiveSurvey";
import { Consent } from "./intro-exit/Consent.jsx";
import { GamesFull } from "./intro-exit/GamesFull";
import { TLX } from "./intro-exit/TLX";
import { NoGames } from "./intro-exit/NoGames";
import { PlayerCreate } from "./intro-exit/PlayerCreate"
import { ProlificPlayerCreate } from "./intro-exit/ProlificPlayerCreate";
import { RecruitmentBootstrap } from "./intro-exit/RecruitmentBootstrap";
import { Debriefing } from "./intro-exit/Debriefing";
import { ExpFeedback } from "./intro-exit/ExpFeedback";
import { FinishedExitCode } from "./intro-exit/FinishedExitCode";
import { CustomLobby } from "./intro-exit/CustomLobby";
import { getRecruitmentMode } from "./prolific";

export default function App() {
  const urlParams = new URLSearchParams(window.location.search);
  const playerKey = urlParams.get("participantKey") || "";

  const { protocol, host } = window.location;
  const url = `${protocol}//${host}/query`;

  const recruitmentMode = getRecruitmentMode();

  function introSteps({ game, player }) {
    // Uncomment line below for debugging without intro steps
    // return [];
    return [RecruitmentBootstrap, Introduction, UserInterface, AttentionCheck];
  }

  function exitSteps({ game, player }) {
    if (player.get("ended") == "game ended" || player.get("ended") == "game terminated") {
      // SubmitAnswer is intentionally no longer registered here: FinalDecision
      // is now a per-round Stage (client/src/stages/FinalDecision.jsx), so the
      // exit-step flow goes straight from the last round's FinalDecision into
      // TLX. SubmitAnswer.jsx itself is left on disk, unused, in case it's
      // needed again.
      //
      // ExpFeedback is unconditional: the formal design is within-subject --
      // every Game includes both a Static and an Adaptive round -- so there is
      // no single per-game `treatment.facilitation` value left to gate on.
      // After Round 2 finishes, the flow is always TLX -> SubjectiveSurvey ->
      // ExpFeedback -> Debriefing.
      return [TLX, SubjectiveSurvey, ExpFeedback, Debriefing];
    }
    else{
      return [GamesFull];
    }
  }

  return (
    <EmpiricaParticipant url={url} ns={playerKey} modeFunc={EmpiricaClassic}>
      <div className="h-screen relative">
        <EmpiricaMenu position="bottom-left" />
        <div className="h-full overflow-auto">
          <EmpiricaContext
          introSteps={introSteps}
          exitSteps={exitSteps}
          noGames={NoGames}
          consent={Consent}
          playerCreate={recruitmentMode === "prolific" ? ProlificPlayerCreate : PlayerCreate}
          finished={FinishedExitCode}
          lobby={CustomLobby}>
            <Game />
          </EmpiricaContext>
        </div>
      </div>
    </EmpiricaParticipant>
  );
}