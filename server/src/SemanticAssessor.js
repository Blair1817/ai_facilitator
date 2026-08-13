/**
 * SemanticAssessor.js
 *
 * Architecture doc Step 5. New module added 2026-08-07 -- see
 * server/src/prompts/PROMPT_MODULE_STATUS.md's addendum for why this
 * exists despite prompt_design_specification.Rmd's older "no independent
 * LLM judgment component" note.
 *
 * Single LLM call: given the public discussion context, ask the model to
 * score all eight semantic factors, with a verbatim-quote span as evidence.
 * These checked 0-1 strengths are the only detector scores used for role
 * classification; no hand-engineered feature pre-filter runs before it.
 * This module ONLY builds the request and
 * validates the shape of the response -- it does NOT verify that spans
 * actually occur in the transcript, does NOT decide roles, and does NOT
 * generate a facilitation message. Span verification and any other
 * correction of the LLM's judgement happens downstream, in
 * EvidenceChecker.js (Step 6), which is deterministic code, not another
 * LLM call.
 *
 * No fetch, no dotenv, no Empirica import in this file. The actual network
 * call is INJECTED (the `callLLM` parameter) rather than performed here --
 * same reasoning as GeneratorContract.mjs/DynamicContext.mjs's existing
 * "pure function, safe to unit test" convention, extended to a step that
 * genuinely needs an LLM call: the call itself is the caller's
 * responsibility (server/src/callbacks.js passes its own existing
 * getLLMResponse), so this module can be exercised in tests with a fake
 * `callLLM` and no network/API key.
 */

import fs from "fs";
import path from "path";
import Ajv from "ajv";
import { strictParseJsonObject } from "./prompts/GeneratorContract.mjs";
import { withMessageIds, formatMessagesWithIds } from "./prompts/DynamicContext.mjs";

// Same reasoning as promptLoader.js/GeneratorContract.mjs for why
// import.meta.url is not used: esbuild's CJS bundle output empties it, and
// the real runtime entry point is always `node dist/index.js` with
// ./source rsync'd alongside it.
const ENTRY_DIR = process.argv[1] ? path.dirname(process.argv[1]) : path.join(process.cwd(), "dist");
const SOURCE_DIR = path.join(ENTRY_DIR, "prompts", "source");

const INCOMPLETE_MARKERS = [
  /\[\[\s*TODO\b/i,
  /skeleton\s+only/i,
  /content\s+pending/i,
];

function detectIncompleteMarkers(text) {
  const hits = [];
  for (const re of INCOMPLETE_MARKERS) {
    const m = text.match(re);
    if (m) hits.push(m[0]);
  }
  return hits;
}

function readSourceFile(filename) {
  const p = path.join(SOURCE_DIR, filename);
  try {
    return { content: fs.readFileSync(p, "utf8"), error: null };
  } catch (err) {
    return { content: null, error: `Cannot read ${filename}: ${err.message}` };
  }
}

/**
 * Mirrors promptLoader.js's getStaticPromptBundle()/getAdaptivePromptBundle()
 * contract ({blocked, content|reason, metadata}) but for assessor.md alone
 * -- deliberately NOT combined with base.md. base.md's own header scopes it
 * to "all Generators"; the Assessor is not a Generator (it is the
 * Interpret stage, not the Act stage: it never writes a participant-facing
 * message), so base.md's Generator-specific OUTPUT CONTRACT/role-name
 * rules do not apply here and are not merged in.
 */
export function getAssessorPromptBundle() {
  const file = readSourceFile("assessor.md");
  const metadata = { promptName: "assessor", promptStatus: "draft_unapproved" };

  if (file.error) {
    return { blocked: true, reason: file.error, metadata: { ...metadata, sourceCompleteness: "missing_file" } };
  }
  const incomplete = detectIncompleteMarkers(file.content);
  if (incomplete.length > 0) {
    return {
      blocked: true,
      reason: `assessor.md contains unresolved placeholder marker(s): ${incomplete.join(", ")}.`,
      metadata: { ...metadata, sourceCompleteness: "has_unresolved_markers" },
    };
  }
  return { blocked: false, content: file.content, metadata: { ...metadata, sourceCompleteness: "no_markers_found" } };
}

let cachedAssessorSchema = null;
function loadAssessorSchema() {
  if (cachedAssessorSchema) return cachedAssessorSchema;
  const raw = fs.readFileSync(path.join(SOURCE_DIR, "assessor.schema.json"), "utf8");
  cachedAssessorSchema = JSON.parse(raw);
  return cachedAssessorSchema;
}

const ajv = new Ajv({ strict: false, allErrors: true });

export function validateAgainstAssessorSchema(parsed) {
  const validateFn = ajv.compile(loadAssessorSchema());
  const valid = validateFn(parsed);
  if (!valid) {
    return { ok: false, code: "ASSESSOR_SCHEMA_FAILURE", errors: validateFn.errors };
  }
  return { ok: true };
}

/**
 * Builds the Assessor's user turn. Reuses DynamicContext.mjs's message-ID
 * annotation (same "m0", "m1", ... scheme the Generator sees) so that
 * EvidenceChecker.js's later span/message_id checks are validated against
 * IDs that mean the same thing on both sides of the pipeline.
 */
export function buildAssessorUserContext({ chat, taskGeneralContext }) {
  const chatWithIds = withMessageIds(chat);
  const humanWithIds = chatWithIds.filter((m) => m.sender.id !== "ai");
  const localWithIds = humanWithIds.slice(-6);

  const cumulativePublicContext = formatMessagesWithIds(humanWithIds);
  const localContext = formatMessagesWithIds(localWithIds);

  const sections = [
    ["[TASK_GENERAL_CONTEXT]", taskGeneralContext || "(not provided)"],
    ["[CUMULATIVE_PUBLIC_CONTEXT]", cumulativePublicContext || "(no messages yet)"],
    ["[LOCAL_CONTEXT]", localContext || "(no messages yet)"],
  ];
  const userContent = sections.map(([header, body]) => `${header}\n${body}`).join("\n\n");

  return {
    userContent,
    eligibleMessageIds: humanWithIds.map((m) => m.messageId),
  };
}

/**
 * The single exported entry point. `callLLM` must have the same contract
 * as callbacks.js's existing getLLMResponse: async (messages) =>
 * {success:true, data, rawText} | {success:false, error}. This module
 * never performs the fetch itself.
 *
 * Returns:
 *   {success:true, factors: <schema-validated semantic state>}
 *   {success:false, code, error} on any failure (blocked prompt, LLM
 *     error, invalid JSON, schema failure) -- callers should treat this
 *     the same as "Semantic Assessor unavailable this checkpoint" and let
 *     evaluateGate() see checkedFactors=null, which fails closed as an
 *     unavailable detector result.
 */
export async function assessSemanticFactors({ chat, taskGeneralContext, callLLM }) {
  if (typeof callLLM !== "function") {
    throw new Error("assessSemanticFactors() requires a callLLM(messages) function to be injected -- it does not perform network calls itself.");
  }

  const promptResult = getAssessorPromptBundle();
  if (promptResult.blocked) {
    return { success: false, code: "ASSESSOR_PROMPT_BLOCKED", error: promptResult.reason };
  }

  const { userContent } = buildAssessorUserContext({ chat, taskGeneralContext });
  const messages = [
    { role: "system", content: promptResult.content },
    { role: "user", content: userContent },
  ];

  const llmResponse = await callLLM(messages);
  if (!llmResponse.success) {
    return { success: false, code: "ASSESSOR_API_ERROR", error: llmResponse.error };
  }

  const parseResult = strictParseJsonObject(llmResponse.rawText);
  if (!parseResult.ok) {
    return { success: false, code: "ASSESSOR_PARSE_FAILURE", error: parseResult.error, rawText: llmResponse.rawText };
  }

  const schemaResult = validateAgainstAssessorSchema(parseResult.parsed);
  if (!schemaResult.ok) {
    return { success: false, code: "ASSESSOR_SCHEMA_FAILURE", error: JSON.stringify(schemaResult.errors), rawText: llmResponse.rawText };
  }

  return { success: true, factors: parseResult.parsed, rawText: llmResponse.rawText };
}
