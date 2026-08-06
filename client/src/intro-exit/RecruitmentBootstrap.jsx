import React, { useEffect, useRef } from "react";
import { usePlayer } from "@empirica/core/player/classic/react";
import { Loading } from "@empirica/core/player/react";
import { getRecruitmentMode, getProlificParams } from "../prolific";
import { CONSENT_METADATA_KEY } from "./Consent.jsx";

// Runs immediately after the one-time OverallInstructions introStep (see
// App.jsx). Consent and PlayerCreate both happen before any player exists;
// this step copies consent and recruitment metadata onto the player before
// the Lobby wait and experimental Rounds.
export function RecruitmentBootstrap({ next }) {
  const player = usePlayer();
  const ran = useRef(false);

  useEffect(() => {
    if (ran.current) {
      return;
    }
    ran.current = true;

    if (!player.get("consentTimestamp")) {
      let consentMeta = {};
      try {
        consentMeta = JSON.parse(window.localStorage.getItem(CONSENT_METADATA_KEY) || "{}");
      } catch (e) {
        consentMeta = {};
      }

      const recruitmentMode = getRecruitmentMode();
      player.set("consentStatus", "consented");
      player.set("consentTimestamp", consentMeta.consentedAt || Date.now());
      player.set("consentVersion", consentMeta.consentVersion || null);

      if (recruitmentMode === "prolific") {
        const { prolificPID, studyID, sessionID } = getProlificParams();
        player.set("prolificPID", prolificPID);
        player.set("prolificStudyID", studyID);
        player.set("prolificSessionID", sessionID);
      }
    }

    next();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return <Loading />;
}
