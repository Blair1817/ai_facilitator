# Independent group decision form (v2)

Implemented locally on 2026-10-17. Not deployed to Azure.

## Participant flow

New games mark the practice round and both formal rounds with
`decisionFlowVersion: 2`. They use discussion → one decision form → follow-up.
The formal follow-up starts with TLX. Existing rounds without the version marker
retain the legacy decision and follow-up cursors; no in-progress state is migrated.

The form asks for the reported group choice, confidence (0–100), and personal
agreement. A No answer additionally requires a personal choice and nonblank
reason. Changing the reported group choice resets agreement and the conditional
fields. Selecting Yes clears the conditional fields. Only task options appear;
there is no failure option or live agreement feedback.

Participants submit independently. The server validates and stores the complete
answer and its receipt before acknowledging it. Browser drafts and pending
requests survive refresh; retries reuse the same request ID. Accepted answers
cannot be replaced by subsequent requests. The form locks after acknowledgement.

The 90-second decision deadline and pre-discussion Initial Decision are retained.
All-ready early discussion completion is retained. Fixed opening messages and
all existing formal/practice discussion time reminders explicitly ask the group
to agree on one final choice. No new model calls are introduced.

## Submission and result contract

`player.finalDecisionSubmitRequest` contains `requestId`, `roundId`, `stageId`,
`choice`, `confidence`, `agreesWithGroupChoice`, and conditional
`finalPersonalChoice` / `finalPersonalChoiceRationale`. `attempt` is a retry
transport marker, not an acceptance timestamp.

The server authors `player.round.finalDecisionSubmission` with normalized answers,
`submissionId`, and `submittedAt`, and returns
`player.round.finalDecisionSubmissionResult` with request ID, status and reason.
It also maintains the existing research fields and `finalDecision` record.
Personal follow-up fields are null for Yes answers. No additional personal-choice
confidence rating is collected.

All three accepted reports are compared, regardless of personal endorsement:

| Condition | Outcome | Official choice |
| --- | --- | --- |
| All three report the same task option | `consensus_choice` | Matching task option |
| All three submit, reports differ | `mismatch_fail` | `FAIL` |
| Deadline reached with fewer than three submissions | `timeout_fail` | `FAIL` |

Both complete cases end immediately. The server rejects requests received at or
after the deadline; an already accepted receipt remains recoverable. Timeout
preserves real submissions and marks only missing responses as timed out. It
never invents answers or submitted timestamps. Native stage-end and duplicate
requests cannot overwrite the group result. Disconnected assigned participants
remain part of the required three.

Participant pages use neutral submission/completion wording. Research exports
retain all outcome codes, including historical `declared_fail`, and add CSV
columns for personal agreement, actual submission time and missing-response
reason. The existing persistence adapter carries the integrated fields in its
final-decision payload; production persistence remains Tajriba as configured.

Test controls occupy a collapsible layout row instead of floating over buttons.
Their follow-up and shared-break cursors use the same versioned page list.

## Verification (2026-10-17, Europe/London)

Baseline: `main` at `0559628b7e5a92ea2223092ef207b6ec1a1ac169` plus this
uncommitted implementation. The checkout was clean before implementation.

From the repository root:

```sh
node --test --test-reporter=spec server/src/*.test.mjs server/src/prompts/*.test.mjs
npm --prefix server run build
npm --prefix client run build
node server/test/decision_flow/build-fixture.mjs
node server/test/decision_flow/check-ui.mjs
```

- **683/683 source tests passed**, zero failures or skips, including 16 new
  decision-flow tests. Real registered callbacks are exercised with in-memory
  Empirica scopes for practice and both formal rounds. Validation, disagreement,
  mismatch, deadline ordering, retries, immutable receipts, export/persistence,
  legacy routing, and revised test/shared-break cursors are covered.
- Server and client production builds passed. Client retains existing dependency
  sourcemap warnings.
- **47/47 browser checks passed**, zero browser runtime errors. The fixture mounts
  the real decision form, controls, slider, draft hook and server acceptance logic;
  Empirica transport, chat history, report content and profile are synthetic.
  Checks cover Yes/No resets, required fields, persisted drafts, pending refresh,
  dropped-request retry, accepted-response locking and 1440/390 px layouts with
  test controls expanded and collapsed. Screenshots are in
  `output/playwright/decision-flow/` (ignored generated artifacts).
- `git diff --check` passed.

These are offline and synthetic checks. No real participant session, live
Tajriba/Azure operation, external model call, or deployment was performed.

### Test-panel follow-up (2026-10-17)

All panel text, accessible labels, confirmation prompts and rejection messages are
English. Buttons preview the previous/next personal page and the next group stage.
Accepted test-control receipts include a server-computed `destination`, retained
in the latest-session feedback across stage changes. Completing a personal flow
explicitly describes waiting for the other participants before the next stage.

Follow-up verification: 31/31 focused tests passed
(`node --test --test-reporter=spec server/src/TestControls.test.mjs server/src/FinalDecisionSubmission.test.mjs`),
both production builds passed, and the synthetic browser suite passed 51/51 checks
including English-only controls and destination previews. No deployment.

### Regression and wording review (2026-10-17)

Found and reproduced one interaction defect: a delayed request after the researcher
skipped FinalDecision could overwrite `test_skipped` with `timeout_fail`; legacy
drafts could also write after a skip. Fixed the common finalizer and both legacy
request handlers, and added explicit skip checks to independent submission and
finalization. Regression tests cover v1/v2 requests before and after the deadline,
native stage-end callbacks, and preservation of prior real submissions.

The browser fixture now invokes the real test-control listener and backend:
checks include personal next/previous actions, dropped-acknowledgement retries,
practice page transitions, waiting after a personal flow, cancelled/confirmed
group advancement and destination feedback after a stage change. This extends
previous preview-only coverage. A normal v2 shared-break test also confirms that
all three arrivals, the original timer, and the shorter follow-up cursor agree.
All 21 supported page/stage identifiers were checked for readable English labels;
request/receipt, result codes and conditional response field spellings match.

Final results: **688/688 offline source tests**, **61/61 synthetic browser checks**
with zero runtime errors, both production builds, and `git diff --check` passed.
Commands are the same full source-test/build/fixture commands above. No Azure
operation, real-participant session or external model call was performed.
