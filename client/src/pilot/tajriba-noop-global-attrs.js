// client/src/pilot/tajriba-noop-global-attrs.js
//
// PILOT-ONLY monkey-patch for @empirica/tajriba.
//
// Background: The Empirica player client creates a TajribaConnection WITHOUT
// auth (`Tajriba.connect(url)`) for its base connection, then on a separate
// authenticated TajribaParticipant it subscribes to `changes` (the real game
// data). The unauth TajribaConnection is also used to subscribe to
// `globalAttributes`. The Tajriba server v1.12.0 we run on the NAS rejects
// any subscription that comes from a connection that did not present a valid
// Bearer authToken in connection_init → it returns "Access Denied" for the
// `globalAttributes` subscription.
//
// The Tajriba client treats "Access Denied" as fatal: it emits
// `accessDenied` and calls `this.stop()`, which disposes the underlying
// graphql-ws client. That dispose is permanent — `_stopped` becomes true and
// the client never reconnects. As a result, TajribaConnection._connected
// never becomes true (or becomes false and never recovers), the
// ParticipantConnection never has both `connected` AND a session, and the
// TajribaParticipant is never created. The player UI is stuck on the
// Empirica loading spinner forever.
//
// Fix: make only the no-auth TajribaConnection's `globalAttributes` a minimal
// subscribable that publishes `experimentOpen=true` and `{ done: true }`.
// `experimentOpen` allows the registration form to render; `done` initialises
// the `Globals.self` BehaviorSubject used by EmpiricaContext. No other global
// or participant/game value is synthesized.
//
// The no-op never issues a GraphQL `globalAttributes` subscription, so it
// never triggers the Access Denied → stop cascade. The TajribaParticipant
// (authenticated) is a SEPARATE WebSocket and is unaffected; the actual
// game data still flows through the TajribaProvider and renders the player
// UI normally. Authenticated Tajriba instances retain the original method.
//
// Revert before formal recruitment: this patch is pilot-only. The proper
// fix upstream is to either (a) make `globalAttributes` accept unauth
// connections in non-production Tajriba, or (b) make the Empirica client
// route its base TajribaConnection's `globalAttributes` through a service
// authToken rather than no auth. See Gate 11c.

import { Tajriba } from "@empirica/tajriba";
import {
  createPilotGlobalAttributes,
  shouldStubGlobalAttributes,
} from "./tajribaPatchPolicy";

(function install() {
  if (!Tajriba || !Tajriba.prototype) {
    console.warn(
      "[pilot] installTajribaNoopGlobalAttrs: Tajriba missing; patch not applied"
    );
    return;
  }
  if (Tajriba.prototype.__pilotNoopGlobalAttrsInstalled) {
    return;
  }
  console.log("[pilot] tajriba-noop-global-attrs PATCH INSTALLED");
  Tajriba.prototype.__pilotNoopGlobalAttrsInstalled = true;
  const originalGlobalAttributes = Tajriba.prototype.globalAttributes;

  // Pilot bootstrap for the unauth TajribaConnection. It emits the single
  // global EmpiricaContext needs in order to show registration, followed by
  // `{ done: true }` so `Globals.self` initialises. Authenticated game data is
  // still provided by TajribaParticipant and never passes through this branch.
  Tajriba.prototype.globalAttributes = function noopGlobalAttributes() {
    if (!shouldStubGlobalAttributes(this)) {
      return originalGlobalAttributes.call(this);
    }
    return createPilotGlobalAttributes();
  };
})();
