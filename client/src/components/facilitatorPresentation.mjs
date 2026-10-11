// Shared by generation validation and chat rendering. Structured messages have
// one canonical plain-text representation for grounding, word limits and exports.
export function plainPresentationText(text) {
  return text.replace(/\*\*([^*\n]+)\*\*/g, "$1").trim();
}

export function presentationToText(presentation) {
  return [
    presentation.summary,
    ...presentation.sections.flatMap(section => [section.title, section.body]),
    presentation.question,
  ].map(plainPresentationText).filter(Boolean).join("\n\n");
}

function isDisplayText(value, allowEmpty = false) {
  if (typeof value !== "string" || value.length > 1500 || (!allowEmpty && !value.trim())) return false;
  // Only inline bold and participant mentions are formatting instructions.
  const plain = value.replace(/\*\*([^*\n]+)\*\*/g, "$1");
  return !/\*\*|`|(^|\n)\s*(?:#{1,6}\s|[-*+]\s|\d+[.)]\s|>|---\s*$)|<\/?[a-z][^>]*>|!?\[[^\]]*\]\([^)]*\)/im.test(plain);
}

export function isFacilitatorPresentation(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  if (Object.keys(value).sort().join(",") !== "question,sections,summary") return false;
  if (!isDisplayText(value.summary) || !isDisplayText(value.question, true)) return false;
  if (!Array.isArray(value.sections) || value.sections.length > 6) return false;
  if (!value.sections.every(section => section && typeof section === "object"
    && Object.keys(section).sort().join(",") === "body,title"
    && isDisplayText(section.title) && section.title.length <= 100
    && isDisplayText(section.body))) return false;
  return presentationToText(value).length <= 1500;
}

export function normalizeGeneratorCandidate(candidate) {
  if (typeof candidate.message === "string") return candidate;
  if (!isFacilitatorPresentation(candidate.message)) return candidate;
  return { ...candidate, message: presentationToText(candidate.message), presentation: candidate.message };
}

export function presentationForMessage(message) {
  const presentation = message?.presentation;
  return isFacilitatorPresentation(presentation)
    && presentationToText(presentation) === (message.content ?? message.text)
    ? presentation : null;
}
