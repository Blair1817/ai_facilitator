// Single source of truth for interpreting the `facilitation` treatment factor.
// Do not re-implement this check elsewhere (e.g. by comparing facilitation to a
// literal string, or to an ad-hoc allow-list) -- import resolveFacilitationDispatch.
//
// Canonical values, matching .empirica/treatments.yaml's `facilitation` factor
// exactly (verified against the actual YAML, not assumed):
export const FACILITATION_NONE = "none";
export const FACILITATION_STATIC = "static";
export const FACILITATION_ADAPTIVE = "adaptive";

const LLM_CONDITIONS = [FACILITATION_STATIC, FACILITATION_ADAPTIVE];

// BLOCKER: server/src/LLMConfig.js's llmSystemPromptTemplates currently only
// defines "LLM" and "human" prompt templates -- there is no template
// addressable by "static" or "adaptive" yet, so calling
// llmSystemPrompts("static" | "adaptive", ...) today returns undefined.
// This reflects that real, current state. Flip an entry to true only once
// LLMConfig.js actually defines a prompt/intervention handler addressable by
// that exact condition value -- implementing that is out of scope here
// (Static/Adaptive role prompts, feature thresholds, and the adaptive
// controller are separate, not-yet-implemented work).
const INTERVENTION_HANDLER_IMPLEMENTED = {
  [FACILITATION_STATIC]: false,
  [FACILITATION_ADAPTIVE]: false,
};

/**
 * Resolves a raw `facilitation` treatment value into a dispatch decision.
 *
 * Returns:
 *   { kind: "none", eligible: false, reason }        -- dev/test, never call the LLM
 *   { kind: "static"|"adaptive", eligible: false, reason } -- recognized condition,
 *       but no intervention handler implemented for it yet (fail closed)
 *   { kind: "static"|"adaptive", eligible: true, reason: null } -- recognized AND
 *       has an implemented handler; safe to dispatch
 *   { kind: "unknown", eligible: false, reason }      -- missing/misspelled/legacy
 *       value (e.g. the old "LLM" sentinel); fail closed
 */
export function resolveFacilitationDispatch(facilitation) {
  if (facilitation === FACILITATION_NONE) {
    return { kind: "none", eligible: false, reason: "facilitation is none; no AI condition" };
  }

  if (typeof facilitation !== "string" || !LLM_CONDITIONS.includes(facilitation)) {
    return {
      kind: "unknown",
      eligible: false,
      reason: `unrecognized facilitation value: ${JSON.stringify(facilitation)}`,
    };
  }

  if (!INTERVENTION_HANDLER_IMPLEMENTED[facilitation]) {
    return {
      kind: facilitation,
      eligible: false,
      reason: `"${facilitation}" condition recognized, but no intervention handler is implemented yet`,
    };
  }

  return { kind: facilitation, eligible: true, reason: null };
}
