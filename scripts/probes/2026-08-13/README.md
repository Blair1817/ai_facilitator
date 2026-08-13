# 2026-08-13 Diagnostic Probes

This directory contains the ad-hoc latency / model-probing / @-mention pilot
scripts that were left at `server/` on the `feat/mention-prompt-20260813`
working tree at 2026-08-13 21:14 CST. They are preserved here for archaeology
but **are not part of the production build, are not run in CI, and should
not be added to a deployment artefact**.

## When

- All files dated 2026-08-13 14:35 – 16:05 CST.
- Last verified on the codebase: 2026-08-13 21:14 CST (see
  `project-knowledge/pre-launch-check-2026-08-13.md`).

## What

| File | Purpose | Result |
| --- | --- | --- |
| `probe-models.mjs` | List which model names the MiniMax platform resolves at `/v1/models` | n/a (connectivity probe) |
| `probe-latency.mjs` | Wall-time latency for detector-size calls across `MiniMax-Text-01` / `MiniMax-M3` / `MiniMax-M2.7-highspeed` / `MiniMax-M2` | n/a (latency profile) |
| `probe-m3-combos.mjs` | Mixed-model latency candidate (Detector/Generator on `MiniMax-Text-01`, Validator on `MiniMax-M2.7-highspeed`) | median 49.9 s, no improvement over baseline |
| `probe-m3-no-reasoning.mjs` | `MiniMax-M3` with reasoning disabled | superseded by `MiniMax-M2.7-highspeed` candidate |
| `probe-m3-real-detector.mjs` | `MiniMax-M3` against a real detector-size prompt | superseded by `MiniMax-M2.7-highspeed` candidate |
| `probe-deepseek.mjs` | DeepSeek as a Vendor-of-record candidate | structural mismatch; not adopted |
| `probe-deepseek-disable.mjs` | DeepSeek with reasoning off | same conclusion as `probe-deepseek.mjs` |
| `probe-deepseek-8192.mjs` | DeepSeek with `max_tokens: 8192` (deeper output) | same conclusion as `probe-deepseek.mjs` |
| `mention-pilot.mjs` | Focused pilot for the new `@[Name]` mention capability across 5 scenarios | 5 / 5 fail on Validator, root cause = envelope parser incomplete |
| `.mention-pilot-out.json` | The captured `mention-pilot` output from 2026-08-13 16:05 CST | 5 / 5 fail, full payload preserved |

## Why they are not in `server/`

The deployment tree (`server/dist/`) is what ships to the NAS container.
Scripts in `server/` that are not imported by `server/src/index.js` or by
the build entry are unreachable at runtime, but they:

1. confuse `git status` on the next working day,
2. advertise real-looking model names and credentials in their imports
   (e.g. `api.minimax.chat`, `https://api.deepseek.com`), which makes the
   tree noisier to audit,
3. look like production code to anyone reading the repo cold.

The stabilisation pass on 2026-08-13 moved them here so the deployable root
is clean. The scripts themselves are unchanged; this is purely a location
move.

## How to re-run

```sh
# From the repo root, with server/.env present (OPENAI_API_KEY required).
node scripts/probes/2026-08-13/mention-pilot.mjs
```

The other probes follow the same pattern. They are not part of `npm test`.

## Historical note

The mention-pilot failure is the canonical evidence for the Validator
envelope parser fix that landed in
`server/src/SemanticValidator.js` on 2026-08-13. If that fix is ever
reverted, this directory is the easiest way to reproduce the failure.
