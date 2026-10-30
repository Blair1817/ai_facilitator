# Connection recovery repair — local validation

Date: 2026-10-30, Europe/London. Follow-up to the Azure reconnect triage and
the supplied LLM audit. Changes are uncommitted local work; unrelated ongoing
server/prompt changes were retained. No deployment, restart, participant
registration, experiment-state mutation or external-model call was performed.

## Changes

- Added `client/src/pilot/tajribaTransportRecovery.mjs` and wired it through
  the existing pilot entry. The transport monitor uses graphql-ws `terminate()`
  so existing client identity, authenticated session and operations survive
  recovery. It no longer disposes and replaces the urql/WS objects on a timer.
- Heartbeats sent by the existing SDK configuration now have a 20-second pong
  deadline. Initial GraphQL acknowledgement has a 30-second monitor deadline.
  Retry continues through the existing backoff, including its jitter.
- Authenticated connections periodically request only `done` from a fresh
  global `scopedAttributes` subscription: every 30 seconds, with an 8-second
  response deadline. This tests real subscription delivery independently of
  pong responsiveness. Errors count as responses rather than proving a freeze;
  a denied probe therefore cannot establish subscription health. Probes never
  request participant attributes, messages, identifiers or model context.
- Hidden/offline browser deadlines defer to avoid recovery churn. Returning
  online or making the page visible requests an immediate business probe.
  Stopping removes monitor listeners, probes and timers.
- Durable Tajriba patch now reports connected after GraphQL ACK rather than
  raw socket opening. It updates connection state before emitting events,
  ignores callbacks belonging to a superseded/stopped WS client, and observes
  asynchronous disposal rejection. Explicit stop cannot resurrect a connection
  through the wrapper's closed-event listener.
- The SDK owns its participant-handshake timeout and closes its pending
  participant client on failure. The core patch no longer races an inaccessible
  participant connection against an outer timeout. Temporary connection
  failures retry the same saved participant session rather than resetting it;
  a late result after leaving is stopped. Actual authentication rejection
  retains the existing session-reset behavior. Removed the upstream token
  console output from that handler.

## Validation

- `node --test server/src/TransportRecovery.test.mjs`: **9/9 passed**.
  Uses the actual installed graphql-ws, a browser bundle of the actual patched
  Tajriba/core and application monitor, and synthetic WebSocket failure modes.
  Covers missing pong with original-operation replay; responsive pong but
  frozen subscription; three simultaneous 1006 disconnects; missing ACK;
  hidden/offline deferral and shutdown cleanup; probe authorization failure;
  ACK-based readiness and intentional stop; same-session timeout retry; late
  participant cleanup. Test timeouts are shortened for fault injection.
- `npm --prefix client run build`: passed after the final dependency edits;
  existing dependency sourcemap warnings remain. This pass did not modify
  backend runtime source, and did not claim a full suite pass for unrelated
  ongoing server changes.
- Client `patch-package --error-on-fail`: all three existing dependency patches
  accepted, including the updated core and Tajriba patches. In a temporary
  tree, reverse-apply followed by forward-apply reproduced each patched SDK
  file byte-for-byte. No patch depends solely on an ignored node_modules edit.
- `git diff --check`: passed for the working tree at validation time.

## Limits and hosted acceptance

These are local transport/lifecycle fault tests, not three real browsers in
one Azure experiment. Persistent server-side dispatcher freeze still requires
server diagnosis and recovery; retries do not repair its underlying cause.
The existing ConnectionRecovery page's reload fallback is unchanged. The LLM
audit's model latency and validation rejection are separate concerns and were
not addressed by changing experimental treatment or prompt behavior.

Release from a reviewed committed ref through the immutable Azure image
pipeline, preserving unrelated work. Before hosted acceptance, identify the
active revision/image and traffic, inspect system/callback logs, and verify
authenticated subscription permission and sustained delivery. In an isolated
three-person test batch, deliberately interrupt one connection and then all
three; verify the same participants/game return, chat resumes, pending sends
do not duplicate, stage transitions work and saved submissions persist.
Correlate incident timestamps with browser and Azure logs. Do not call a
1006 from the terminal probe path proof of an Azure-side timeout, and do not
mark the historical partial-freeze or formal-study gates resolved from these
offline tests.
