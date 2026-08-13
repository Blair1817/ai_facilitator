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
 * Returns the unique, non-empty display names of every human
 * participant who has spoken (or is currently in the game) in the
 * supplied chat, in the order they first appear. AI / system /
 * facilitator speakers are excluded. The list is the canonical
 * source of `@[Name]` mention targets a Specialist / Generalist
 * may use in a participant-facing message.
 *
 * Returned as a single comma-joined string so it can be dropped
 * directly into the [ACTIVE_PARTICIPANT_NAMES] section of the
 * assembled dynamic user context without any extra formatting.
 *
 * Pure function; safe to call from tests.
 */
export function formatActiveParticipantNames(chat) {
  const seen = new Set();
  const ordered = [];
  for (const m of Array.isArray(chat) ? chat : []) {
    if (!m || m.sender?.id === "ai") continue;
    const name = typeof m.sender?.name === "string" ? m.sender.name.trim() : "";
    if (!name) continue;
    if (seen.has(name)) continue;
    seen.add(name);
    ordered.push(name);
  }
  return ordered.join(", ");
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
export function buildDynamicUserContext({ chat, checkpointDescriptor, selectedRoleForDisplay, generalInfo, plan = null, activeParticipantNames = null }) {
  const chatWithIds = withMessageIds(chat);
  const allHumanWithIds = chatWithIds.filter((m) => m.sender.id !== "ai");
  const aiWithIds = chatWithIds.filter((m) => m.sender.id === "ai");
  const localWithIds = allHumanWithIds.slice(-6);
  const recentAiWithIds = aiWithIds.slice(-3);

  const cumulativePublicContext = formatMessagesWithIds(allHumanWithIds);
  const localContext = formatMessagesWithIds(localWithIds);
  const recentAiMessagesText = recentAiWithIds.length ? formatMessagesWithIds(recentAiWithIds) : "";
  // Active participant names: if the caller did not supply an explicit
  // list (e.g. callers that know every player in the game, not just
  // those who have spoken yet), derive it from the chat. The result
  // powers the [ACTIVE_PARTICIPANT_NAMES] section every Adaptive
  // Specialist / Generalist / Static prompt now uses to pick
  // `@[Name]` mention targets.
  const activeNames = activeParticipantNames
    ? (Array.isArray(activeParticipantNames) ? activeParticipantNames.filter((n) => typeof n === "string" && n.trim()).map((n) => n.trim()).join(", ") : String(activeParticipantNames))
    : formatActiveParticipantNames(chatWithIds);

  const userContent = assembleDynamicUserContext({
    checkpoint: checkpointDescriptor,
    selectedRoleForDisplay,
    taskGeneralContext: generalInfo,
    cumulativePublicContext,
    localContext,
    recentAiMessages: recentAiMessagesText,
    // 2026-08-11: Delibra spec §11 — pipe the 3 new plan fields through
    // to the Generator's user turn. Same omit-when-plan-null rule as
    // relevantDiscussionState below: Static and Adaptive Generalist
    // (which both pass plan = null / no plan) see no change in output.
    relevantDiscussionState: plan ? plan.gap : undefined,
    target: plan ? plan.target : undefined,
    requiredReasoningAct: plan ? plan.requiredReasoningAct : undefined,
    answerableQuestionTemplate: plan ? plan.answerableQuestionTemplate : undefined,
    allowedGroundingMessageIds: plan ? plan.evidenceIds : undefined,
    // 2026-08-13: participant `@[Name]` mention-target list. Always
    // emitted (omitted only when no participant names are known at
    // all yet, e.g. the very first message of a round) so the
    // Specialist / Generalist / Static prompt can resolve any
    // `@[Name]` token to an existing participant without inventing
    // one. Cost is a single short line.
    activeParticipantNames: activeNames || undefined,
  });

  return {
    userContent,
    participantSharedContext: cumulativePublicContext,
    eligibleMessageIds: allHumanWithIds.map((m) => m.messageId),
    aiOrSystemMessageIds: aiWithIds.map((m) => m.messageId),
    recentAiMessageTexts: recentAiWithIds.map((m) => m.text),
    allowedGroundingIds: plan ? plan.evidenceIds : null,
    activeParticipantNames: activeNames ? activeNames.split(",").map((n) => n.trim()).filter(Boolean) : [],
  };
}
