import React, { useEffect, useState } from "react";
import {
  useGame,
  usePlayer,
  useRound,
  useStage,
} from "@empirica/core/player/classic/react";

const SHOW_RECOVERY_AFTER_MS = 12_000;
// DELIBRA-PATCH (2026-08-20): after this many seconds of being stuck, force
// window.location.reload(). Matches the existing watchdog
// (infra/watchdog/tajriba-watchdog.js, 8 s on the server). 25 s here keeps
// the participant one short-watchdog cycle ahead of the host-cron restart.
const AUTO_RELOAD_AFTER_MS = 25_000;

export function ConnectionRecovery() {
  const game = useGame();
  const player = usePlayer();
  const round = useRound();
  const stage = useStage();
  const [showRecovery, setShowRecovery] = useState(false);
  const [online, setOnline] = useState(() => navigator.onLine);
  const [secondsWaiting, setSecondsWaiting] = useState(0);
  const [autoReloadArmed, setAutoReloadArmed] = useState(true);

  useEffect(() => {
    const timer = window.setTimeout(
      () => setShowRecovery(true),
      SHOW_RECOVERY_AFTER_MS,
    );
    const updateOnline = () => setOnline(navigator.onLine);
    window.addEventListener("online", updateOnline);
    window.addEventListener("offline", updateOnline);

    // DELIBRA-PATCH: count up seconds so the participant sees progress
    // even while the network/WS layer is silently silent.
    const tick = window.setInterval(() => {
      setSecondsWaiting((s) => s + 1);
    }, 1000);

    // DELIBRA-PATCH: automatic hard reload after AUTO_RELOAD_AFTER_MS. This
    // is the participant-side mirror of the server-side Tajriba watchdog
    // (which restarts the container every ~5 min on freeze). A reload here
    // gives the participant a fresh WS and clears any sessionParticipant
    // / _connecting deadlocks we patched in chunk-UMPSA52E.js.
    const reloadTimer = window.setTimeout(() => {
      if (autoReloadArmed) {
        console.warn(
          "[delibra-recovery] auto-reload after",
          AUTO_RELOAD_AFTER_MS / 1000,
          "s of being stuck",
        );
        window.location.reload();
      }
    }, AUTO_RELOAD_AFTER_MS);

    return () => {
      window.clearTimeout(timer);
      window.clearTimeout(reloadTimer);
      window.clearInterval(tick);
      window.removeEventListener("online", updateOnline);
      window.removeEventListener("offline", updateOnline);
    };
  }, [autoReloadArmed]);

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

        {/* DELIBRA-PATCH: live waiting-time counter so the participant can
            tell the difference between an actively-reconnecting state and a
            real freeze. */}
        <p className="mt-2 text-sm text-gray-500">
          {secondsWaiting > 0
            ? `Reconnecting for ${secondsWaiting}s…`
            : null}
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
            <label className="mt-3 block text-sm text-gray-700">
              <input
                type="checkbox"
                className="mr-2"
                checked={autoReloadArmed}
                onChange={(e) => setAutoReloadArmed(e.target.checked)}
              />
              Auto-reload in {Math.max(
                0,
                Math.ceil((AUTO_RELOAD_AFTER_MS / 1000) - secondsWaiting),
              )}s
              (uncheck to keep this page open while you read the message)
            </label>
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
