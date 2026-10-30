// The native stage timer is primary. This independent, server-clock fallback
// handles a missed native transition, including restored, already-expired stages.
export function createDiscussionDeadline({ flush = () => {}, now = () => Date.now(),
  setTimer = (...args) => setTimeout(...args), clearTimer = clearTimeout, onError = console.error, onEnd = () => {} } = {}) {
  const timers = new Map();
  function cancel(game) {
    const entry = timers.get(game.id);
    if (entry) clearTimer(entry.timer);
    timers.delete(game.id);
  }
  function recover(game, roundId, stageId) {
    const stage = game.currentStage;
    if (game.currentRound?.id !== roundId || stage?.id !== stageId || stage.get("name") !== "Task"
      || stage.get("ended") || game.currentRound.get("ended") || game.get("ended") || game.get("endedAt")) return false;
    const deadline = game.get("deadline");
    if (!Number.isFinite(deadline) || now() < deadline) return false;
    game.set("discussionAdvanceCommittedStageId", stage.id);
    stage.set("ended", true);
    onEnd(stage);
    Promise.resolve().then(flush).catch(onError);
    return true;
  }
  function register(game) {
    const stage = game.currentStage, round = game.currentRound, deadline = game.get("deadline");
    if (!stage || stage.get("name") !== "Task" || round?.get("isPractice") || stage.get("ended")
      || round?.get("ended") || game.get("ended") || game.get("endedAt") || !Number.isFinite(deadline)) { cancel(game); return; }
    const old = timers.get(game.id);
    if (old?.stageId === stage.id && old.deadline === deadline) return;
    cancel(game);
    const entry = { stageId: stage.id, deadline };
    const tick = () => {
      if (timers.get(game.id) !== entry) return;
      if (game.currentStage?.id !== stage.id || stage.get("ended")) { cancel(game); return; }
      if (now() >= deadline + 1000) {
        recover(game, round.id, stage.id);
        cancel(game);
      } else {
        entry.timer = setTimer(tick, Math.min(1000, Math.max(1, deadline + 1000 - now())));
        entry.timer?.unref?.();
      }
    };
    timers.set(game.id, entry);
    entry.timer = setTimer(tick, Math.max(0, deadline + 1000 - now()));
    entry.timer?.unref?.();
  }
  return { register, recover, cancel };
}
