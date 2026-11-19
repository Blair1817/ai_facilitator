// Delegates to the modular prompt package under ./prompts (built from the
// user-provided Prompt source package -- see
// server/src/prompts/PROMPT_MODULE_STATUS.md for full provenance and
// per-file status). This replaces the earlier hand-written placeholder
// prompt text that was used before the real source material was migrated
// in.
//
// Only the Adaptive Specialists are routed here:
//   specialist_base.md + specialist_common.md + {expander,challenger,synthesiser}.md
// The Static condition and the Adaptive Static-policy turn (no Specialist,
// or a failed Specialist) send the Alsobay et al. request instead
// (AlsobayStatic.mjs; docs/static-alsobay-replication.md). @Facilitator in
// Adaptive uses promptLoader.getRequestedGeneralistPromptBundle() directly.
// The control_50 Static/automatic-Generalist prompts were deleted on
// 2026-11-19, so "static" and "adaptive"+"generalist" return blocked.
//
// Contract: this returns an OBJECT ({ blocked, content, reason, metadata }),
// not a plain string, because the promptLoader's fail-closed detection
// (unresolved markers, missing files) needs the caller to detect a blocked
// prompt and skip the LLM call entirely, rather than silently sending
// incomplete content. callbacks.js's handleChat is updated to match.
//
import { getAdaptivePromptBundle, assembleDynamicUserContext } from "./prompts/promptLoader.js";

export { assembleDynamicUserContext };

export function llmSystemPrompts(facilitation, role) {
    if (facilitation === "static" || (facilitation === "adaptive" && role === "generalist")) {
        return {
            blocked: true,
            reason: "No automatic non-Specialist prompt bundle: Static and the Adaptive Static-policy turn send the Alsobay et al. request (AlsobayStatic.mjs).",
            metadata: { promptName: null, promptVersion: null, promptStatus: null, sourceCompleteness: "retired_route", condition: facilitation, selectedRole: role ?? null },
        };
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
