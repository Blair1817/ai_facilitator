/**
 * Static-only prompt context helpers.
 *
 * These helpers deliberately accept only shared round material, the current
 * round's public chat, and discussion timing. There is no parameter through
 * which private player-round data or Adaptive controller state can enter the
 * Static generator request.
 */

import { withMessageIds } from "./DynamicContext.mjs";

function formatDuration(durationMs) {
  const totalSeconds = Math.max(0, Math.floor(durationMs / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}:${String(seconds).padStart(2, "0")}`;
}

function messageTimestamp(message) {
  const timestamp = message?.timestamp ?? message?.ts;
  return Number.isFinite(timestamp) ? new Date(timestamp).toISOString() : "timestamp unavailable";
}

function isHumanMessage(message) {
  return (message?.messageType ?? message?.speakerType ?? "human") === "human" && message?.sender?.id !== "ai";
}

function isFacilitatorMessage(message) {
  return message?.messageType === "facilitator" || message?.speakerType === "facilitator" || message?.sender?.id === "ai";
}

function speakerLabel(message) {
  if (isFacilitatorMessage(message)) return "@[Facilitator]";
  const name = message?.sender?.name || "Unknown participant";
  return isHumanMessage(message) ? `@[${name}]` : `[${name}]`;
}

export function buildStaticSharedTaskOverview({ generalInfo, decisionOptions }) {
  const overviewOnly = String(generalInfo || "")
    .split(/\n##\s+/u, 1)[0]
    .replace(/^#\s+[^\n]*\n+/u, "")
    .trim();
  const alternativeLabels = Array.isArray(decisionOptions)
    ? decisionOptions.map((option) => option?.label).filter((label) => typeof label === "string" && label.trim())
    : [];
  const alternatives = alternativeLabels.length
    ? `Available alternatives: ${alternativeLabels.join(", ")}.`
    : "Available alternatives: not provided.";
  return [overviewOnly || "Shared task objective and requirements were not provided.", alternatives].join("\n\n");
}

export function buildStaticUserContext({ chat, remainingTimeMs, elapsedTimeMs }) {
  const chatWithIds = withMessageIds(Array.isArray(chat) ? chat : []);
  const transcript = chatWithIds.length
    ? chatWithIds
        .map((message) => `[${message.messageId}] [${messageTimestamp(message)}] ${speakerLabel(message)}: ${message.content ?? message.text ?? ""}`)
        .join("\n")
    : "(no public messages yet)";
  const humanMessages = chatWithIds.filter(isHumanMessage);
  const nonHumanMessages = chatWithIds.filter((message) => !isHumanMessage(message));
  const priorFacilitatorMessages = chatWithIds.filter(isFacilitatorMessage);

  return {
    userContent: [
      "[SELECTED_ROLE]\nSTATIC",
      `[DISCUSSION_TIME]\nTime remaining: ${formatDuration(remainingTimeMs)}\nElapsed discussion time: ${formatDuration(elapsedTimeMs)}`,
      `[PUBLIC_TRANSCRIPT]\n${transcript}`,
    ].join("\n\n"),
    eligibleMessageIds: humanMessages.map((message) => message.messageId),
    aiOrSystemMessageIds: nonHumanMessages.map((message) => message.messageId),
    recentAiMessageTexts: priorFacilitatorMessages.slice(-3).map((message) => message.content ?? message.text ?? ""),
    allowedGroundingIds: null,
  };
}
