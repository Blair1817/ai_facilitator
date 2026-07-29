import React, { useEffect, useRef } from "react";
import { usePlayer } from "@empirica/core/player/classic/react";
import { Loading } from "@empirica/core/player/react";
import { getRecruitmentMode, getProlificParams } from "../prolific";
import { CONSENT_METADATA_KEY } from "./Consent.jsx";

// First introStep (see App.jsx). Runs as early as the Empirica framework
// allows content tied to the player object to run at all (Consent and
// PlayerCreate both happen before any player exists yet), so consent +
// recruitment metadata survive a participant quitting during Introduction,
// UserInterface, AttentionCheck, or the Lobby wait.
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
