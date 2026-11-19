/**
 * Shared public task overview.
 *
 * Builds the task objective, requirements and option labels that every
 * participant sees, for the Adaptive Specialist and participant-requested
 * Generator context (TASK_GENERAL_CONTEXT). It accepts only shared round
 * material, so no private player-round data can enter through it.
 *
 * The Static condition no longer has a context builder here: it sends the
 * Alsobay et al. request (../AlsobayStatic.mjs).
 */

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
