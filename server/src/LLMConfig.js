// Delegates to the modular prompt package under ./prompts (built from the
// user-provided Prompt source package -- see
// server/src/prompts/PROMPT_MODULE_STATUS.md for full provenance and
// per-file status). This replaces the earlier hand-written placeholder
// prompt text that was used before the real source material was migrated
// in.
//
// Contract change from the earlier placeholder version: this now returns an
// OBJECT ({ blocked, content, reason, metadata }), not a plain string,
// because the real static.md is a skeleton (see PROMPT_MODULE_STATUS.md)
// and the caller (callbacks.js's handleChat) must be able to detect a
// blocked prompt and skip the LLM call entirely, rather than silently
// sending incomplete content. callbacks.js has been updated to match this
// contract.
import { getStaticPromptBundle, getAdaptivePromptBundle, assembleDynamicUserContext } from "./prompts/promptLoader.js";

export { assembleDynamicUserContext };

export function llmSystemPrompts(facilitation, role) {
    if (facilitation === "static") {
        return getStaticPromptBundle();
    }

    if (facilitation === "adaptive") {
        return getAdaptivePromptBundle(role);
    }

    return {
        blocked: true,
        reason: `Unrecognized facilitation value: ${JSON.stringify(facilitation)}`,
        metadata: { promptName: null, promptVersion: null, promptStatus: null, sourceCompleteness: "unrecognized_condition", condition: facilitation ?? null, selectedRole: role ?? null },
    };
}
