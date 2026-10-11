import React, { useEffect, useMemo, useRef, useState } from "react";
import { usePlayer, usePlayers, useRound, useStage } from "@empirica/core/player/classic/react";
import {
  SHARED_BREAK_READY_WINDOW_SECONDS,
  canConfirmSharedBreak,
} from "../../../shared/personalFlow.mjs";

export function remainingBreakSeconds(deadline, now) {
  return Number.isFinite(deadline) ? Math.max(0, Math.ceil((deadline - now) / 1000)) : null;
}

export function Break({ progress }) {
  const player = usePlayer();
  const players = usePlayers();
  const round = useRound();
  const stage = useStage();
  const deadline = round?.get("sharedBreakDeadline");
  const arrivalCount = round?.get("sharedBreakArrivalCount") ?? 0;
  const requiredCount = round?.get("sharedBreakRequiredCount") ?? players.length;
  const readyCount = round?.get("sharedBreakReadyCount") ?? 0;
  const ready = player.round?.get("sharedBreakReadyStatus") === "ready";
  const [now, setNow] = useState(Date.now());
  const [requesting, setRequesting] = useState(false);
  const requestStartedAt = useRef(0);
  const remaining = remainingBreakSeconds(deadline, now);
  const canConfirm = canConfirmSharedBreak(deadline, now);

  const send = (action = "sync") => player.set("sharedBreakRequest", {
    action,
    requestId: globalThis.crypto?.randomUUID?.() ?? `${player.id}-${Date.now()}`,
    roundId: round.id,
    stageId: stage.id,
    index: progress.index,
    requestedAt: Date.now(),
  });

  useEffect(() => {
    setNow(Date.now());
    const clock = setInterval(() => setNow(Date.now()), 250);
    return () => clearInterval(clock);
  }, []);

  useEffect(() => {
    send("sync");
    // Re-check persisted state after reconnect or a callbacks restart. The
    // server remains the only authority that starts or completes the break.
    const sync = setInterval(() => send("sync"), 2000);
    return () => clearInterval(sync);
  }, [player, round.id, stage.id, progress.index]);

  useEffect(() => {
    if (ready) setRequesting(false);
    const rejectedAt = player.round?.get("sharedBreakReadyRejectedAt") ?? 0;
    if (requestStartedAt.current > 0 && rejectedAt >= requestStartedAt.current) setRequesting(false);
  }, [ready, player.round?.get("sharedBreakReadyRejectedAt")]);

  const formatted = useMemo(() => {
    if (remaining === null) return "--:--";
    return `${String(Math.floor(remaining / 60)).padStart(2, "0")}:${String(remaining % 60).padStart(2, "0")}`;
  }, [remaining]);

  const confirm = () => {
    if (!canConfirm || ready || requesting) return;
    requestStartedAt.current = Date.now();
    setRequesting(true);
    send("ready");
  };

  return (
    <main className="flex h-full items-center justify-center bg-gray-50 px-4 py-8 text-center">
      <section className="w-full max-w-2xl rounded-lg border border-gray-200 bg-white p-8 shadow-sm">
        <h1 className="text-2xl font-bold text-gray-900">Break</h1>
        {!Number.isFinite(deadline) ? (
          <>
            <p className="mt-6 text-gray-700">Please wait for the other group members before the break starts.</p>
            <p className="mt-3 text-sm text-gray-600">{arrivalCount} of {requiredCount} group members are ready for the break.</p>
            <button type="button" disabled className="mt-6 rounded-md bg-blue-700 px-5 py-3 font-semibold text-white opacity-50">
              I'm back and ready to continue
            </button>
          </>
        ) : (
          <>
            <div className="mt-6 text-5xl font-bold tabular-nums text-blue-800" role="timer" aria-label={`${formatted} remaining`}>{formatted}</div>
            {!ready && <p className="mt-6 text-gray-700">Please take a five-minute break. You can confirm that you are back during the final {SHARED_BREAK_READY_WINDOW_SECONDS} seconds.</p>}
            {!ready && <button type="button" onClick={confirm} disabled={!canConfirm || requesting}
              className="mt-6 rounded-md bg-blue-700 px-5 py-3 font-semibold text-white hover:bg-blue-800 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-blue-700 disabled:cursor-not-allowed disabled:opacity-50">
              I'm back and ready to continue
            </button>}
            {ready && remaining > 0 && <p className="mt-6 rounded-md bg-green-50 p-4 font-semibold text-green-800">You're ready. Please wait for the break to end.</p>}
            {ready && remaining === 0 && <p className="mt-6 rounded-md bg-green-50 p-4 font-semibold text-green-800">You're ready. Waiting for the others.</p>}
            {!ready && remaining === 0 && <p className="mt-4 font-semibold text-amber-800">The break has ended. Please confirm that you are ready to continue.</p>}
            <p className="mt-4 text-sm text-gray-600">{readyCount} of {requiredCount} group members have confirmed.</p>
          </>
        )}
      </section>
    </main>
  );
}
