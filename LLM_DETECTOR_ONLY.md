# LLM-only detector decision

Effective on branch `llm-detector-only` from 2026-08-11.

The adaptive condition no longer extracts, stores, gates on, or weights
hand-engineered discussion features. In particular, novelty, redundancy,
agreement, justification, Gini, embedding similarity, and the Python feature
sidecar are outside the live decision path.

## Live classification path

1. At each eligible adaptive checkpoint, one LLM detector call assesses all
   eight public-discussion semantic factors and returns a 0–1 strength plus an
   exact cited span for every factor marked present.
2. `EvidenceChecker.js` verifies spans and participant requirements and reduces
   deficiency strengths when recent self-correction is already visible.
3. `utils.js` derives role scores only from the checked LLM strengths:
   - Expander = `breadth_deficiency`
   - Challenger = mean(`group_preference`, `justification_deficiency`), with
     both factors required
   - Synthesiser = `integration_deficiency`
4. Deterministic rules apply the time floor, per-role thresholds, and top-two
   margin to classify the checkpoint as `specialist`, `generalist`, or
   `abstain`.

The Generator does not rescore or reclassify the discussion. Logs retain the
raw detector factors, checked detector factors, derived role scores, per-role
rule results, and final gate decision for audit and future validity testing.

## Building from OneDrive

The server build deliberately copies only the required JSON/prompt resources
and uses esbuild's `--packages=external` mode. This avoids rsync directory
reconciliation and avoids traversing thousands of small dependency files
through the OneDrive file provider. Production must retain/install the
dependencies declared in `server/package.json` next to `dist`; `npm run dev`
already satisfies this contract.

## Reversibility

`main` points to commit `040736a`, the complete pre-change baseline. The
original source and prior facilitation state also remain in the dated archives
under `reversible_baselines/`. Files removed on this branch remain recoverable
from `main`; no baseline archive was overwritten.
