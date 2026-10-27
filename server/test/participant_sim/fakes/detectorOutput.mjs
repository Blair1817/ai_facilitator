// Test helper (2026-10-26): converts a legacy single-need detector fixture
// ({need, operation, target, rationale, integrationCandidate?, ...}) into the
// independent-candidates format ({candidates: {elicit, scrutinize, integrate}}).
// Values that are already in the new format, or are not objects, pass through.
const CATEGORY = { ELICIT: "elicit", SCRUTINIZE: "scrutinize", INTEGRATE: "integrate" };

function candidateFrom(item) {
  return {
    operation: item.operation, target: item.target, rationale: item.rationale || "audit",
    ...(item.semanticReview ? { semanticReview: item.semanticReview } : {}),
  };
}

export function toDetectorOutput(legacy) {
  if (!legacy || typeof legacy !== "object" || Array.isArray(legacy) || legacy.candidates || !("need" in legacy)) return legacy;
  const candidates = { elicit: null, scrutinize: null, integrate: null };
  if (legacy.need && legacy.need !== "NONE" && CATEGORY[legacy.need]) candidates[CATEGORY[legacy.need]] = candidateFrom(legacy);
  if (legacy.integrationCandidate && !candidates.integrate) candidates.integrate = candidateFrom(legacy.integrationCandidate);
  const out = { candidates, rationale: legacy.rationale || "audit" };
  for (const key of ["closeout", "integrationStatus", "defer"]) if (key in legacy) out[key] = legacy[key];
  return out;
}

/** Same conversion for a raw provider string; non-JSON text passes through. */
export function toDetectorText(text) {
  try { return JSON.stringify(toDetectorOutput(JSON.parse(text))); } catch { return text; }
}
