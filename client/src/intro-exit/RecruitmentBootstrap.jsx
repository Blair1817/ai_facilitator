import React, { useEffect, useRef } from "react";
import { usePlayer } from "@empirica/core/player/classic/react";
import { Loading } from "@empirica/core/player/react";
import { getRecruitmentMode, getProlificParams } from "../prolific";

// Runs immediately after the one-time OverallInstructions introStep and
// records recruitment metadata before the Lobby and experimental Rounds.
// Consent is completed outside Empirica and is intentionally not collected
// or stored here.
export function RecruitmentBootstrap({ next }) {
  const player = usePlayer();
  const ran = useRef(false);

  useEffect(() => {
    if (ran.current) {
      return;
    }
    ran.current = true;

    if (getRecruitmentMode() === "prolific" && !player.get("prolificPID")) {
      const { prolificPID, studyID, sessionID } = getProlificParams();
      player.set("prolificPID", prolificPID);
      player.set("prolificStudyID", studyID);
      player.set("prolificSessionID", sessionID);
    }

    next();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return <Loading />;
}
