import React, { useEffect, useMemo, useRef, useState } from "react";
import { usePlayer, usePlayers, useRound, useStage } from "@empirica/core/player/classic/react";

function remainingSeconds(endAt, now) {
  return Math.max(0, Math.ceil((endAt - now) / 1000));
}

export function Break() {
  const player = usePlayer();
  const players = usePlayers();
  const round = useRound();
  const stage = useStage();
  const scheduledEnd = round?.get("breakScheduledEndAt");
  const [now, setNow] = useState(Date.now());
  const [requesting, setRequesting] = useState(false);
  const readyRequestAt = useRef(0);
  const advanceRequested = useRef(false);
  const ready = player.round?.get("breakReadyStatus") === "ready";
  const derivedReadyCount = players.filter((participant) => participant.round?.get("breakReadyStatus") === "ready").length;
  const readyCount = round?.get("breakReadyCount") ?? derivedReadyCount;
  const requiredCount = round?.get("breakRequiredCount") ?? players.length;
  const allReady = round?.get("breakAllReady") === true || (requiredCount > 0 && readyCount === requiredCount);
  const remaining = Number.isFinite(scheduledEnd) ? remainingSeconds(scheduledEnd, now) : null;
  const canConfirm = remaining !== null && remaining <= 45;

  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);

  useEffect(() => {
    if (remaining !== 0 || !ready || !allReady || advanceRequested.current) return;
    advanceRequested.current = true;
    player.set("breakAdvanceRequest", {
      requestId: globalThis.crypto?.randomUUID?.() ?? `${player.id}-${Date.now()}`,
      roundId: round?.id,
      stageId: stage.id,
      requestedAt: Date.now(),
    });
  }, [allReady, player, ready, remaining, round?.id, stage.id]);

  useEffect(() => {
    const rejectedAt = player.round?.get("breakReadyRejectedAt") ?? 0;
    if (rejectedAt >= readyRequestAt.current && readyRequestAt.current > 0) setRequesting(false);
  }, [player.round?.get("breakReadyRejectedAt")]);

  const formatted = useMemo(() => {
    if (remaining === null) return "--:--";
    return `${String(Math.floor(remaining / 60)).padStart(2, "0")}:${String(remaining % 60).padStart(2, "0")}`;
  }, [remaining]);

  const confirm = () => {
    if (!canConfirm || ready || requesting) return;
    readyRequestAt.current = Date.now();
    setRequesting(true);
    player.set("breakReadyRequest", `${round.id}:${readyRequestAt.current}`);
  };

  return (
    <div className="flex h-full w-full items-center justify-center bg-gray-50 px-4 py-8">
      <main className="w-full max-w-2xl rounded-lg border border-gray-200 bg-white p-8 text-center shadow-sm">
        <h1 className="text-2xl font-bold text-gray-900">Break</h1>
        <div className="mt-6 text-5xl font-bold tabular-nums text-blue-800" aria-live="polite">{formatted}</div>
        {!canConfirm && <><p className="mt-6 text-gray-700">Please take a short break.</p><p className="mt-2 text-gray-700">Please return before the countdown ends. A confirmation button will appear during the final 45 seconds.</p></>}
        {canConfirm && !ready && <><p className="mt-6 text-gray-700">Please confirm that you are back. The second task will begin once the break has ended and all group members are ready.</p>{remaining === 0 && <p className="mt-3 font-semibold text-amber-800">The break has ended. Please confirm that you are ready to continue.</p>}<button type="button" onClick={confirm} disabled={requesting} className="ml-0 mt-6 rounded-md bg-blue-700 px-5 py-3 font-semibold text-white hover:bg-blue-800 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-blue-700 disabled:opacity-60">I’m back and ready to continue</button></>}
        {ready && !allReady && <p className="mt-6 rounded-md bg-green-50 p-4 font-semibold text-green-800">Ready. Waiting for the other group members ({readyCount} of {requiredCount}).</p>}
        {ready && allReady && remaining > 0 && <p className="mt-6 rounded-md bg-green-50 p-4 font-semibold text-green-800">Everyone is ready. The second task will begin when the countdown ends.</p>}
        {ready && allReady && remaining === 0 && <p className="mt-6 rounded-md bg-green-50 p-4 font-semibold text-green-800">Everyone is ready. Starting the second task…</p>}
      </main>
    </div>
  );
}

export { remainingSeconds };
