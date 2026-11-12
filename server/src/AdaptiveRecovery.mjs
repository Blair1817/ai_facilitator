// One budget per automatic Adaptive evaluation, including Static fallback.
// Static-condition and participant-requested pipelines do not use this budget.
export const ADAPTIVE_FLOOR_MS = 20_000;
export const ADAPTIVE_CHAIN_MS = 90_000;
export function createAdaptiveBudget({ now = Date.now, deadline, isCurrent, log = {} }) {
  const expiresAt = Math.min(now() + ADAPTIVE_CHAIN_MS, deadline() - ADAPTIVE_FLOOR_MS);
  // 2026-11-11: a failed Specialist goes straight to the Static policy (no
  // Specialist repair, no reselection); Static keeps its own single repair.
  const limits = { assessorRepair: 1, generatorRepair: 0, staticRepair: 1 };
  const counts = Object.fromEntries(Object.keys(limits).map(k => [k, 0]));
  const calls = [];
  log.recovery = { limits, counts, calls, expiresAt, maxModelCalls: 13 };
  function check() {
    const remainingTimeMs = deadline() - now();
    const reason = !isCurrent() ? "discussion_context_changed" : remainingTimeMs <= ADAPTIVE_FLOOR_MS
      ? "adaptive_20s_floor" : now() >= expiresAt ? "chain_time_budget" : null;
    if (reason) log.cancellation = { reason, remainingTimeMs, timestamp: now() };
    return !reason;
  }
  return {
    counts, calls, check,
    remainingTime: () => deadline() - now(),
    take(kind) {
      if (!check() || counts[kind] >= limits[kind]) return false;
      counts[kind]++;
      return true;
    },
    async call(kind, invoke, repairKind = null) {
      if (calls.length >= 13) { log.cancellation = { reason: "model_call_budget", timestamp: now() }; return { success: false, error: "Model call budget exhausted" }; }
      if (!check() || (repairKind && !this.take(repairKind))) return { success: false, error: "Adaptive recovery/time/lifecycle budget unavailable" };
      const record = { kind, repairKind, timestamp: now(), remainingTimeMs: deadline() - now() };
      calls.push(record);
      // Transport aborts at this deadline; every subsequent call rechecks it.
      const timeoutMs = Math.max(1, Math.min(expiresAt, deadline() - ADAPTIVE_FLOOR_MS) - now());
      try {
        const result = await invoke({ timeoutMs });
        record.success = result.success;
        return result;
      } finally { record.elapsedMs = now() - record.timestamp; }
    },
  };
}

/** One selection, one Specialist attempt. No need, an invalid candidate or any
 * Specialist failure returns to the same Static policy. A closeout-only empty
 * scan does not create a timed Static turn. */
export async function runAdaptiveSelection({ generate, fallback, budget, log, initial, closeoutOnly = false }) {
  const selection = initial;
  if (!budget.check()) return { published: false };
  // The explicit participant-summary pause applies to every scan.
  if (selection?.defer) { log.reason = "participant_summary_in_progress"; return { published: false }; }
  if (!selection?.role && closeoutOnly) {
    log.reason = "closeout_no_qualified_integration";
    log.gateDecision = "abstain";
    log.gateReason = log.reason;
    log.abstentionKind = log.reason;
    delete log.fallbackKind;
    return { published: false };
  }
  if (selection?.role) {
    const result = await generate(selection);
    if (result.published) return result;
    log.specialistFailures = [{ selection, ...result }];
    log.specialistFailure = { selection, ...result };
  }
  if (!budget.check()) return { published: false };
  if (log.specialistFailures?.length) log.fallbackRoute = "SPECIALIST_TO_STATIC_POLICY";
  const result = await fallback();
  log.fallbackPublished = result.published;
  log.fallbackOutcome = result.outcome ?? (result.published ? "PUBLISHED" : "SILENT");
  return result;
}
