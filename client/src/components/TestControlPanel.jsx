import React, { useEffect, useRef, useState } from "react";
import { useGame, usePlayer, useRound, useStage } from "@empirica/core/player/classic/react";
import { isTestGame, testPersonalState } from "../../../shared/testMode.mjs";

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
  const last = game.get("testControlLastResult");
  function send(action) {
    if (pendingRef.current) return;
    if (action === "next_stage" && !window.confirm("影响全组三人：结束当前阶段并进入下一阶段？")) return;
    const request = { requestId: crypto.randomUUID(), action, gameId: game.id, roundId: round.id,
      stageId: stage.id, index: state.index, version: state.version, stageVersion: stage.get("testControlVersion") || 0 };
    pendingRef.current = request; setPending(request);
    player.set("testControlRequest", request);
  }
  const canSkipBreak = stage.get("name") === "Followup" && round.get("taskIndex") === 0
    && round.get("sharedBreakArrivalCount") === 3 && Number.isFinite(round.get("sharedBreakDeadline"))
    && !round.get("sharedBreakCompletedAt");
  const buttonClass = "rounded border border-amber-400 bg-white px-3 py-2 text-sm disabled:opacity-40";
  return <aside className="fixed bottom-4 right-4 z-50 max-h-[80vh] w-80 max-w-[calc(100vw-2rem)] overflow-auto rounded-xl border-2 border-amber-500 bg-amber-50 p-3 text-gray-900 shadow-xl" aria-label="测试控制">
    <button className="w-full text-left font-bold" type="button" aria-expanded={open} onClick={() => setOpen(!open)}>测试模式 · {open ? "收起" : "展开控制"}</button>
    {open && <div className="mt-3 space-y-3">
      <p className="text-sm">{round.get("name")} · {stage.get("name")}<br />个人页面：{page || "等待其他参与者"}</p>
      <p className="text-xs">保留原计时；跳过不会生成答案。上一页仅限当前个人流程。</p>
      <div className="flex gap-2">
        <button type="button" className={buttonClass} disabled={!!pending || !state.pages.length || state.index === 0} onClick={() => send("previous")}>上一页（自己）</button>
        <button type="button" className={buttonClass} disabled={!!pending || !page || (page === "Break" && !round.get("sharedBreakCompletedAt"))} onClick={() => send("skip_page")}>跳过本页（自己）</button>
      </div>
      <div className="flex gap-2">
        <button type="button" className={buttonClass} disabled={!!pending} onClick={() => send("next_stage")}>全组下一阶段</button>
        <button type="button" className={buttonClass} disabled={!!pending || !canSkipBreak} onClick={() => send("skip_break")}>跳过休息（全组）</button>
      </div>
      <p className="text-xs">全组操作影响三人。暂停和跨阶段返回不在本版中。</p>
      <p role="status" className="text-sm">{pending ? "处理中，等待服务端确认…" : result ? `${result.status}: ${result.reason}` : "尚未操作"}</p>
      {last && <p className="text-xs">全组最近操作：{last.action} · {last.status}</p>}
    </div>}
  </aside>;
}
