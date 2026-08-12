// Delegates to the modular prompt package under ./prompts (built from the
// user-provided Prompt source package -- see
// server/src/prompts/PROMPT_MODULE_STATUS.md for full provenance and
// per-file status). This replaces the earlier hand-written placeholder
// prompt text that was used before the real source material was migrated
// in.
//
// v2 design (Phase 2): TWO independent facilitator systems. Static AI
// and Adaptive AI are separate agents and do not share a prompt path.
//   - Static AI facilitator: base.md + static.md (Alsobay 2026 D.2)
//   - Adaptive AI facilitator: base.md + generalist.md (frequency control)
//                              | base.md + {expander,challenger,synthesiser}.md
//
// Contract: this returns an OBJECT ({ blocked, content, reason, metadata }),
// not a plain string, because the promptLoader's fail-closed detection
// (unresolved markers, missing files) needs the caller to detect a blocked
// prompt and skip the LLM call entirely, rather than silently sending
// incomplete content. callbacks.js's handleChat is updated to match.
//
// Routing: `role` is unused for the Static condition (Static always
// emits role "STATIC"). For the Adaptive condition, `role` is one of
// {"expander", "challenger", "synthesiser", "generalist"}:
//   - the three Specialists are routed to getAdaptivePromptBundle(role);
//   - "generalist" is the Adaptive's matched-frequency control and is
//     routed to getGeneralistPromptBundle(), NOT getAdaptivePromptBundle.
//     (They are different prompts and are deliberately not interchangeable.)
import { getStaticPromptBundle, getGeneralistPromptBundle, getAdaptivePromptBundle, assembleDynamicUserContext } from "./prompts/promptLoader.js";

export { assembleDynamicUserContext };

export function llmSystemPrompts(facilitation, role) {
    if (facilitation === "static") {
        // Static AI facilitator: role is always STATIC; ignore any role arg.
        return getStaticPromptBundle();
    }

    if (facilitation === "adaptive") {
        if (role === "generalist") {
            // Adaptive Generalist (frequency control). Separate bundle from
            // any Specialist; routed via getGeneralistPromptBundle() so the
            // dispatcher and the bundle API are symmetric.
            return getGeneralistPromptBundle();
        }
        return getAdaptivePromptBundle(role);
    }

    return {
        blocked: true,
        reason: `Unrecognized facilitation value: ${JSON.stringify(facilitation)}`,
        metadata: { promptName: null, promptVersion: null, promptStatus: null, sourceCompleteness: "unrecognized_condition", condition: facilitation ?? null, selectedRole: role ?? null },
    };
}
