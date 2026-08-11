# Pilot Prep — HCI Project II (AI-assisted GDM)

> Status: code is **Phase 1-6 complete and frozen**. All 226 server
> tests pass. Built `server/dist/index.js` is up to date. Ready for
> pilot runs as soon as the API key is dropped in.

## 1. Where the API key goes

**`server/.env`** — gitignored, exists only on this machine. Create
it from the template, then fill in two real values.

```bash
cd server
cp .env.example .env       # only if .env doesn't exist yet
# then open server/.env in your editor and replace:
#   OPENAI_API_KEY="your-key-here"  ->  OPENAI_API_KEY="<the real key>"
```

`.env` is gitignored by the root `.gitignore` rule `*.env`, so the
real key never accidentally lands in git. The template
(`server/.env.example`) is the public placeholder; the real file
(`server/.env`) is private.

While you're in there, also verify these match the platform you'll
hit:

```ini
LLM_API_ENDPOINT="https://api.minimax.chat/v1"
OPENAI_API_KEY="<your real key>"
OPENAI_MODEL="gpt-4o-2024-08-06"   # see "Model name" below
LLM_MAX_OUTPUT_TOKENS=1000
```

### Model name

Default is the OpenAI `gpt-4o-2024-08-06` snapshot. If
`api.minimax.chat` is **MiniMax's native API** (not an OpenAI
passthrough), this string will not resolve. Two ways to find the
right one:

```bash
curl -sS "https://api.minimax.chat/v1/models" \
  -H "Authorization: Bearer $YOUR_KEY"
```

…then read the `id` field of the JSON response and put that into
`OPENAI_MODEL`. Whatever string ends up there is what gets
recorded in `systemInfo.model` on every Game and in every `llmLog`
entry, so the post-hoc analysis can recover exactly which
snapshot produced each intervention.

## 2. Two processes the pilot needs running

The Empirica callbacks server (`npm run dev`) expects Tajriba to be up.
The adaptive path now uses the LLM-only detector; no feature sidecar runs.

| Process | What | Port | Already running? |
|---|---|---|---|
| Tajriba (Empirica backend + admin) | Stores games, chat, llmLog; serves admin UI | 3000 (admin) | Check: `curl -sS http://localhost:3000/admin` |
| Callbacks server (this Node app) | Runs `server/dist/index.js`; calls the LLM, applies the controller, writes to Tajriba | 3002 (game) | Started by `npm run dev` |

If Tajriba is not running, start it from the project root through the backup guard:

```bash
cd /path/to/ai_facilitator-main
./scripts/safe-empirica-start.sh
```

(The `srtoken` and admin password are already set in
`.empirica/empirica.toml` — `local-test-token` / `admin` /
`localtest` for local dev.)

## 3. Pre-flight checklist (run before the first pilot)

```bash
cd /path/to/ai_facilitator-main

# A. Tajriba up
curl -sS http://localhost:3000/admin > /dev/null && echo "✓ Tajriba" || echo "✗ Tajriba DOWN"

# B. .env exists with real key (not "your-key-here")
[ -f server/.env ] && ! grep -q "your-key-here" server/.env \
  && echo "✓ .env has real key" || echo "✗ .env missing or still placeholder"

# C. dist built and current (Phase 6 has the @-mention + Validator + repair loop)
ls -la server/dist/index.js
# should be ~2.99MB, dated today

# D. Prompt package self-check passes
cd server
node -e "import('./src/prompts/promptLoader.js').then(m => \
  console.log(m.runStartupSelfCheck({throwOnFailure:false}).ok ? '✓ 11 files verified' : '✗ SELF-CHECK FAILED'))"
```

If any line is `✗`, fix that step before launching the pilot — the
empirica callbacks server will refuse to start if `.env` is missing
or contains the placeholder (the `runStartupSelfCheck` at boot
throws and exits with code 1).

## 4. Start the callbacks server

```bash
cd server
npm run dev
```

This will (a) `rsync` the non-JS files (`*.md`, `*.json`,
`*.Rmd`) from `server/src/` to `server/dist/`, then (b) re-bundle
`dist/index.js` with esbuild, then (c) start the callbacks server
with source maps and an unhandled-rejection fail-fast.

You should see this in the console within ~1 second of starting:

```
[promptLoader] Startup self-check passed (11 files verified, prompt package version v0.1-draft).
server: started
```

The first line is the prompt-package self-check (Phase 2.5). The
second is the Empirica "ready" event. **If the first line says
FAILED**, the server has crashed on purpose; the error message
names the offending file. Fix the file, restart.

## 5. Smoke test the LLM (no real participants yet)

After the server is running, trigger one chat message in a test
Game (or use the admin UI to add a fake chat) and watch the
server console. The first intervention will look like:

```
[pipeline] Generator (round 1, attempt 1) -> Validator (passed)
[LLM] role=STATIC, message="...", grounding=[m0, m1]
[publish] -> chatRound_0
```

If you see `Validator (passed)` on the first try, the full
Phase 5 pipeline (Generator + Validator LLM + repair loop + log
markers) is wired correctly end-to-end. If the Validator flags
something and the repair attempt also fails, you'll see:

```
[Validator] attempt 1 -> notGrounded, recommendationDetected
[repair] Generator (attempt 2) with [PRIOR_FAILED_CRITERIA] hint
[Validator] attempt 2 -> notGrounded
[outcome] SILENT_VALIDATOR_REJECTED
```

…with the `llmLog` entry showing `failedCriteria` for both
attempts.

## 6. What to check in the first 3-5 pilot games

Per checkpoint, watch the `llmLog` entries (admin panel > Game >
llmLog) for:

| Field | Healthy | Unhealthy |
|---|---|---|
| `trigger.reason` | `ok` or `mention_bypass` | `cap_reached` (more than 3 times/round), `cooldown` (constantly), `time_floor` (in last 30s) |
| `outcome` | `PUBLISHED` | `SILENT_VALIDATOR_REJECTED` (LLM cannot satisfy Validator 2x in a row) |
| `attempts` | 1 | 2 (means a repair happened; check the failedCriteria) |
| `messageAdded` | true | false (Generator produced text but publication failed) |
| `validator.booleans` | mostly all-false | any field consistently `true` (means the LLM has a systematic bias to fix in the prompt) |
| `validatorRepair` | (absent if attempts=1) | shows the 2nd attempt's verdict |

Per-round:
- Static round: every checkpoint should publish a message
  (no abstention logic).
- Adaptive round: should see 1-3 publishes per round, mostly
  `specialist` decision (occasionally `generalist` when the
  margin is too close), very rarely `abstain`.

## 7. Tearing down

Ctrl-C the callbacks server. Tajriba can stay running across pilot runs.
The local data is normally in `.empirica/local/tajriba.json`. Run
`./scripts/backup-tajriba.sh` after every completed pilot/Game and copy the
resulting `.empirica/backups/` files to an independently backed-up research
data location. Always use `./scripts/safe-empirica-start.sh` for subsequent
starts. A normal same-version restart should reopen the same embedded database;
the guard protects against accidental deletion/replacement and incompatible
Empirica upgrades, which are the destructive cases.

## 8. What is NOT in this prep

- **No real API key yet** — drop one in `server/.env` when you
  have it.
- **No model name finalised** — the default is
  `gpt-4o-2024-08-06`; if `api.minimax.chat` rejects it, swap to
  whatever `v1/models` returns (see §1 above).
- **No participant recruitment** — that's outside this repo.
- **No post-hoc analysis scripts** — those read the configured Tajriba data
  file (locally `.empirica/local/tajriba.json`) + the `llmLog` array per game. The
  `audit-phase1.md` v3 doc lists the fields to expect.
