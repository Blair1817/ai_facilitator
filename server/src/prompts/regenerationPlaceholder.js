/**
 * regenerationPlaceholder.js
 *
 * GRAIL scope-reduction refactor: regeneration/retry orchestration is
 * DELIBERATELY NOT part of the live discussion runtime path. It was wired
 * in during an earlier revision of this codebase (Prompt 3B, via the now-
 * deleted prompts/AdaptivePipeline.mjs); this revision removes it per the
 * scope-reduction objective ("do not build or preserve duplicate ... retry
 * ... systems"). The live path now makes exactly one Generator LLM call
 * per checkpoint: invalid output is logged and treated as Silent, with no
 * second attempt (see server/src/callbacks.js's runSharedGeneration).
 *
 * No regeneration.md, schema, or research-authored retry/fallback policy
 * ever existed in the source package either (prompt_design_specification.Rmd's
 * own checklist still has "编写 `regeneration.md`" unchecked).
 *
 * This module name is preserved unchanged (not renamed, not deleted) so a
 * later, separate task can reintroduce regeneration deliberately, rather
 * than needing to re-create this status/contract surface from scratch.
 */

export function getRegenerationStatus() {
  return {
    implemented: false,
    calledInLiveRuntime: false,
    maxGeneratorAttempts: 1,
    promptAvailable: false,
    schemaAvailable: false,
    reason: "Regeneration/retry orchestration removed from the live discussion runtime path (GRAIL scope-reduction refactor). Exactly one Generator attempt is made per checkpoint; invalid output is logged and treated as Silent.",
  };
}

/**
 * Always returns NOT_IMPLEMENTED. Present so a future task has a stable
 * call site; deliberately not called by callbacks.js or any other
 * production code.
 */
export function regenerate(_previousAttempt, _validationResult) {
  return {
    status: "NOT_IMPLEMENTED",
    ...getRegenerationStatus(),
  };
}
