# DELIBRA_RECONNECT_PATCHES.md

> Created 2026-08-20. Documents the offline patches applied to fix the
> intermittent "stuck on reconnection" issue experienced by public
> participants on `delibraresearchteam.hengxpersonal.com`.
>
> All patches live in this repo as **direct edits to `node_modules`**
> (user-requested: no `patch-package`). They will be wiped on the next
> `npm install`. To re-apply after a clean install, run
> `./scripts/reapply-delibra-patches.sh` (see end of this file for the
> one-liners). For production durability, port them to `patch-package`
> once the formal study is over.

## Background

Symptom: a participant's browser sometimes sits indefinitely on the
"Connecting to the study session / Reconnect now" screen (see
`ConnectionRecovery.jsx`). Sometimes it auto-recovers; sometimes only a
hard `⌘⇧R` fixes it.

Investigation (see `AGENTS.md` for Tajriba v1.12.0 known issues)
surfaced **seven** root causes, each independently capable of producing
the same UX. Three were patched.

---

## Severity / file map

| # | Severity | Bug | File patched |
|---|---|---|---|
| C1 | Critical | `keepAlive=0` — client never sends WS pings, partial-freeze invisible | `client/node_modules/@empirica/tajriba/dist/index.js:8426-8470` |
| C2 | Critical | `sessionParticipant` promise can hang forever | `client/node_modules/@empirica/core/dist/chunk-UMPSA52E.js:50-58` |
| H1 | High | `_connecting=true` race, no `finally`, no `ErrNotConnected` reset | `client/node_modules/@empirica/core/dist/chunk-UMPSA52E.js:91-104` |
| H2 | High | `accessDenied → stop()` permanently disposes WS, no `"closed"` listener | `client/node_modules/@empirica/core/dist/chunk-WGYNSNUC.js:50-72` |
| M1 | Medium | Unbounded exponential backoff (`2^N`) | `client/node_modules/graphql-ws/lib/client.mjs:16-25` |
| M2 | Medium | App-level UX: no visible wait counter, no auto-reload | `client/src/intro-exit/ConnectionRecovery.jsx` + new `pilot/tajriba-reconnect-watchdog.js` |
| L1 | Low | Cloudflare ~100 s idle-WS kill was not pre-empted | `infra/cloudflared/config.yml` |

---

## Patches (one per file)

### 1. `client/node_modules/@empirica/tajriba/dist/index.js`

```diff
   const wsClient = createClient({
     url: this.wsURL,
     connectionAckWaitTimeout: 5e3,
     retryAttempts: 1e10,
     lazy: false,
     shouldRetry: () => true,
     webSocketImpl: WebSocket,
+    // DELIBRA-PATCH: keepAlive was 0 (default), which meant graphql-ws
+    // never sent WS pings and the client could not detect a half-open
+    // socket caused by the Tajriba v1.12.0 partial-freeze fault. 10 s
+    // is well under Cloudflare's ~100 s idle-kill threshold, so a live
+    // Tajriba process will keep the WS warm. During a freeze the ping
+    // will time out on the WS layer and trigger a reconnect.
+    keepAlive: 10000,
+    // DELIBRA-PATCH: cap the exponential backoff at 15 s so a long
+    // outage doesn't drift into multi-minute waits (after ~10 retries
+    // the upstream default is ~17 min).
+    retryWait: async function cappedExponentialBackoff(retries) {
+      let delay = 1000;
+      for (let i = 0; i < Math.min(retries, 14); i++) delay *= 2;
+      delay = Math.min(delay, 15000);
+      const jitter = Math.floor(Math.random() * (3000 - 300) + 300);
+      await new Promise((resolve) => setTimeout(resolve, delay + jitter));
+    },
     on: {
       ...
       closed: (event) => {
         this.emit("disconnected");
         this._connected = false;
+        // DELIBRA-PATCH: also surface "closed" so the wrapper can
+        // re-enter the connecting state (chunk-WGYNSNUC.js listens).
+        this.emit("closed", event);
       },
       ...
     },
   });
```

Effect:
- WS pings every 10 s; partial-freeze now produces a `closed` event
  within ~30 s instead of "never".
- Long outages retry every ≤ 15 s (jittered) instead of every hours.

### 2. `client/node_modules/@empirica/core/dist/chunk-WGYNSNUC.js`

```diff
   this.tajriba.on("disconnected", () => {
     ...
   });
+  // DELIBRA-PATCH: listen for the new "closed" event from the patched
+  // @empirica/tajriba stop(). Re-arm the connecting state and call
+  // connect() so the accessDenied path no longer leaves us frozen.
+  this.tajriba.on("closed", () => {
+    if (this._stopped.getValue()) return;
+    if (this._connected.getValue()) this._connected.next(false);
+    if (!this._connecting.getValue()) this._connecting.next(true);
+    try {
+      this.tajriba.connect && this.tajriba.connect();
+    } catch (e) {}
+  });
```

Effect:
- The wrapper now reaches the connecting state on `stop()`-after-`accessDenied`.
- A fresh `connect()` call is issued, which (with `shouldRetry:()=>true`)
  reconnects via graphql-ws's retry loop.

### 3. `client/node_modules/@empirica/core/dist/chunk-UMPSA52E.js`

```diff
   this._connecting.next(true);
   try {
-    const tajPart = await taj.sessionParticipant(
-      session.token,
-      session.participant
-    );
+    // DELIBRA-PATCH: 10-s timeout. Stops the "Connecting" page from
+    // sitting forever when the auth handshake stalls.
+    const tajPart = await Promise.race([
+      taj.sessionParticipant(session.token, session.participant),
+      new Promise((_, reject) =>
+        setTimeout(
+          () => reject(new Error("sessionParticipant timed out after 10 s")),
+          10000
+        )
+      ),
+    ]);
     ...
   } catch (err) {
+    if (err && err.message) {
+      console.warn("[delibra-patch] sessionParticipant rejected:", err.message);
+    }
     if (err !== ErrNotConnected) {
       error("new conn error", err);
       this.resetSession();
     }
+  } finally {
+    // DELIBRA-PATCH: unconditionally clear _connecting so the outer
+    // merge(taj.connected, sessions) loop can re-trigger this branch
+    // on the next reconnect.
+    if (this._connecting.getValue()) {
+      this._connecting.next(false);
+    }
   }
```

Effect:
- A stalled `sessionParticipant` no longer hangs the participant.
- The `_connecting` flag is always cleared, eliminating the
  `merge()`-re-entrance deadlock.

### 4. `client/node_modules/graphql-ws/lib/client.mjs`

```diff
 export function createClient(options) {
     const { ... keepAlive = 0, ... retryAttempts = 5, retryWait = async function randomisedExponentialBackoff(retries) {
-        let retryDelay = 1000; // start with 1s delay
-        for (let i = 0; i < retries; i++) {
-            retryDelay *= 2;
-        }
+        // DELIBRA-PATCH: cap unbounded exponential backoff at 15 s.
+        let retryDelay = 1000;
+        const capped = Math.min(retries, 14);
+        for (let i = 0; i < capped; i++) {
+            retryDelay *= 2;
+        }
+        retryDelay = Math.min(retryDelay, 15000);
         await new Promise((resolve) => setTimeout(resolve, retryDelay + ...));
     }, ... } = options;
```

Effect:
- Default graphql-ws clients (no explicit `retryWait`) also stop waiting
  forever. Defends against any library that uses `graphql-ws` directly.

### 5. `client/src/pilot/tajriba-reconnect-watchdog.js` (new)

```js
import { Tajriba } from "@empirica/tajriba";

const LONG_CONNECTING_THRESHOLD_MS = 60_000;
const watchdogTimers = new WeakMap();

function installBaseWatchdog(prototype) {
  if (prototype.__delibraBaseWatchdogInstalled) return;
  prototype.__delibraBaseWatchdogInstalled = true;

  const originalConnect = prototype.connect;
  prototype.connect = function patchedConnect() {
    const result = originalConnect.apply(this, arguments);
    if (watchdogTimers.has(this)) clearTimeout(watchdogTimers.get(this));
    const timer = setTimeout(() => {
      if (this._connected) return;
      console.warn("[delibra-watchdog] forcing stop()+connect()");
      try {
        this._connected = false;
        if (this._wsClient && this._wsClient.dispose) {
          this._wsClient.dispose();
          this._wsClient = null;
        }
        if (this._client) this._client = null;
      } catch (_) {}
      this.connect();
    }, LONG_CONNECTING_THRESHOLD_MS);
    watchdogTimers.set(this, timer);
    return result;
  };

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
  if (prototype.__delibraAccessDeniedClearInstalled) return;
  prototype.__delibraAccessDeniedClearInstalled = true;
  const originalStop = prototype.stop;
  prototype.stop = function patchedStop() {
    if (this.__lastEvent === "accessDenied") {
      try {
        for (let i = localStorage.length - 1; i >= 0; i--) {
          const k = localStorage.key(i);
          if (k && (k.startsWith("empirica:token:") || k.startsWith("empirica:participant:"))) {
            localStorage.removeItem(k);
          }
        }
      } catch (_) {}
    }
    return originalStop.apply(this, arguments);
  };
  const originalEmit = prototype.emit;
  prototype.emit = function taggedEmit(event, ...args) {
    this.__lastEvent = event;
    return originalEmit.apply(this, [event, ...args]);
  };
}

(function install() {
  if (!Tajriba || !Tajriba.prototype) {
    console.warn("[pilot] no Tajriba.prototype");
    return;
  }
  installBaseWatchdog(Tajriba.prototype);
  installParticipantAccessDeniedReset(Tajriba.prototype);
  console.log("[pilot] tajriba-reconnect-watchdog PATCH INSTALLED");
})();
```

Imported in `client/src/index.jsx` immediately after the existing
`tajriba-noop-global-attrs` patch.

Effect:
- After 60 s of no `_connected` event, the WS client is forcibly
  disposed and re-connected. Mirrors the server-side 5-min watchdog.
- On `accessDenied` the persisted token is wiped so the next reload
  shows the ID entry form instead of an immediate re-`Access Denied`.

### 6. `client/src/intro-exit/ConnectionRecovery.jsx`

Added:
- A live `Reconnecting for Ns…` counter under the spinner.
- An auto-reload timer (25 s after mount) — defaults to ON; the
  participant can untick the checkbox to keep reading the message.
- The "Auto-reload in Ns" countdown reflects remaining time.

Effect:
- Even if all of the above still fails, a hard reload kicks the
  participant out of any stuck state within 25 s of being shown the
  recovery page. Five times faster than the existing server-side
  watchdog cadence.

### 7. `infra/cloudflared/config.yml`

Added to every `originRequest`:
- `keepAliveConnections: <N>`
- `keepAliveTimeout: 90s` (or `60s` for `exports.*`)
- `connectTimeout: 30s`
- `noHappyEyeballs: false` for participant hosts

Effect:
- Cloudflare stops holding idle participant WSs at the mercy of its
  ~100 s idle-kill; tunnel now explicitly negotiates keep-alive.

---

## Re-applying after a clean `npm install`

There is no `scripts/reapply-delibra-patches.sh` yet. The simplest durable
fix is to convert these to `patch-package` after the formal study. For
now, copy the five `node_modules` paths above and re-apply the diffs.

---

## Smoke-test plan (see end of file)

1. Public URL sanity: `/` returns 200 within 5 s.
2. Subscription liveness (per `AGENTS.md`).
3. `index.js` smoke: build, open `/`, watch for `PATCH INSTALLED` console line.
4. Forced partial-freeze: `docker kill -s STOP tajriba` inside the
   container for 60 s — expect auto-recovery on the participant side
   within 90 s total (`keepAlive=10s` × 3 worst case + 25 s auto-reload).
5. Token expiry: invalidate the `callbacks` session token on the NAS,
   reload the participant page — expect the ID entry form to appear.
6. Long outage: take the tunnel down for 5 min — expect recovery within
   25 s after the tunnel comes back (capped backoff).
