import {
  useGame,
  useStage,
  useStageTimer,
} from "@empirica/core/player/classic/react";
import React, { useEffect, useState } from "react";

export function Timer() {
  const timer = useStageTimer();
  const game = useGame();
  const stage = useStage();
  const stageName = stage?.get("name");
  const discussionDeadline = ["Task", "Discussion"].includes(stageName)
    ? game?.get("deadline")
    : null;
  const [now, setNow] = useState(Date.now());

  // Empirica's stage-timer hook can briefly remain undefined when a client
  // enters a later round. The server-owned Discussion deadline is written at
  // onStageStart and is the same clock used by facilitator timing, so use it
  // only as a display fallback until/if the native timer becomes available.
  useEffect(() => {
    if (!Number.isFinite(discussionDeadline)) return undefined;
    setNow(Date.now());
    const interval = setInterval(() => setNow(Date.now()), 250);
    return () => clearInterval(interval);
  }, [discussionDeadline]);

  let remaining;
  if (timer?.remaining || timer?.remaining === 0) {
    remaining = Math.round(timer?.remaining / 1000);
  } else if (Number.isFinite(discussionDeadline)) {
    remaining = Math.max(0, Math.ceil((discussionDeadline - now) / 1000));
  }

  return (
    <div className="flex flex-col items-center">
      <h1 className="tabular-nums text-3xl text-gray-500 font-semibold">
        {humanTimer(remaining)}
      </h1>
    </div>
  );
}

function humanTimer(seconds) {
  if (seconds === null || seconds === undefined) {
    return "--:--";
  }

  let out = "";
  const s = seconds % 60;
  out += s < 10 ? "0" + s : s;

  const min = (seconds - s) / 60;
  if (min === 0) {
    return `00:${out}`;
  }

  const m = min % 60;
  out = `${m < 10 ? "0" + m : m}:${out}`;

  const h = (min - m) / 60;
  if (h === 0) {
    return out;
  }

  return `${h}:${out}`;
}
