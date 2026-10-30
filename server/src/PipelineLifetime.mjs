import { AsyncLocalStorage } from "node:async_hooks";
const scope = new AsyncLocalStorage();
const active = new Map();
export function cancelStagePipelines(stageId) {
  for (const entry of active.values()) if (entry.stageId === stageId) entry.controller.abort();
}
export async function withPipelineLifetime(game, run) {
  const stageId = game.currentStage?.id;
  const controller = new AbortController();
  const configured = Number(process.env.LLM_CHAIN_TIMEOUT_MS);
  const cap = Number.isFinite(configured) && configured > 0 ? configured : 90_000;
  const deadline = game.currentRound?.get("isPractice") ? game.currentRound.get("practiceDeadline") : game.get("deadline");
  const expiresAt = Math.min(Date.now() + cap, Number.isFinite(deadline) ? deadline : Infinity);
  const key = Symbol();
  const entry = { controller, expiresAt, stageId, game };
  active.set(key, entry);
  const timer = setTimeout(() => controller.abort(), Math.max(1, expiresAt - Date.now()));
  timer.unref?.();
  try { return await scope.run(entry, run); }
  finally { clearTimeout(timer); active.delete(key); }
}
export function pipelineOptions(options = {}) {
  const entry = scope.getStore();
  if (!entry) return options;
  if (entry.game.currentStage?.id !== entry.stageId || entry.game.currentStage?.get("ended")
    || entry.game.get("ended") || Date.now() >= entry.expiresAt) entry.controller.abort();
  return { ...options, signal: entry.controller.signal,
    timeoutMs: Math.max(1, Math.min(options.timeoutMs ?? Infinity, entry.expiresAt - Date.now())) };
}

export function delayWithinPipeline(ms) {
  const signal = scope.getStore()?.controller.signal;
  return new Promise((resolve, reject) => {
    let timer;
    const finish = error => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
      if (error) reject(error); else resolve();
    };
    const abort = () => finish(new Error("Facilitator pipeline cancelled"));
    if (signal?.aborted) { abort(); return; }
    signal?.addEventListener("abort", abort, { once: true });
    timer = setTimeout(() => finish(), ms);
  });
}
