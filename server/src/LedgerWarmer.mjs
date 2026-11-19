/** Background warm-up of the Synthesiser's per-message ledger (2026-11-19).
 *
 * The ledger (SynthesisLedger.mjs) caches each confirmed message entry on the
 * Round. Without a warm-up, the first Synthesiser turn extracted every message
 * of the round at once (24.5 s for 34 messages in the 2026-11-18 pilot) while
 * the group waited. The warm-up extracts new participant messages as they
 * arrive, so the Synthesiser only has the last few left to do.
 *
 * Each Round has one lane. Warm-up passes and the Synthesiser's own ledger
 * builds run through it one at a time, so they never extract the same message
 * twice. Messages that arrive while a pass is queued are covered by that pass
 * (it reads the chat when it starts); one arriving while a pass runs queues
 * exactly one more. A failed pass caches nothing, so the Synthesiser falls back
 * to extracting those messages itself, as before.
 *
 * The Synthesiser never waits for a warm-up (review 2026-11-19): its build
 * preempts the lane, aborting the running pass and any queued one, and then
 * extracts whatever is still uncached itself, inside its own time budget.
 */
import { ledgerSources, UNCLEAR_OPTION } from "./SynthesisLedger.mjs";

export function createLedgerWarmer({ onError = () => {} } = {}) {
  const lanes = new Map();
  const lane = key => {
    if (!lanes.has(key)) lanes.set(key, { tail: Promise.resolve(), queuedWarm: null, controllers: new Set() });
    return lanes.get(key);
  };
  const enqueue = (key, run) => {
    const l = lane(key);
    const result = l.tail.then(() => run());
    l.tail = result.catch(() => {});
    return result;
  };
  return {
    /** Queue a warm-up pass unless one is already waiting to start. Never
     * rejects. `pass(signal)` should stop promptly once `signal` is aborted. */
    warm(key, pass) {
      const l = lane(key);
      if (l.queuedWarm) return l.queuedWarm;
      const controller = new AbortController();
      l.controllers.add(controller);
      const queued = enqueue(key, () => {
        l.queuedWarm = null;
        return controller.signal.aborted ? null : pass(controller.signal);
      }).catch(error => { onError(error, key); return null; })
        .finally(() => l.controllers.delete(controller));
      l.queuedWarm = queued;
      return queued;
    },
    /** Run `run` with no pass running alongside it. With `preempt`, the running
     * and queued warm-up passes are aborted first instead of waited for. */
    exclusive(key, run, { preempt = false } = {}) {
      const l = lane(key);
      if (preempt) { for (const controller of l.controllers) controller.abort(); l.queuedWarm = null; }
      return enqueue(key, run);
    },
    forget(key) { lanes.delete(key); },
  };
}

/** Merge ledger caches. Entries in `update` win; any entry whose message text no
 * longer matches the chat is dropped by buildSynthesisLedger itself. */
export function mergeLedgerCache(base, update) {
  return { ...(base || {}), ...(update || {}) };
}

/** A cache copy without the round's latest participant message, so a
 * Synthesiser build always makes one extraction call: that call is what
 * proposes the scoreboard's closing question. */
export function withoutLatestSource(cache, chat) {
  const latest = ledgerSources(chat).at(-1)?.messageId;
  if (!latest || !cache?.[latest]) return cache || {};
  const { [latest]: _dropped, ...rest } = cache;
  return rest;
}

/** The cache a Synthesiser build starts from: without the latest message (for
 * the closing question) and without entries whose option was Unclear. A
 * warm-up extracts a message when it arrives, before any later clarification
 * ("that was Halden"); the Synthesiser sees the whole round and judges those
 * again (review 2026-11-19). */
export function cacheForSynthesis(cache, chat) {
  const base = withoutLatestSource(cache, chat);
  const kept = {};
  for (const [id, hit] of Object.entries(base)) {
    if (!(hit?.entry?.points || []).some(point => point?.option === UNCLEAR_OPTION)) kept[id] = hit;
  }
  return kept;
}

/** Cumulative, content-free warm-up counters kept on the Round. */
export function addWarmStats(previous, pass) {
  const p = previous || {};
  return {
    passes: (p.passes || 0) + 1,
    modelCalls: (p.modelCalls || 0) + pass.modelCalls,
    failedCalls: (p.failedCalls || 0) + pass.failedCalls,
    messagesExtracted: (p.messagesExtracted || 0) + pass.messagesExtracted,
    totalLatencyMs: (p.totalLatencyMs || 0) + pass.latencyMs,
    lastPassAt: pass.completedAt,
    cachedMessages: pass.cachedMessages,
  };
}

/** Which messages a warm-up pass sends to the model. A message the warm-up
 * already tried and could not confirm is skipped (left to the Synthesiser,
 * which retries it once, as before), so it is not re-extracted on every new
 * message. An edited message is tried again. */
export function planWarmPass(cache, skipped, chat) {
  const attempt = [], skip = [];
  for (const source of ledgerSources(chat)) {
    if (cache?.[source.messageId]?.text === source.text) continue;
    (skipped?.[source.messageId] === source.text ? skip : attempt).push(source.messageId);
  }
  return { attempt, skip };
}

/** Remember attempted messages that a pass did not confirm (id -> text). */
export function recordWarmFailures(skipped, chat, attempted, cache) {
  const texts = Object.fromEntries(ledgerSources(chat).map(source => [source.messageId, source.text]));
  const next = { ...(skipped || {}) };
  for (const id of attempted) if (!cache?.[id] && texts[id] !== undefined) next[id] = texts[id];
  return next;
}
