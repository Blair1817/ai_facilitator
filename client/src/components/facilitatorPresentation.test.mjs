import assert from "node:assert/strict";
import test from "node:test";
import { isFacilitatorPresentation, normalizeGeneratorCandidate, presentationForMessage, presentationToText } from "./facilitatorPresentation.mjs";

const presentation = {
  summary: "Here’s a summary of what your group has shared:",
  sections: [
    { title: "Option A", body: "You’ve discussed its cost, but its delivery time is still unclear." },
    { title: "Option B", body: "You’ve discussed its delivery time, but its cost is still unclear." },
  ],
  question: "What information could help your group compare these **two open questions**?",
};

test("structured messages retain all visible content in canonical plain text", () => {
  const candidate = { role: "GENERALIST", message: presentation, groundingMessageIds: ["m1"] };
  const normalized = normalizeGeneratorCandidate(candidate);
  assert.equal(candidate.message, presentation, "does not mutate model output");
  assert.match(normalized.message, /Option A\n\nYou’ve discussed its cost/);
  assert.match(normalized.message, /these two open questions\?/);
  assert.equal(normalized.message.includes("**"), false);
  assert.equal(presentationForMessage({ content: normalized.message, presentation }), presentation);
});

test("old messages and mismatched or malformed presentation fall back to plain text", () => {
  const old = { role: "STATIC", message: "What else could you share?", groundingMessageIds: [] };
  assert.equal(normalizeGeneratorCandidate(old), old);
  assert.equal(presentationForMessage({ text: old.message }), null);
  assert.equal(presentationForMessage({ content: "Different audited text", presentation }), null);
  assert.equal(presentationForMessage({ content: "Text", presentation: { sections: null } }), null);
});

test("structured messages reject hidden fields, HTML, block markup and excessive combined length", () => {
  assert.equal(isFacilitatorPresentation({ ...presentation, rationale: "hidden" }), false);
  for (const summary of ["<script>alert(1)</script>", "# Heading", "- Bullet", "[link](https://example.com)", "**unclosed", " "]) {
    assert.equal(isFacilitatorPresentation({ ...presentation, summary }), false, summary);
  }
  assert.equal(isFacilitatorPresentation({ ...presentation, sections: Array(7).fill(presentation.sections[0]) }), false);
  assert.equal(isFacilitatorPresentation({ summary: "s".repeat(800), sections: [], question: "q".repeat(800) }), false);
});

test("brief interventions need no sections or closing question; mentions remain in canonical text", () => {
  const brief = { summary: "Could **@[Blue]** clarify that point?", sections: [], question: "" };
  assert.equal(isFacilitatorPresentation(brief), true);
  assert.equal(presentationToText(brief), "Could @[Blue] clarify that point?");
});
