import { ADAPTIVE_FLOOR_MS } from "./AdaptiveRecovery.mjs";

/** Timers contain no model policy. The callback acquires the same durable
 * automatic lock as message checkpoints. Pending events survive cooldown,
 * stale context and in-flight work; completed thresholds persist per round. */
export function createCloseoutScheduler({ run, now = () => Date.now(), setTimer = (...args) => setTimeout(...args), clearTimer = handle => clearTimeout(handle), flush = () => {}, onError = () => {} }) {
  const entries = new Map();
  function cancel(game, reason = "stage_ended") {
    const e = entries.get(game.id);
    if (!e) return;
    clearTimer(e.timer);
    e.round.set("adaptiveCloseoutSchedule", { ...e.state, cancelled: { reason, timestamp: now() } });
    Promise.resolve(flush()).catch(onError);
    entries.delete(game.id);
  }
  const current = e => e.game.currentRound?.id === e.round.id && e.game.currentStage?.id === e.stage.id
    && e.stage.get("name") === "Task" && !e.stage.get("ended") && !e.round.get("ended") && !e.game.get("ended") && !e.game.get("endedAt");
  function save(e) { e.round.set("adaptiveCloseoutSchedule", { ...e.state }); return Promise.resolve(flush()); }
  function schedule(e, delay) {
    clearTimer(e.timer);
    e.timer = setTimer(() => tick(e), Math.max(0, delay));
    e.timer?.unref?.();
  }
  async function tick(e) {
    if (entries.get(e.game.id) !== e) return;
    if (!current(e)) { cancel(e.game, "round_or_stage_changed"); return; }
    const left = e.game.get("deadline") - now();
    if (left <= ADAPTIVE_FLOOR_MS) { cancel(e.game, "adaptive_20s_floor"); return; }
    for (const seconds of [180, 120]) {
      if (left <= seconds * 1000 && !e.state.completed?.[seconds]) e.pending.add(`time_${seconds}`);
    }
    if (e.busy) return;
    if (e.pending.size) {
      const lastAttempt = e.game.get("lastAttemptTimestamp") || 0;
      const cooldown = lastAttempt > 0 ? Math.max(0, lastAttempt + 30_000 - now()) : 0;
      if (cooldown) { schedule(e, Math.min(cooldown, left - ADAPTIVE_FLOOR_MS)); return; }
      const sources = [...e.pending];
      // Remove only this snapshot: a new message during await stays pending.
      sources.forEach(s => e.pending.delete(s));
      e.busy = true;
      let outcome;
      try { outcome = await run(e.game, { triggerSource: sources.find(s => s.startsWith("time_")) ?? "early_closeout_probe", triggerSources: sources }); }
      catch (error) { onError(error); outcome = { deferred: true }; }
      finally { e.busy = false; }
      if (entries.get(e.game.id) !== e) return;
      if (!current(e)) { cancel(e.game, "round_or_stage_changed"); return; }
      if (outcome?.deferred) sources.forEach(s => e.pending.add(s));
      else {
        e.state.completed ??= {};
        for (const source of sources) if (source.startsWith("time_")) e.state.completed[source.slice(5)] = { timestamp: now(), outcome: outcome?.outcome ?? "assessed" };
        e.state.lastAssessment = { timestamp: now(), sources };
        await save(e);
      }
    }
    const remaining = e.game.get("deadline") - now();
    if (remaining <= ADAPTIVE_FLOOR_MS) { cancel(e.game, "adaptive_20s_floor"); return; }
    // A long evaluation can cross the second threshold while its timer is
    // occupied. Queue that event now instead of sleeping until the floor.
    for (const seconds of [180, 120]) if (remaining <= seconds * 1000 && !e.state.completed?.[seconds]) e.pending.add(`time_${seconds}`);
    const delays = [remaining - ADAPTIVE_FLOOR_MS];
    for (const seconds of [180, 120]) if (!e.state.completed?.[seconds] && remaining > seconds * 1000) delays.push(remaining - seconds * 1000);
    if (e.pending.size) delays.push(Math.max(1000, (e.game.get("lastAttemptTimestamp") || 0) + 30_000 - now()));
    schedule(e, Math.min(...delays));
  }
  function register(game) {
    const round = game.currentRound, stage = game.currentStage, deadline = game.get("deadline");
    if (round?.get("facilitation") !== "adaptive" || round.get("isPractice") || stage?.get("name") !== "Task" || !Number.isFinite(deadline)) return;
    const old = entries.get(game.id);
    if (old?.round.id === round.id && old.stage.id === stage.id && old.deadline === deadline) return old;
    if (old) cancel(game, "registration_replaced");
    const stored = round.get("adaptiveCloseoutSchedule");
    const state = stored?.stageId === stage.id && stored.deadline === deadline ? { ...stored } : { stageId: stage.id, deadline, completed: {} };
    delete state.cancelled;
    const e = { game, round, stage, deadline, state, pending: new Set(), busy: false, timer: null };
    entries.set(game.id, e);
    save(e).catch(onError);
    schedule(e, 0);
    return e;
  }
  return { register, cancel,
    request(game) {
      const e = register(game);
      if (!e) return;
      e.pending.add("early_closeout_probe");
      if (!e.busy) schedule(e, 0);
    },
    // Useful at the end of a foreground checkpoint: lets queued closeout
    // work retry under the cooldown without starting a parallel chain.
    resume(game) { const e = entries.get(game.id); if (e && !e.busy && e.pending.size) schedule(e, 0); },
  };
}
