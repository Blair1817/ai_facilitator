import React, { useEffect, useRef, useState } from "react";
import { useGame, usePlayer, useRound, useStage } from "@empirica/core/player/classic/react";
import { isTestGame, testPersonalState, testControlDestinations, testPageLabel } from "../../../shared/testMode.mjs";

const ACTION_LABELS = { previous: "Previous page (you)", skip_page: "Skip page (you)", next_stage: "Next stage (group)", skip_break: "Skip break (group)" };
const REJECTION_MESSAGES = {
  invalid_request: "The request was invalid. Please try again.", not_authorized: "Controls are only available in test sessions.",
  stale_stage: "The stage has already changed. Check your current location.", stale_progress: "Progress has changed. Please try again.",
  not_personal_page: "There is no personal page to skip here.", use_shared_break_control: "Use Skip break once all three participants have arrived.",
  page_boundary: "There is no page in that direction within this personal flow.", break_not_ready: "Wait until all three participants have reached the shared break.",
};
function resultMessage(result) {
  if (result.status !== "accepted") return REJECTION_MESSAGES[result.reason] ?? "The action could not be completed. Please try again.";
  return result.destination ? `Action completed. Destination: ${result.destination}.` : "Action completed. Check your current location.";
}
export function TestControlPanel() {
  const game = useGame(), player = usePlayer(), round = useRound(), stage = useStage();
  const [open, setOpen] = useState(false);
  const [pending, setPending] = useState(null);
  const pendingRef = useRef(null);
  const result = player?.get("testControlResult");
  const stageId = stage?.id;
  useEffect(() => {
    if (!pending) return undefined;
    if (result?.requestId === pending.requestId || stageId !== pending.stageId) {
      pendingRef.current = null; setPending(null); return undefined;
    }
    const retry = setInterval(() => player.set("testControlRequest", { ...pending, attempt: Date.now() }), 2000);
    return () => clearInterval(retry);
  }, [pending, result, stageId, player]);
  if (!player?.round || !round || !stage || !isTestGame(game) || game.get("ended") || stage.get("ended")) return null;
  const state = testPersonalState(player, round, stage);
  const page = state.pages[state.index];
  const destinations = testControlDestinations(round, stage, state);
  const last = game.get("testControlLastResult");
  function send(action) {
    if (pendingRef.current) return;
    if (action === "next_stage" && !window.confirm(`This affects all three participants. End the current stage and move to ${destinations.next_stage}?`)) return;
    const request = { requestId: crypto.randomUUID(), action, gameId: game.id, roundId: round.id,
      stageId: stage.id, index: state.index, version: state.version, stageVersion: stage.get("testControlVersion") || 0 };
    pendingRef.current = request; setPending({ ...request, destination: destinations[action] });
    player.set("testControlRequest", request);
  }
  const canSkipBreak = stage.get("name") === "Followup" && round.get("taskIndex") === 0
    && round.get("sharedBreakArrivalCount") === 3 && Number.isFinite(round.get("sharedBreakDeadline"))
    && !round.get("sharedBreakCompletedAt");
  const location = `${round.get("name") || (round.get("isPractice") ? "Practice" : `Round ${(round.get("taskIndex") ?? 0) + 1}`)} · ${testPageLabel(stage.get("name"))}`;
  const buttonClass = "rounded border border-amber-400 bg-white px-3 py-2 text-left text-sm disabled:opacity-40";
  return <aside className="flex-none max-h-[35vh] w-full overflow-auto rounded-xl border-2 border-amber-500 bg-amber-50 p-3 text-gray-900 shadow-xl" aria-label="Test controls">
    <button className="w-full text-left font-bold" type="button" aria-expanded={open} onClick={() => setOpen(!open)}>Test mode · {open ? "Collapse controls" : "Expand controls"}</button>
    {open && <div className="mt-3 space-y-3">
      <p className="text-sm">Current location: {location}<br />Your page: {page ? testPageLabel(page) : state.pages.length ? "Waiting for other participants" : testPageLabel(stage.get("name"))}</p>
      <p className="text-xs">Original timers stay active. Skipping does not generate answers. Previous page only works within your current personal flow.</p>
      <div className="flex flex-wrap gap-2">
        <button type="button" className={buttonClass} disabled={!!pending || !state.pages.length || state.index === 0} onClick={() => send("previous")}>{ACTION_LABELS.previous}{destinations.previous && <> → {destinations.previous}</>}</button>
        <button type="button" className={buttonClass} disabled={!!pending || !page || (page === "Break" && !round.get("sharedBreakCompletedAt"))} onClick={() => send("skip_page")}>{ACTION_LABELS.skip_page}{page && <> → {destinations.skip_page}</>}</button>
      </div>
      <div className="flex flex-wrap gap-2">
        <button type="button" className={buttonClass} disabled={!!pending} onClick={() => send("next_stage")}>{ACTION_LABELS.next_stage} → {destinations.next_stage}</button>
        <button type="button" className={buttonClass} disabled={!!pending || !canSkipBreak} onClick={() => send("skip_break")}>{ACTION_LABELS.skip_break} → {destinations.skip_break}</button>
      </div>
      <p className="text-xs">Group controls affect all three participants. Pausing and returning to earlier stages are unavailable.</p>
      <p role="status" className="text-sm">{pending ? `Moving to ${pending.destination}… Waiting for server confirmation.` : result ? resultMessage(result) : "No test action yet."}</p>
      {last && <p className="text-xs">Latest session action: {ACTION_LABELS[last.action] ?? "Test action"}. {resultMessage(last)}</p>}
    </div>}
  </aside>;
}
