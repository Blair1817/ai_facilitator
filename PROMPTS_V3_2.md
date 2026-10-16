# Prompt v3.2 runtime integration

All automatically triggered Static, Adaptive Generalist and Specialist interventions use **at most 50 English words**, including every visible structured field. There is no minimum. Exactly 50 is valid; 51 is rejected. Participant-requested `@Facilitator` replies keep their separate original policy.

## Active sources and routing

The authoritative active package is `server/src/prompts/source/runtime/`:

- `control_50/`: Static and automatic Generalist, with their original facilitation policies and the common word ceiling.
- `specialist/`: Specialist base/common, Expander, Challenger, Synthesiser, Assessor, Validator and schemas.
- `frozen_control/`: original participant-requested Generalist bundle and historical baseline. Never route automatic calls here.
- `manifest.json`: source and composed-bundle hashes. Startup fails on a missing or modified declared source. Original files directly under `source/` are retained for historical contracts/replay, not selected by the live loader.

The [complete review specification](docs/prompts/Delibra-Control-v3.2.md) explains the research rationale. The implementation details below supersede its statements that the system has not yet been connected.

## Pipeline

Public formal-round transcript -> Assessor -> exact per-message quote checking -> deterministic need gate -> fixed-role cognitive operation -> input/source preflight -> Generator -> schema/word/sentence/grounding/disclosure checks -> role-specific semantic Validator -> publication.

Assessor now supplies `cognitiveTargets`, describing observable public needs, source quotes, existing options/criteria and whether the target is open/addressed. It does not select a role or write an intervention. The Controller maps these observations to the ten specified operations. This adds no separate model call. Legacy single-span factor records remain replayable; new model calls request the per-message evidence format.

Single-person claims can trigger scrutiny without asserting group agreement. Challenger uses the strongest checked justification/concern/link need (or the former preference/justification score, whichever is larger). At least one actual reasoning need is required. Existing numeric thresholds, priority band, timing, opportunity frequency and cooldown stay unchanged. Role selection no longer switches merely to introduce variety.

A missing public target, incomplete sources, invalid role-operation combination, unsupported participation targeting, already-addressed target or repeated delivered operation/target cannot enter the Specialist Generator. The same checkpoint uses the existing automatic Generalist path. A real candidate may be repaired once; persistent semantic rejection switches to Generalist with Specialist plan/preflight/history sections removed. Rejected drafts are never published or counted as uptake.

Per-message quotes are mechanically verified against the same positional IDs used by the Generator and Validator. Quote matching proves text exists; it does not prove semantic interpretation. The semantic Validator still checks actual public claims. Public-unit/scope differences cannot be silently turned into numerical conversions, contradictions, weights or recommendations.

Assessor output capacity is at least 4096 tokens because eight factors plus source quotations/targets may exceed the former 1000-token setting. Generator/Validator use the existing configured budget. Provider/model configuration is not changed; the deployment's configured GPT model remains authoritative.

## Audit and experimental scope

Published automatic messages record their actual visible word count and prompt hash/version. Specialist history is round-scoped, includes the actual delivered message ID/operation/target and is passed back to the Assessor. Current public target status and delivered history inform repetition checks; acknowledgement, silence and unavailable history do not prove uptake or failure. This is not a causal measure of participant uptake or decision quality.

Controls retain their original two-sentence policy; Specialists allow three sentences. A common maximum word budget does not guarantee equal realised length, information content or reading burden. Measure actual word counts, per-round delivered volume and fallback rates when evaluating the package.

## Editing and verification

After an intentional source edit:

```sh
# From server/
node scripts/sync-prompt-manifest.mjs --fixtures
node --test src/*.test.mjs src/prompts/*.test.mjs
npm run build
# From client/
npm run build
```

The synchronisation command refreshes hashes and the isolated callback simulation's resources; it does not call a model. Changing a hash without reviewing the changed Prompt is not research approval.

`PromptRuntimeIntegration.test.mjs` drives the real callbacks with synthetic public messages and locally stubbed model responses. It covers Specialist publication, invalid-plan Generalist routing, bounded repair/fallback, Static bypass, automatic/requested budget separation, forged preflight rejection and a researcher stage skip while validation is outstanding. These are offline mechanism checks, not GPT-5.6 effectiveness measurements.

No live pilot, real-model evaluation, container restart or Azure release is performed by this integration. Use the immutable Azure image pipeline for a separately authorised deployment.
