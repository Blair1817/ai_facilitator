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

const escapeRegExp = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

// Facilitator text is model output (Static posts it with no validation), so
// render mentions leniently: any non-empty `@[...]` on one line (also `@ [...]`,
// with spaces after the @, as the Static model often writes it), plus a bare
// `@Name` when Name is a participant in this game. Returns plain strings and
// `{ mention }` parts; the caller decides how to render a mention.
export function splitFacilitatorMentions(text, names = []) {
  const known = [...new Set(names.filter((n) => typeof n === "string" && n.trim()).map((n) => n.trim()))]
    .sort((a, b) => b.length - a.length)
    .map(escapeRegExp);
  const bare = known.length ? `|@(${known.join("|")})(?![\\w-])` : "";
  const pattern = new RegExp(`@[ \\t]*\\[\\s*([^\\[\\]\\n]*?[^\\s\\[\\]][^\\[\\]\\n]*?)\\s*\\]${bare}`, "giu");
  const source = String(text ?? "");
  const parts = [];
  let last = 0;
  for (const match of source.matchAll(pattern)) {
    if (match.index > last) parts.push(source.slice(last, match.index));
    parts.push({ mention: match[1] ?? match[2] });
    last = match.index + match[0].length;
  }
  if (last < source.length) parts.push(source.slice(last));
  return parts;
}
