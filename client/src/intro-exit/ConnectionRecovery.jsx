import React, { useEffect, useState } from "react";
import {
  useGame,
  usePlayer,
  useRound,
  useStage,
} from "@empirica/core/player/classic/react";

const SHOW_RECOVERY_AFTER_MS = 12_000;

export function ConnectionRecovery() {
  const game = useGame();
  const player = usePlayer();
  const round = useRound();
  const stage = useStage();
  const [showRecovery, setShowRecovery] = useState(false);
  const [online, setOnline] = useState(() => navigator.onLine);

  useEffect(() => {
    const timer = window.setTimeout(
      () => setShowRecovery(true),
      SHOW_RECOVERY_AFTER_MS,
    );
    const updateOnline = () => setOnline(navigator.onLine);
    window.addEventListener("online", updateOnline);
    window.addEventListener("offline", updateOnline);

    return () => {
      window.clearTimeout(timer);
      window.removeEventListener("online", updateOnline);
      window.removeEventListener("offline", updateOnline);
    };
  }, []);

  const gameStarted = Boolean(game?.get("status"));
  const missingStageData = gameStarted && player && (!round || !stage);

  return (
    <div className="flex h-full min-h-screen items-center justify-center px-6">
      <div className="max-w-xl text-center" role="status" aria-live="polite">
        <div
          className="mx-auto h-10 w-10 animate-spin rounded-full border-4 border-empirica-200 border-t-empirica-600"
          aria-hidden="true"
        />
        <h2 className="mt-5 text-2xl font-medium text-gray-900">
          {online ? "Connecting to the study session" : "Your device is offline"}
        </h2>
        <p className="mt-3 text-lg text-gray-600">
          {missingStageData
            ? "The session has started, but the round data has not arrived yet."
            : "Please keep this page open while the secure session reconnects."}
        </p>

        {showRecovery && (
          <div className="mt-6 rounded border border-amber-300 bg-amber-50 p-5">
            <p className="text-base text-gray-800">
              This is taking longer than expected. Reconnecting is safe and
              will keep your participant identifier on this device.
            </p>
            <button
              type="button"
              className="mt-4 rounded bg-empirica-600 px-5 py-3 font-medium text-white"
              onClick={() => window.location.reload()}
            >
              Reconnect now
            </button>
            <p className="mt-3 text-sm text-gray-600">
              If reconnecting does not work, contact the research team and say
              that the session did not finish loading.
            </p>
          </div>
        )}
      </div>
    </div>
  );
}
