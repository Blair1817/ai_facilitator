export const DECISION_NUDGE = "Please work together to agree on one final choice before the discussion ends.";

export function validateDecisionResponse(response, options) {
  const validChoices = new Set((options ?? []).map((option) => option.id));
  if (!response || !validChoices.has(response.choice)) return { valid: false, reason: "choice" };
  if (!Number.isFinite(response.confidence) || response.confidence < 0 || response.confidence > 100) {
    return { valid: false, reason: "confidence" };
  }
  if (typeof response.agreesWithGroupChoice !== "boolean") return { valid: false, reason: "agreement" };
  if (!response.agreesWithGroupChoice && (!validChoices.has(response.finalPersonalChoice)
    || typeof response.finalPersonalChoiceRationale !== "string" || !response.finalPersonalChoiceRationale.trim())) {
    return { valid: false, reason: "personal_response" };
  }
  return {
    valid: true,
    response: {
      choice: response.choice,
      confidence: response.confidence,
      agreesWithGroupChoice: response.agreesWithGroupChoice,
      finalPersonalChoice: response.agreesWithGroupChoice ? null : response.finalPersonalChoice,
      finalPersonalChoiceRationale: response.agreesWithGroupChoice ? null : response.finalPersonalChoiceRationale.trim(),
    },
  };
}

export function changeDecisionResponse(current, field, value) {
  const next = { ...current, [field]: value };
  if (field === "choice" && value !== current.choice) {
    next.agreesWithGroupChoice = null;
    next.finalPersonalChoice = "";
    next.finalPersonalChoiceRationale = "";
  }
  if (field === "agreesWithGroupChoice" && value === true) {
    next.finalPersonalChoice = "";
    next.finalPersonalChoiceRationale = "";
  }
  return next;
}
