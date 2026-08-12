# Delibra Adaptive Pipeline — Implementation Logic

This engineering reference describes the current server implementation. The
live Adaptive pipeline is LLM-semantic rather than feature-server based.

## Checkpoint and routing flow

`callbacks.js` receives canonical public Discussion messages and asks the
`CheckpointManager` whether the shared checkpoint trigger has fired. Static
and Adaptive use the same checkpoint schedule, but their post-trigger routes
are intentionally separate.

### Static

Static uses the fixed Static policy with the current round's shared task
overview, complete public transcript, and available timing context. It does
not run the Adaptive detector, Gate, Policy Compiler, or role selection.

### Adaptive

At an Adaptive checkpoint:

1. `SemanticAssessor.js` makes one LLM call over the public transcript and
   returns the schema-validated semantic discussion state.
2. `EvidenceChecker.js` verifies cited message IDs and exact spans, enforces
   the multi-participant requirement for group preference, validates
   message-level evidence relations, and applies the self-correction discount.
3. `utils.js`'s `evaluateGate()` classifies the checkpoint as `specialist`,
   `generalist`, or `abstain` using only checked semantic detector strengths,
   deterministic thresholds, and remaining time.
4. `chooseRole()` selects Expander, Challenger, or Synthesiser only for a
   specialist decision. A generalist decision uses the fixed Generalist policy;
   an abstain decision publishes nothing.
5. `PolicyCompiler.js` creates a bounded, evidence-grounded plan for a selected
   Specialist. The shared Generator and Validator path then produces and checks
   the candidate facilitator message before publication.

Detector failure is fail-closed: invalid or unavailable Semantic Assessor
output reaches the Gate as unavailable checked state and resolves to abstain.

## Detector state and research persistence

The `feature_snapshots` database table name is retained by the research schema,
but its content is checkpoint audit state from the current Adaptive pipeline:

- `semantic_assessor`: raw semantic factors or assessor error;
- `evidence_checker`: checked factors and validated evidence relations;
- `gate_state`: decision, reason, eligible roles, role scores, and per-role
  classification details.

It does not contain hand-engineered discussion features. Selected role,
publication outcome, and published message linkage live in `interventions`;
validated message-level relations live in `evidence_relations`. Static
checkpoints do not produce either Adaptive snapshot type.

## Current role and threshold rules

The selectable Specialist roles are `expander`, `challenger`, and
`synthesiser`. Their deterministic thresholds and the Gate's time/margin rules
are defined in `utils.js`. These values are research configuration and should
not be changed as part of UI, persistence, or lifecycle work.

## Generator and validation boundary

Static uses the Static prompt bundle. Adaptive uses either the Generalist
bundle or the Controller-selected Specialist bundle. The participant-facing
chat receives only a validated message; rationale and detector/controller
audit data are not published to participants.

The deterministic Generator contract verifies required fields, role fidelity,
length/format requirements, duplication, and grounding against eligible public
messages. The semantic Validator may reject or repair generated output through
the shared generation path; failures resolve safely without blocking the
experiment lifecycle.

## Lifecycle boundary

Empirica/Tajriba remains authoritative for rooms, rounds, stages, timers,
reconnects, chat, ready-to-end behaviour, and S1–S4 assignment. Research
persistence is additive: assignment confirmation is fail-closed for a new
untracked game, while all non-assignment mirror writes are non-blocking.
