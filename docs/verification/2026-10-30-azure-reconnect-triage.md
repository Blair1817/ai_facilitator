# Azure intermittent reconnect and interaction stalls

Date: 2026-10-30, Europe/London. Read-only live checks around 18:00–18:03 UTC.
Source inspected: clean `main@d4b691df247ec645ad8bce3acb531062a40bcaca`.
User report: Azure; sometimes one participant stalls, sometimes all three reconnect.
No participant registration, model calls, state mutations, restart or deployment.

## Observed live

- Address observed in the existing participant browser:
  `https://ca-delibra.icymushroom-cae01008.uksouth.azurecontainerapps.io`.
- HTTP root: 200. Fresh unauthenticated `scopedAttributes` subscriptions for
  global and game returned `next` without GraphQL errors in under one second.
  This establishes subscription delivery at those instants, not continuous
  liveness, participant authentication recovery or `experimentOpen=true`.
- Public client asset `/assets/index-CnAivbJe.js`, SHA-256
  `01f80b3201a677326f64a25d99dd6c4efeab842143c9fa6624cc421de86761a2`,
  contains watchdog, auto-reload and `Retry sending` strings. This establishes
  presence of frontend features, not the backend image/commit or full recovery.
- A longer connection received initial subscription results, then closed
  abnormally with code 1006 after approximately 10.05 seconds.
- Three further simultaneous connections compared idle, a protocol ping every
  two seconds, and fresh global subscriptions every two seconds. All received
  connection ACKs, then closed abnormally around 10.2–10.3 seconds. Before
  closure the ping connection received four pongs, and the subscription
  connection received twelve `next` frames (including initial/done deliveries).
  No raw attributes or participant content were printed or retained.

These 1006 results belong to the terminal probe path. They do not locate the
failure in Azure, establish participant sessions behave identically, or exclude
an intermediary/probe-path lifetime limit or unauthenticated-connection policy.
Continued traffic did not prevent the observed probe closures. An ACK or initial
`next` alone therefore must not be reported as sustained connection acceptance.

## Confirmed recovery gaps in checked-out code

1. `client/patches/@empirica+tajriba+1.7.0.patch` sets `keepAlive:10000`
   but supplies no ping/pong response deadline. The installed graphql-ws
   implementation sends one ping, and schedules the next only after a pong;
   lack of pong does not automatically close the socket. A synthetic test using
   the actual installed `graphql-ws/lib/client.mjs` and a fake WebSocket that
   ACKs but never pongs reproduced this: keepAlive=20 ms, observation=150 ms,
   opened=1, pings=1, closed=0, socket still open. No network was used.
   This contradicts the old patch comment promising an automatic close within
   roughly 30 seconds. See the upstream [ClientOptions documentation](https://the-guild.dev/graphql/ws/docs/client/interfaces/ClientOptions#keepalive).
2. `client/src/pilot/tajriba-reconnect-watchdog.js` clears its timer on
   `connected` and checks only `_connected`. It does not continuously verify
   authenticated game subscription delivery after a connection opens. The
   installed Tajriba implementation marks connected on raw socket `opened`,
   before the GraphQL `connection_ack`.
3. `client/src/Game.jsx` renders `ConnectionRecovery` whenever round/stage
   objects are absent. Consequently its Reconnecting label is also a
   missing-data/loading state, not proof of a broken transport.
4. `ConnectionRecovery.jsx` reloads after 25 seconds while mounted. This is a
   fallback, not server recovery. If the upstream remains unavailable it can
   repeat; if the existing page retains stale data and never mounts recovery,
   this timer cannot help. Comments referring to a NAS watchdog are historical;
   Azure automatic subscription-freeze recovery is not established.

## Interpretation and remaining evidence

Single-participant failures warrant per-session connection, authenticated
subscription and client-error checks. Simultaneous failures warrant common
network, gateway, revision restart/resource pressure and Tajriba dispatcher
checks. Historical Tajriba partial-freeze remains a candidate, not a diagnosis
of these particular incidents. A connected/pong-responsive socket also does not
prove business subscriptions remain live.

The earlier SDK event-lock defect can explain stalled chat acknowledgements and
stage advancement, but it is a distinct mechanism from a transport disconnect.
The frontend feature markers do not establish whether the backend repair is
deployed. No Azure CLI was installed, and no Azure management session/revision,
replica count, restart count or incident-time logs were verified in this pass.

Next evidence: incident timestamps plus browser WS close/error and authenticated
subscription progress, correlated with Azure revision/system/callback logs.
Then implement bounded ping-response recovery, continuous business-liveness
checks and a three-participant reconnect/stage-transition rehearsal. Do not
claim that adding transport pings fixes server-side dispatcher freezes.
