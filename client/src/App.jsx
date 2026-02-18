import { EmpiricaClassic } from "@empirica/core/player/classic";
import { EmpiricaContext } from "@empirica/core/player/classic/react";
import { EmpiricaMenu, EmpiricaParticipant } from "@empirica/core/player/react";
import React from "react";
import { Game } from "./Game";
import { Introduction } from "./intro-exit/Introduction";
import { UserInterface } from "./intro-exit/UserInterface";
import { AttentionCheck } from "./intro-exit/AttentionCheck";
import { SubjectiveSurvey } from "./intro-exit/SubjectiveSurvey";
import { SubmitAnswer } from "./intro-exit/SubmitAnswer";
import { Consent } from "./intro-exit/Consent.jsx";
import { GamesFull } from "./intro-exit/GamesFull";
import { TLX } from "./intro-exit/TLX";
import { NoGames } from "./intro-exit/NoGames";
import { PlayerCreate } from "./intro-exit/PlayerCreate"
import { ExpFeedback } from "./intro-exit/ExpFeedback";
import { FinishedExitCode } from "./intro-exit/FinishedExitCode";
import { CustomLobby } from "./intro-exit/CustomLobby";

export default function App() {
  const urlParams = new URLSearchParams(window.location.search);
  const playerKey = urlParams.get("participantKey") || "";

  const { protocol, host } = window.location;
  const url = `${protocol}//${host}/query`;

  function introSteps({ game, player }) {
    // Uncomment line below for debugging without intro steps
    // return []; 
    return [Introduction, UserInterface, AttentionCheck];
  }

  function exitSteps({ game, player }) {
    if (player.get("ended") == "game ended" || player.get("ended") == "game terminated") {
      return [SubmitAnswer, TLX, SubjectiveSurvey, ExpFeedback];
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
          playerCreate={PlayerCreate}
          finished={FinishedExitCode}
          lobby={CustomLobby}>
            <Game />
          </EmpiricaContext>
        </div>
      </div>
    </EmpiricaParticipant>
  );
}