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
          points: { type: "array", minItems: 1, items: {
            type: "object", additionalProperties: false, properties: {
              text: { type: "string", minLength: 1 },
              sourceMessageIds: { ...idList, minItems: 1 },
            }, required: ["text", "sourceMessageIds"],
          } },
        }, required: ["option", "points"],
      } },
      question: { type: "string", minLength: 1 },
      questionGroundingMessageIds: idList,
    }, required: ["role", "scoreboard", "question", "questionGroundingMessageIds"],
  };
  return {
    responseSchema: { name: "facilitator_synthesis_points", schema },
    instruction: `\n\n## RUNTIME OUTPUT FORMAT FOR THIS REQUEST\nInstead of the legacy role/message/groundingMessageIds object, emit exactly\nrole, scoreboard, question and questionGroundingMessageIds matching the supplied\nJSON Schema. Each scoreboard item names one TARGET option and contains public\npoints, each with its sourceMessageIds. Preserve each fact's qualifiers and\ninclude grounded explanation where it helps participants understand the point.\nThe runtime renders "Shared points", an option heading, numbered points under\neach option, and the closing question. Represent ALL distinct public task facts in the supplied synthesis scope, including qualifiers, unresolved concerns and corrections. Do not omit points or options to shorten. Merge duplicates faithfully and use the shortest lossless wording. There is no fixed word ceiling. List numbers indicate\nstructure, never scores or rankings. Do not output message, summary, sections,\ninternal reasoning or private data. Use questionGroundingMessageIds only for\nadditional public framing in the question; otherwise []. All role, grounding\nand neutrality rules still apply.`,
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
  const sections = value.scoreboard.map(row => ({
    title: row.option,
    body: row.points.map((point, index) => `${index + 1}. ${point.text.trim()}`).join("\n"),
  }));
  return { ok: true, parsed: {
    role: value.role,
    message: { summary: "Shared points", sections, question: value.question },
    groundingMessageIds: [...new Set([...sourceIds, ...value.questionGroundingMessageIds])],
  } };
}
