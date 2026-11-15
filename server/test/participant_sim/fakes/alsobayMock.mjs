// Test helpers for the Alsobay et al. Static request (AlsobayStatic.mjs).
export const ALSOBAY_PROMPT_START = "A group of decision makers are meeting to decide on ";
export const isAlsobayPrompt = system => typeof system === "string" && system.startsWith(ALSOBAY_PROMPT_START);
/** Convert a legacy {role, message} Static reply fixture into the Alsobay {MESSAGE, RATIONALE} shape. */
export function toAlsobayReply(reply) {
  if (reply == null || typeof reply === "string" || reply.MESSAGE !== undefined) return reply;
  const m = reply.message;
  const text = typeof m === "string" ? m
    : m && typeof m === "object" ? [m.summary, ...(m.sections || []).flatMap(s => [s.title, s.body]), m.question].filter(Boolean).join("\n\n") : m;
  return { MESSAGE: text, RATIONALE: "mock rationale" };
}
