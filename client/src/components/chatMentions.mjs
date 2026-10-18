export const CHAT_MENTION_TRIGGER = "@";
export const CHAT_MENTION_MARKUP = "@[__display__]";
export const CHAT_MENTION_PATTERN = /@\[(\w+(?:\s+\w+)*)\]/g;

export function buildChatMentionUsers(players, currentPlayerId, { isPractice, facilitation }) {
  const users = players
    .filter((participant) => participant.id !== currentPlayerId)
    .map((participant) => ({
      id: participant.id,
      display: participant.get("name"),
    }));

  if (isPractice || (facilitation !== "none" && facilitation !== "human")) {
    users.push({ id: "ai", display: "Facilitator" });
  }

  return users;
}
