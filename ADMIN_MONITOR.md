# Live admin monitor

Open `<exports host>/exports/monitor` (same host and port as research exports).

## Who can do what

| Login | Can |
| --- | --- |
| Export account (`EXPORT_AUTH_USERNAME` / `EXPORT_AUTH_PASSWORD`) | View only: running games, each participant's online status and personal page, live chat (redacted like exports). |
| Empirica admin (any `[[tajriba.auth.users]]` in `empirica.toml`, same as `/admin`) | Everything above, unredacted chat, rejoin links, and controls. Can also log in to the export pages under `/exports/` (same redaction and raw-export rules as the export account; downloads are audited under the admin's username). |

Admin accounts are read from the file in `TAJRIBA_CONFIG`. If it is not set, the monitor is view-only and logs a warning.

## Controls (admin only)

- **Move a participant to a page**: click a page chip in their row. This only works within the current stage's personal pages (Preparation, Follow-up, practice introduction).
  - Going back clears completion markers from that page onward. Saved answers stay, and the page timer restarts.
  - Going forward leaves skipped pages unanswered (recorded as missing).
  - You can't jump past an unfinished shared break.
- **End current stage (counts as time up)**: ends the stage for the whole group. The normal timeout handling runs (for example, an unconfirmed group decision is recorded as a timeout), and the stage is marked `adminEndedAt`.
- **Skip shared break**: available once all three participants have reached the break.
- **Rejoin link**: copies the participant's original Prolific link (set `MONITOR_PARTICIPANT_URL` to the participant site origin, e.g. `https://study.example.org`). For identifier-based logins, the monitor shows the identifier to re-enter.

A stage that has already ended cannot be reopened (Empirica stages only move forward).

Every control attempt is logged on the game as `adminControlEvents` (actor, action, participant, outcome) and in the export audit file. Accepted interventions appear in research exports: a **Researcher intervention** line per round in the Markdown and HTML transcripts, `adminControlEvents` in `meta.json`, and a new last CSV column `admin_interventions` (e.g. `end_stage:FinalDecision@<ms>;goto_page:Preparation->3@<ms>`). An early-ended group decision is therefore distinguishable from a natural `timeout_fail`. Requests are rejected if the stage or that participant's progress changed since the page last refreshed.

Note: online status comes from connect and disconnect events seen since the callbacks process started.
