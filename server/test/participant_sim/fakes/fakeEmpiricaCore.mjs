// Minimal stand-in for "@empirica/core/admin/classic"'s ClassicListenersCollector.
// Reproduces just enough of the real class (verified against
// node_modules/@empirica/core/dist/chunk-ATDZK33U.js's ListenersCollector and
// chunk-CA6WWEPS.js's ClassicListenersCollector in this repo) so that
// callbacks.js's `Empirica.on(...)` / `Empirica.before(...)` registrations
// behave the same way and store the same {placement, kind, key, callback}
// shape our harness reads back out. `flush()` is a no-op (no real flusher
// attached), matching what happens in production when a listener calls
// Empirica.flush() outside of the real Tajriba-driven listener loop.
//
// This file is a TEST-ONLY substitute injected via esbuild's `alias` option
// (see loadCallbacks.mjs) purely so that bundling server/src/callbacks.js
// does not have to resolve the real @empirica/core -> @empirica/tajriba ->
// cross-fetch dependency chain (which fails under strict Node 22 ESM
// resolution in this sandbox, unrelated to callbacks.js's own logic). It
// does not change callbacks.js itself, and does not touch any existing file.
export class ListenersCollector {
  constructor() {
    this.starts = [];
    this.readys = [];
    this.tajEvents = [];
    this.kindListeners = [];
    this.attributeListeners = [];
  }
  setFlusher(flusher) { this.flusher = flusher; }
  async flush() { if (this.flusher) await this.flusher.flush(); }
  flushAfter(cb) { if (this.flusher) return this.flusher.flushAfter(cb); }
  get unique() { return new ListenersCollectorProxy(this); }
  on(a, b, c) { this.registerListerner(1, a, b, c); }
  before(a, b, c, u) { this.registerListerner(0, a, b, c, u); }
  after(a, b, c, u) { this.registerListerner(2, a, b, c, u); }
  registerListerner(placement, kindOrEvent, keyOrCb, callback, uniqueCall = false) {
    if (kindOrEvent === "start" || kindOrEvent === "ready") {
      const list = kindOrEvent === "start" ? this.starts : this.readys;
      list.push({ placement, callback: keyOrCb });
      return;
    }
    if (typeof keyOrCb === "function") {
      this.kindListeners.push({ placement, kind: kindOrEvent, callback: keyOrCb });
      return;
    }
    this.attributeListeners.push({ placement, kind: kindOrEvent, key: keyOrCb, callback });
  }
}
class ListenersCollectorProxy extends ListenersCollector {
  constructor(coll) { super(); this.coll = coll; }
  registerListerner(placement, kindOrEvent, keyOrCb, callback) {
    this.coll.registerListerner(placement, kindOrEvent, keyOrCb, callback, true);
  }
}
export class ClassicListenersCollector extends ListenersCollector {
  onGameStart(cb) { this.on("game", "start", (_c, { game, start }) => { if (start) cb({ game }); }); }
  onRoundStart(cb) { this.on("round", "start", (_c, { round, start }) => { if (start) cb({ round }); }); }
  onStageStart(cb) { this.on("stage", "start", (_c, { stage, start }) => { if (start) cb({ stage }); }); }
  onStageEnded(cb) { this.on("stage", "ended", (_c, { stage, ended }) => { if (ended) cb({ stage }); }); }
  onRoundEnded(cb) { this.on("round", "ended", (_c, { round, ended }) => { if (ended) cb({ round }); }); }
  onGameEnded(cb) { this.on("game", "ended", (_c, { game, ended }) => { if (ended) cb({ game }); }); }
}
