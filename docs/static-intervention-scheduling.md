# Static intervention scheduling and publication

Implemented on `fix/static-20261030`, based on `93ee969` and integrated with
the subsequent `main` repair `07c9b48`. Background dispatch, pipeline cancellation,
batch human-message accounting, unique requested-reply IDs, and discussion
deadline recovery from that repair are retained. Timer retries do not advance
the human-message cursor or count already-dispatched messages again.

## Stage 1: opportunity and attempt lifecycle

`StaticInterventionScheduler.mjs` keeps one current opportunity in the existing
Round attribute `staticInterventionOpportunity`. It creates an opportunity only
at an actual participant-message checkpoint with at least six messages since
the previous automatic publication. Overlapping checkpoints update this same
opportunity rather than building a FIFO queue of messages.

An opportunity has a stable `opportunityId`; each attempt has an `attemptId`.
The states are `PENDING`, `GENERATING`, `VALIDATING`, `READY_TO_PUBLISH`,
`PUBLISHED`, and `CANCELLED`. State and attempt count are flushed before model
work. Every retry builds a new prompt from the latest allowed public transcript.
No generated candidate is retained for later publication.

Each opportunity allows at most **three pipeline attempts**, including an
interrupted attempt. The existing inner Generator/Validator repair limit remains
unchanged: at most two Generator calls and two Validator calls per pipeline.
Thus one opportunity makes at most twelve model calls. Exhaustion is explicitly
logged as `RETRY_EXHAUSTED`. A subsequent new eligible human checkpoint can
supersede an exhausted opportunity; a timer or a replay cannot reset its budget.
There is still no per-round automatic-attempt cap.

The existing six-message threshold, thirty-second attempt cooldown, ten-second
Static start floor, and one-automatic-pipeline lock remain in place. A blocked
checkpoint preserves its opportunity. One replaceable timer handles cooldown
expiry or phase expiry. Lock release and requested-response completion wake the
scheduler directly; there is no lock polling. A cooldown-blocked opportunity
can retry after participants go silent.

API/Validator-unavailable errors retry under the attempt budget and cooldown.
A rejected or malformed candidate preserves a pending opportunity but waits
for a new human context before another outer attempt; it does not repeatedly
generate against an unchanged rejected context. Existing validation and its
same-attempt repair still run normally. Expiry, phase transition, round end,
game end, and the start floor cancel obsolete pending work explicitly.

The stale threshold is unchanged: zero to two new human messages may be
tolerated; three or more invalidate the candidate. Static checks freshness
after generation, after validation, and inside final publication coordination.
An already-stale candidate does not reach Validator. New deterministic fixed
openings/silence nudges and excluded Timer messages keep their previous
counting semantics.

## Stage 2: publication coordination and requested priority

`FacilitatorPublication.mjs` serializes short publication sections per Game.
It does not lock during any Generator or Validator call. Eligibility is checked
both before and after the visibility-state flush. The final check and canonical
append run without an intervening await. All shared generated/fallback
publication paths use this coordinator; every exception releases its tail.

For Static only, an outstanding participant request takes priority over an
automatic candidate. The check covers both in-flight requested pipelines and a
newly appended request whose callback has not yet claimed its lifecycle entry.
It therefore covers both completion orders and a request arriving during the
last publication flush. An automatic message already committed before the
request exists remains legitimate and is not revoked.

A displaced opportunity remains pending. After the requested reply (including
its safe fallback) is committed, automatic reconsideration requires **at least
two nonempty ordinary public participant messages from at least two different
participants**, after that reply in transcript order. Additional Facilitator
requests do not satisfy this condition. This is an operational definition of
subsequent discussion, not a semantic assessment of message quality. The normal
six-message threshold and cooldown must also hold. Cooldown expiry alone cannot
cause an automatic message to follow a requested reply. Reconsideration always
regenerates and validates against the new context.

Static canonical message IDs are derived from the opportunity ID. The existing
canonical message schema stays unchanged; its `auditRequestId` links to the
attempt log. The transcript is checked for a previously committed opportunity
before retrying. Publication accounting is updated under the same short lock,
and recovery reconciles missing bookkeeping without publishing another copy.

## Persistence and deployment boundary

Pending state and append-only transition events live in the existing Tajriba
Round, not an external queue. The callbacks `ready` listener reconciles
interrupted in-flight entries and rearms persisted pending opportunities without
requiring another participant message. A committed automatic transcript entry
prevents replay. A committed requested reply restores a missing post-request
discussion barrier. Phase and deadline guards apply before recovery can retry.

The runtime entrypoint starts one Empirica owner of Tajriba and callbacks
(`infra/docker-compose.yml`, `infra/scripts/empirica-entrypoint.sh`). The saved
Azure definition in `outputs/azure-incident-20261025-static/app-after-fix.json`
has Single revision mode and `minReplicas = maxReplicas = 1`. That is historical
configuration evidence, not a new inspection or modification of live Azure.

The publication mutex is **in-process only**. Tajriba scalar attributes do not
provide a cross-process conditional update through the APIs used here. This
fix requires one active callbacks writer per Tajriba store, including during
revision replacement. It must not be represented as a distributed exactly-once
queue. A multi-writer deployment needs an authoritative transactional/conditional
publication service before scaling, independently of this repair. Persistent
storage failure can prevent any durable commit; deterministic message IDs and
recovery reconciliation mitigate partial writes but do not manufacture storage
transactions. Interrupted participant-request pipelines retain the existing
interrupted-audit behavior rather than being automatically replayed.

Adaptive gets no new opportunities or retries from the Static scheduler. Its
detector, selection, role definitions, budgets, closeout scheduler, stale
thresholds, and pacing are unchanged. It shares only the short publication
serialization and exception cleanup already needed by the common publication
path. Requested-versus-automatic priority and discussion barriers added here
are scoped to Static.

## Audit

Attempt outcomes remain in the existing Game `llmLog`. Static attempts add
`opportunityId`, `attemptId`, `retryCount`, `reasonCode`, `sessionId`, and
`phaseId`; pending/exhausted outcomes include opportunity status when available.
All transitions are in the Round append-only `staticInterventionEvents` namespace
(read with `readAppendOnlyAttribute(round, "staticInterventionEvents")`). Events
contain IDs, message counts, retry counts, timestamps, eligibility times, and
status/reason codes, without participant text.

Reasons distinguish `STALE_CONTEXT`, `REQUEST_SUPERSEDED`, `PHASE_ENDED`,
`TIME_FLOOR`, `COOLDOWN_ACTIVE`, `LOCK_BUSY`, `VALIDATION_REJECTED`, `API_ERROR`,
`STATE_COMMIT_ERROR`, `DUPLICATE_SUPPRESSED`, `RETRY_SCHEDULED`, `RETRY_EXHAUSTED`,
and `PUBLISHED`. Opportunity history distinguishes an abandoned attempt from a
still-pending opportunity and a legitimate terminal cancellation.

## Separate prompt/Validator observation

No prompt, schema, or manifest is changed. Static describes a scoreboard of pros
and cons, while its Validator rejects pure summarisation under
`requiredReasoningActMissing`. The historical diagnostic log has fourteen Static
condition audit entries and three generated Static checkpoints; the two rejected
checkpoints were rejected for `repetition`, not
`requiredReasoningActMissing`. This confirms those repetition rejections, not a
causal pure-summary failure. A potential wording inconsistency remains a
separate hypothesis requiring candidate-level live evidence and research review.

## Regression entry points

```sh
node --test --test-reporter=spec server/src/StaticInterventionScheduling.test.mjs server/src/CallbacksAdaptiveIntegration.test.mjs server/src/AdaptiveFacilitatorMentions.test.mjs
node --test --test-reporter=spec server/src/*.test.mjs server/src/prompts/*.test.mjs
```

The new tests invoke real callbacks with an in-memory Empirica store, synthetic
public chat, simulated provider replies, and a controlled clock. They cover the
zero/one/two/three-message boundary, timer-only retry, lock release, checkpoint
coalescing, both request completion orders, publication interleavings, pending
expiry, validation/API budgets, restart recovery, commit-flush exceptions,
canonical-message reconciliation, and fixed-message exclusions. Existing tests
are retained; source-shape assertions were adapted to the new guards/finally
blocks without dropping their assertions about behavior.

After integration with `07c9b48`, all 875 server tests passed, including the
94-test focused scheduling/dispatch/integration suite. Both server and client
production builds and the twelve-file prompt startup check passed. These are
offline validations, not a live-session replay or a deployment verification.
