import React from "react";
import { presentationForMessage } from "./facilitatorPresentation.mjs";
import { splitFacilitatorMentions } from "./chatMentions.mjs";

// React text nodes render all model content safely. Only the two explicit
// inline tokens below become elements; HTML, links and scripts stay text.
function MentionText({ text, names, keyPrefix = "m" }) {
  return splitFacilitatorMentions(text, names).map((piece, j) => (typeof piece === "string"
    ? piece
    : <span key={`${keyPrefix}-${j}`} className="mention">@{piece.mention}</span>));
}

export function FacilitatorInlineText({ text, names = [] }) {
  return String(text ?? "").split(/(\*\*[^*\n]+\*\*)/g).flatMap((part, index) => {
    if (part.startsWith("**") && part.endsWith("**") && part.length > 4) {
      return <strong key={index}><FacilitatorInlineText text={part.slice(2, -2)} names={names} /></strong>;
    }
    return MentionText({ text: part, names, keyPrefix: index });
  });
}

export function FacilitatorMessageContent({ message, names = [] }) {
  const presentation = presentationForMessage(message);
  if (!presentation) {
    return <p className="ai-facilitator-message-content">{MentionText({ text: message.content ?? message.text, names })}</p>;
  }
  return (
    <div className="ai-facilitator-message-content ai-facilitator-structured-content">
      <p><FacilitatorInlineText text={presentation.summary} names={names} /></p>
      {presentation.sections.map((section, index) => (
        <section className="ai-facilitator-content-section" key={index}>
          <h3><FacilitatorInlineText text={section.title} names={names} /></h3>
          <p><FacilitatorInlineText text={section.body} names={names} /></p>
        </section>
      ))}
      {presentation.question.trim() && (
        <div className="ai-facilitator-content-question">
          <p><FacilitatorInlineText text={presentation.question} names={names} /></p>
        </div>
      )}
    </div>
  );
}
