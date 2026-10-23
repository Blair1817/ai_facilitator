import Ajv from "ajv";

// Internal OpenAI generation shape; public candidates keep the existing schema.
export function buildSynthesisPointContract(optionLabels, allowedIds) {
  const ids = [...new Set(allowedIds || [])];
  const options = [...new Set(optionLabels || [])];
  if (!ids.length || !options.length) return null;
  const idList = { type: "array", items: { type: "string", enum: ids } };
  const schema = {
    type: "object", additionalProperties: false,
    properties: {
      role: { type: "string", enum: ["INFORMATION_SYNTHESISER"] },
      scoreboard: { type: "array", minItems: 1, maxItems: options.length, items: {
        type: "object", additionalProperties: false, properties: {
          option: { type: "string", enum: options },
          points: { type: "array", minItems: 1, maxItems: 2, items: {
            type: "object", additionalProperties: false, properties: {
              text: { type: "string", minLength: 1, maxLength: 500 },
              sourceMessageIds: { ...idList, minItems: 1 },
            }, required: ["text", "sourceMessageIds"],
          } },
        }, required: ["option", "points"],
      } },
      question: { type: "string", minLength: 1, maxLength: 500 },
      questionGroundingMessageIds: idList,
    }, required: ["role", "scoreboard", "question", "questionGroundingMessageIds"],
  };
  return {
    responseSchema: { name: "facilitator_synthesis_points", schema },
    instruction: `\n\n## RUNTIME OUTPUT FORMAT FOR THIS REQUEST\nInstead of the legacy role/message/groundingMessageIds object, emit exactly\nrole, scoreboard, question and questionGroundingMessageIds matching the supplied\nJSON Schema. Each scoreboard item names one TARGET option and contains at most\ntwo atomic public points, each with its sourceMessageIds. Select two points when\nthree are available; never pack multiple independent facts into one point.\nPreserve each selected fact's qualifiers. The runtime formats these selected\npoints into the same one-sentence scoreboard and question the role requires.\nDo not output message, summary, sections, reasoning, counts or private data.\nUse questionGroundingMessageIds only for additional public framing in the\nquestion; otherwise []. All original role, neutrality and length limits apply.`,
  };
}

export function decodeSynthesisPoints(value, contract) {
  const validate = new Ajv({ strict: false, allErrors: true }).compile(contract.responseSchema.schema);
  if (!validate(value)) return { ok: false, error: "Invalid synthesis point schema", errors: validate.errors };
  const options = value.scoreboard.map(row => row.option);
  if (new Set(options).size !== options.length) return { ok: false, error: "Duplicate synthesis option" };
  const sourceIds = [...new Set(value.scoreboard.flatMap(row => row.points.flatMap(point => point.sourceMessageIds)))];
  if (sourceIds.length < 2) return { ok: false, error: "Synthesis must organise at least two public contributions" };
  // Formatting only: no fact is generated, truncated or semantically rewritten.
  const text = value.scoreboard.map(row => `${row.option}: ${row.points.map(point => point.text.trim().replace(/\.$/u, "")).join("; ")}`).join("; ");
  return { ok: true, parsed: {
    role: value.role,
    message: { summary: `Shared so far — ${text}.`, sections: [], question: value.question },
    groundingMessageIds: [...new Set([...sourceIds, ...value.questionGroundingMessageIds])],
  } };
}
