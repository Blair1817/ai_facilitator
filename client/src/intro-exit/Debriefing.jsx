import React, { useEffect, useState } from "react";
import { usePlayer } from "@empirica/core/player/classic/react";
import { useTajribaConnected } from "@empirica/core/player/react";
import { Button } from "../components/Button";
import { RenderMarkdown } from "../components/RenderMarkdown.jsx";
import { getRecruitmentMode } from "../prolific";

// Best-effort pre-redirect buffer. The client SDK's player.set() is
// fire-and-forget with no awaitable/flush-confirmation API (verified by reading
// @empirica/core's dist source: Attribute.set() returns nothing, and the only
// flush() mechanism found is admin/server-side only). This delay cannot
// guarantee the write below has round-tripped to the server before navigating
// away — it is a documented mitigation, not a guarantee. Researchers should
// confirm via a real end-to-end test that debriefingSeenAt (and the rest of
// that participant's data) actually lands in tajriba.json / an admin export.
const PRE_REDIRECT_BUFFER_MS = 1500;

export function Debriefing({ next }) {
  const player = usePlayer();
  const tajribaConnected = useTajribaConnected();
  const [redirecting, setRedirecting] = useState(false);
  const [advancing, setAdvancing] = useState(false);

  useEffect(() => {
    if (!player.get("debriefingSeenAt")) {
      player.set("debriefingSeenAt", Date.now());
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const recruitmentMode = getRecruitmentMode();
  const completionUrl = import.meta.env.VITE_PROLIFIC_COMPLETION_URL;

  const handleContinue = () => {
    if (redirecting || advancing || !tajribaConnected) {
      // Don't navigate away while the connection is down; the debriefingSeenAt
      // write above may not have gone anywhere yet. Also guards against a
      // double-click re-triggering this handler.
      return;
    }

    if (recruitmentMode === "prolific" && completionUrl) {
      setRedirecting(true);
      setTimeout(() => {
        window.location.href = completionUrl;
      }, PRE_REDIRECT_BUFFER_MS);
      return;
    }

    setAdvancing(true);
    next();
  };

  const showMissingUrlWarning = recruitmentMode === "prolific" && !completionUrl;

  return (
    <div className="flex-col justify-center mx-10% mt-5%">
      <RenderMarkdown markdownText={debriefingMarkdown} />

      {!tajribaConnected && (
        <p className="text-center text-sm text-gray-500 mb-4">
          Reconnecting… please wait.
        </p>
      )}

      {showMissingUrlWarning && (
        <p className="text-center text-sm text-yellow-700 mb-4">
          ⚠️ VITE_PROLIFIC_COMPLETION_URL is not configured — this would strand
          a real participant. Continuing to the placeholder completion screen
          for local testing.
        </p>
      )}

      <div className="text-center pb-10px">
        <Button handleClick={handleContinue} disabled={redirecting || advancing || !tajribaConnected}>
          <p>{redirecting ? "Redirecting…" : "Continue"}</p>
        </Button>
      </div>
    </div>
  );
}

const debriefingMarkdown = `# Debriefing

**[RESEARCHERS: Replace this placeholder with your own study-specific debriefing text before deploying your study.]**

Consider including the following information in your debriefing:

- The true purpose of the study, including anything that was not fully disclosed during Consent
- An explanation of the study design (e.g., the different facilitation conditions)
- Contact information for questions or concerns
- Information about how to withdraw data after the fact, if applicable

Click Continue to finish the study.`;
