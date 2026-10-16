# Test mode and Prompt v3.2 integration verification

Date: 2026-10-16. Base commit: `23a4cdf64e11bebcad804a64aa1472d08e5ce27b`.

- Scoped source tests: **626 passed, 0 failed, 0 skipped** (`node --test src/*.test.mjs src/prompts/*.test.mjs`, from server).
- Server and client production builds: passed. Client retains existing chunk-size/source-map warnings.
- Built Prompt runtime self-check: passed, six Generator routes and manifest source hashes verified.
- `git diff --check`: passed.

The ten callback integration cases use synthetic public discussion and locally stubbed model replies. They cover the active Assessor/checker/Controller/preflight/Generator/Validator/publication path, invalid-plan fallback, bounded repair, stage-skip races, Static bypass, 49/50/51-word boundaries, internal-label disclosure, source allowlists, schema routing and forged preflight rejection.

Test mode is server-authorised by the dedicated treatment, uses a separate allocation ledger, guards stale progress submissions and pending AI publication, and excludes test sessions from default exports. Formal-study timers are preserved.

This is mechanism and regression evidence. No external LLM endpoint was called, no real-model effectiveness comparison was performed, no pilot data was modified and no Azure release was made. Equal 50-word ceilings do not establish equal realised intervention dose; monitor delivered lengths, volumes and fallback rates in subsequent evaluation.
