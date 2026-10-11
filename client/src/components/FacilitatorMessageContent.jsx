import React from "react";
import { presentationForMessage } from "./facilitatorPresentation.mjs";

// React text nodes render all model content safely. Only the two explicit
// inline tokens below become elements; HTML, links and scripts stay text.
export function FacilitatorInlineText({ text }) {
  return String(text ?? "").split(/(\*\*[^*\n]+\*\*|@\[[\w]+(?:\s+[\w]+)*\])/g).map((part, index) => {
    if (part.startsWith("**") && part.endsWith("**")) {
      return <strong key={index}><FacilitatorInlineText text={part.slice(2, -2)} /></strong>;
    }
    if (/^@\[[\w]+(?:\s+[\w]+)*\]$/.test(part)) {
      return <span key={index} className="mention">@{part.slice(2, -1)}</span>;
    }
    return part;
  });
}

export function FacilitatorMessageContent({ message, renderPlainText }) {
  const presentation = presentationForMessage(message);
  if (!presentation) {
    return <p className="ai-facilitator-message-content">{renderPlainText(message.content ?? message.text)}</p>;
  }
  return (
    <div className="ai-facilitator-message-content ai-facilitator-structured-content">
      <p><FacilitatorInlineText text={presentation.summary} /></p>
      {presentation.sections.map((section, index) => (
        <section className="ai-facilitator-content-section" key={index}>
          <h3><FacilitatorInlineText text={section.title} /></h3>
          <p><FacilitatorInlineText text={section.body} /></p>
        </section>
      ))}
      {presentation.question.trim() && (
        <div className="ai-facilitator-content-question">
          <p><FacilitatorInlineText text={presentation.question} /></p>
        </div>
      )}
    </div>
  );
}
