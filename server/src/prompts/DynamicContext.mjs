/**
 * DynamicContext.mjs
 *
 * Pure helpers for the Dynamic User Prompt. No Empirica import, no fetch,
 * no dotenv -- safe to import and test directly, same reasoning as
 * GeneratorContract.mjs. Extracted out of callbacks.js specifically so this
 * logic is testable without importing callbacks.js itself (that file
 * registers real Empirica listeners and imports dotenv/fetch on load -- see
 * RoutingIntegration.test.mjs's header comment for why this repo's existing
 * convention avoids executing it directly in tests).
 *
 * GRAIL scope-reduction refactor: this is now the ONE context builder both
 * Static and Adaptive use (previously Adaptive-only, Static used a
 * separate, non-id-annotated formatter directly in callbacks.js). Renamed
 * from buildAdaptiveDynamicUserContext to buildDynamicUserContext to match.
 */

import { assembleDynamicUserContext } from "./promptLoader.js";

export { assembleDynamicUserContext };

/**
 * Empirica chat entries ({text, ts, sender}, appended via game.append)
 * carry no dedicated id field -- confirmed by reading every game.append
 * call in callbacks.js. groundingMessageIds (generation.schema.json)
 * cannot be validated against real IDs without one, so this derives a
 * stable, deterministic positional id ("m<index-in-the-round's-chat-array>")
 * -- mechanical, not a new policy value, and stable because the chat array
 * is append-only (a message's index never changes once assigned).
 */
export function withMessageIds(chat) {
  return chat.map((m, idx) => ({ ...m, messageId: `m${idx}` }));
}

export function formatMessagesWithIds(messages) {
  return messages.map((m) => `[${m.messageId}] [${m.sender.name}]: ${m.text}`).join("\n");
}

/**
 * Builds the public-context strings and eligible-ID sets from the full
 * round chat array, and assembles the Dynamic User Prompt via
 * promptLoader's existing builder (no second builder).
 *
 * Context boundaries: only `chat` (the public, participant + AI transcript
 * already visible to everyone in the group) is read here -- never
 * player.round-scoped private profile content, never correct-answer data,
 * never controller thresholds/reasoning. AI messages are kept out of
 * CUMULATIVE_PUBLIC_CONTEXT/LOCAL_CONTEXT entirely and surfaced only via
 * recentAiMessageTexts, matching RECENT_AI_MESSAGES.
 *
 * `plan` (optional, added 2026-08-07): PolicyCompiler.js's output for an
 * Adaptive checkpoint. When present, its `gap` fills RELEVANT_DISCUSSION_STATE
 * (see promptLoader.js's assembleDynamicUserContext) and its `evidenceIds`
 * is returned as `allowedGroundingIds` so callbacks.js can pass a
 * plan-scoped (rather than whole-transcript-scoped) grounding check into
 * GeneratorContract.mjs's runDeterministicValidation. Omitting `plan`
 * (every pre-existing call site, and every Static call) leaves this
 * function's return value byte-for-byte identical to before.
 */
export function buildDynamicUserContext({ chat, checkpointDescriptor, selectedRoleForDisplay, generalInfo, plan = null }) {
  const chatWithIds = withMessageIds(chat);
  const allHumanWithIds = chatWithIds.filter((m) => m.sender.id !== "ai");
  const aiWithIds = chatWithIds.filter((m) => m.sender.id === "ai");
  const localWithIds = allHumanWithIds.slice(-6);
  const recentAiWithIds = aiWithIds.slice(-3);

  const cumulativePublicContext = formatMessagesWithIds(allHumanWithIds);
  const localContext = formatMessagesWithIds(localWithIds);
  const recentAiMessagesText = recentAiWithIds.length ? formatMessagesWithIds(recentAiWithIds) : "";

  const userContent = assembleDynamicUserContext({
    checkpoint: checkpointDescriptor,
    selectedRoleForDisplay,
    taskGeneralContext: generalInfo,
    cumulativePublicContext,
    localContext,
    recentAiMessages: recentAiMessagesText,
    relevantDiscussionState: plan ? plan.gap : undefined,
  });

  return {
    userContent,
    participantSharedContext: cumulativePublicContext,
    eligibleMessageIds: allHumanWithIds.map((m) => m.messageId),
    aiOrSystemMessageIds: aiWithIds.map((m) => m.messageId),
    recentAiMessageTexts: recentAiWithIds.map((m) => m.text),
    allowedGroundingIds: plan ? plan.evidenceIds : null,
  };
}
