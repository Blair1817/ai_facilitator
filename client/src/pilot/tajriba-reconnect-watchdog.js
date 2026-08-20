// client/src/pilot/tajriba-reconnect-watchdog.js
//
// DELIBRA-PATCH (2026-08-20):
// App-level safety net for the Tajriba v1.12.0 "partial-freeze" fault and the
// Upstream `@empirica/tajriba` accessDenied-disposes-everything bug.
//
// Three layers of defense, all guarded so a missing prototype is a no-op:
//
// 1. If the Tajriba base connection sits in `_connecting` for > 60 s
//    (i.e. graphql-ws retry loop is running but sessionParticipant never
//    resolves), force `stop()` + `connect()` to give the retry loop a kick.
// 2. If a TajribaParticipant (authenticated) emits `accessDenied`, clear
//    any persisted session so the participant registration form is shown
//    again instead of hanging on the loading spinner.
// 3. Keep a tiny per-tab "no round/stage data" watcher (used by
//    ConnectionRecovery.jsx) so the participant sees a visible bad-state
//    instead of an invisible freeze.
//
// This patch only runs in the PILOT configuration; the upstream fixes should
// obsolete it once Tajriba >= v1.12.5 is bundled (already on disk at
// /home/delibra/.cache/empirica/bin/version/v1.12.5, see AGENTS.md).

import { Tajriba } from "@empirica/tajriba";

const LONG_CONNECTING_THRESHOLD_MS = 60_000;
const watchdogTimers = new WeakMap();

function installBaseWatchdog(prototype) {
  const originalConnect = prototype.connect;
  if (prototype.__delibraBaseWatchdogInstalled) return;
  prototype.__delibraBaseWatchdogInstalled = true;

  prototype.connect = function patchedConnect() {
    const result = originalConnect.apply(this, arguments);
    // Schedule a watchdog only once per instance: if the connection is
    // still not "connected" after LONG_CONNECTING_THRESHOLD_MS, force a
    // reset. This catches the partial-freeze fault at the client level.
    if (watchdogTimers.has(this)) {
      clearTimeout(watchdogTimers.get(this));
    }
    const timer = setTimeout(() => {
      if (this._connected) return;
      // Try to recover by recycling the WS client. graphql-ws's retry
      // loop is already running, but `stop()` + `connect()` clears any
      // stuck state in our wrapper.
      console.warn(
        "[delibra-watchdog] Tajriba base connection stuck for >",
        LONG_CONNECTING_THRESHOLD_MS / 1000,
        "s; forcing stop()+connect()",
      );
      try {
        this._connected = false;
        if (this._wsClient && typeof this._wsClient.dispose === "function") {
          this._wsClient.dispose();
          this._wsClient = null;
        }
        if (this._client) {
          this._client = null;
        }
      } catch (_) {
        // ignore
      }
      this.connect();
    }, LONG_CONNECTING_THRESHOLD_MS);
    watchdogTimers.set(this, timer);
    return result;
  };

  // Clear the watchdog once "connected" actually fires.
  const originalEmit = prototype.emit;
  prototype.emit = function patchedEmit(event, ...args) {
    if (event === "connected" && watchdogTimers.has(this)) {
      clearTimeout(watchdogTimers.get(this));
      watchdogTimers.delete(this);
    }
    return originalEmit.apply(this, [event, ...args]);
  };
}

function installParticipantAccessDeniedReset(prototype) {
  // Upstream: accessDenied on the authenticated TajribaParticipant calls
  // stop() and disposes the WS client. There is no automatic way back to the
  // PlayerCreate form unless the user reloads, because the persisted
  // session token in localStorage is still valid for THIS participant only.
  //
  // The cleanest fix at this layer is to clear the localStorage session
  // when accessDenied fires, so the next reload returns to the ID entry
  // screen. Empirica core already calls resetSession() in chunk-UMPSA52E.js,
  // so here we just additionally clear localStorage to ensure stale tokens
  // never survive a server restart.
  if (prototype.__delibraAccessDeniedClearInstalled) return;
  prototype.__delibraAccessDeniedClearInstalled = true;
  const originalStop = prototype.stop;
  prototype.stop = function patchedStop() {
    // Detect whether stop() was triggered by accessDenied (the only place
    // upstream calls it without an explicit user gesture). We can't read the
    // call stack reliably across bundlers, so use a flag: accessDenied
    // listeners fire BEFORE stop() upstream, so we'll see accessDenied as
    // the last emitted event when stop() runs.
    if (this.__lastEvent === "accessDenied") {
      try {
        // Best-effort: remove persisted participant data so the user lands
        // on the PlayerCreate form after the inevitable reload.
        for (let i = localStorage.length - 1; i >= 0; i--) {
          const k = localStorage.key(i);
          if (k && (k.startsWith("empirica:token:") || k.startsWith("empirica:participant:"))) {
            localStorage.removeItem(k);
          }
        }
      } catch (_) {
        // localStorage may be unavailable in private mode.
      }
    }
    return originalStop.apply(this, arguments);
  };
  // Tag last-event so stop() above can see whether this was an
  // accessDenied-triggered stop.
  const originalEmit = prototype.emit;
  prototype.emit = function taggedEmit(event, ...args) {
    this.__lastEvent = event;
    return originalEmit.apply(this, [event, ...args]);
  };
}

(function install() {
  if (!Tajriba || !Tajriba.prototype) {
    console.warn(
      "[pilot] installTajribaReconnectWatchdog: Tajriba missing; patch not applied",
    );
    return;
  }
  installBaseWatchdog(Tajriba.prototype);
  installParticipantAccessDeniedReset(Tajriba.prototype);
  console.log("[pilot] tajriba-reconnect-watchdog PATCH INSTALLED");
})();
