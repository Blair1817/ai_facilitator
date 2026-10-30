// client/src/pilot/tajriba-reconnect-watchdog.js
//
// DELIBRA-PATCH (2026-08-20):
// App-level safety net for the Tajriba v1.12.0 "partial-freeze" fault and the
// Upstream `@empirica/tajriba` accessDenied-disposes-everything bug.
//
// Monitor both handshake/heartbeat and authenticated subscription delivery.
// The Go binary version does not establish that these JS SDK issues are fixed.

import { Tajriba } from "@empirica/tajriba";
import { monitorTajribaTransport } from "./tajribaTransportRecovery.mjs";

const monitors = new WeakMap();

function installBaseWatchdog(prototype) {
  const originalConnect = prototype.connect;
  if (prototype.__delibraBaseWatchdogInstalled) return;
  prototype.__delibraBaseWatchdogInstalled = true;

  prototype.connect = function patchedConnect() {
    if (this.__delibraStopping) return;
    const result = originalConnect.apply(this, arguments);
    const client = this._wsClient;
    if (!client?.on || !client?.terminate) return result;
    if (monitors.get(this)?.client === client) return result;
    monitors.get(this)?.monitor.stop();
    const monitor = monitorTajribaTransport(client, {
      isSuspended: () => document.hidden || navigator.onLine === false,
      // Probe only authenticated clients. Request no attribute contents,
      // identities or chat: initial `done` uses the real subscription path.
      probe: this.token ? (sink) => client.subscribe({
        query: 'subscription DelibraLiveness { scopedAttributes(input: [{ kinds: ["global"] }]) { done } }',
      }, sink) : null,
    });
    const resume = () => {
      if (!document.hidden && navigator.onLine !== false) monitor.check();
    };
    window.addEventListener("online", resume);
    document.addEventListener("visibilitychange", resume);
    monitors.set(this, { client, monitor: {
      stop() {
        monitor.stop();
        window.removeEventListener("online", resume);
        document.removeEventListener("visibilitychange", resume);
      },
    } });
    return result;
  };
  const originalStop = prototype.stop;
  prototype.stop = function monitoredStop() {
    monitors.get(this)?.monitor.stop();
    monitors.delete(this);
    this.__delibraStopping = true;
    try {
      return originalStop.apply(this, arguments);
    } finally {
      this.__delibraStopping = false;
    }
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
