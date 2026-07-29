import React, { useEffect, useRef } from "react";
import { getProlificParams } from "../prolific";

// Formal-mode replacement for PlayerCreate.tsx: no form, no manual ID entry.
// Registers the participant silently using SESSION_ID once the required
// Prolific identifiers are present in the URL; blocks entry with a generic
// message (no identifiers echoed anywhere) if any are missing.
export function ProlificPlayerCreate({ onPlayerID, connecting }) {
  const { isComplete, sessionID } = getProlificParams();
  const registered = useRef(false);

  useEffect(() => {
    if (isComplete && !registered.current) {
      registered.current = true;
      onPlayerID(sessionID);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  if (!isComplete) {
    return (
      <div className="min-h-screen flex items-center justify-center px-8">
        <div className="max-w-md text-center text-gray-700">
          <h2 className="text-xl font-bold mb-4">This study link is incomplete</h2>
          <p>
            This link is missing information required to start the study. Please
            return to Prolific and reopen the study link. If this problem
            persists, contact the research team.
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen flex items-center justify-center">
      <div className="text-gray-500">
        {connecting ? "Connecting…" : "Setting up your session…"}
      </div>
    </div>
  );
}
