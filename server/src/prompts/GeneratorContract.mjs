/**
 * GeneratorContract.mjs
 *
 * Implements three of the pipeline stages from the architecture doc
 * (server/src/prompts/PROMPT_MODULE_STATUS.md's "What this means for the
 * currently running system" section describes the rest):
 *
 *   LLM Generator -> [this module: strict JSON parser] -> [this module:
 *   generation schema] -> [this module: deterministic validation] ->
 *   LLM semantic Validator (validatorPlaceholder.js) -> ...
 *
 * Genuinely absent before this task: no strict parser, no compiled
 * generation.schema.json enforcement, and no deterministic-validation code
 * existed anywhere in the repo (confirmed by grep -- only
 * postGeneratorResultIfValid in callbacks.js existed, a minimal
 * message/role check with no schema compilation, no grounding-ID check, no
 * markdown/duplicate detection). This file is a new production module
 * because there was nothing to "complete or correct" -- see
 * PROMPT_MODULE_STATUS.md and the Prompt 3B closure report for the
 * evidence trail.
 *
 * Pure functions only. No fetch, no Empirica import, no dotenv -- safe to
 * import directly in tests, same reasoning as utils.js/Counterbalancing.mjs.
 */

import fs from "fs";
import path from "path";
import Ajv from "ajv";

// See promptLoader.js's header comment for why import.meta.url is not used
// here: esbuild's CJS output format empties it (confirmed via a real build
// warning), and the real runtime entry point is always `node dist/index.js`
// with ./source rsync'd alongside it.
const ENTRY_DIR = process.argv[1] ? path.dirname(process.argv[1]) : path.join(process.cwd(), "dist");
const SOURCE_DIR = path.join(ENTRY_DIR, "prompts", "source");

const ajv = new Ajv({ strict: false, allErrors: true });

let cachedGenerationSchema = null;
function loadGenerationSchema() {
  if (cachedGenerationSchema) return cachedGenerationSchema;
  const raw = fs.readFileSync(path.join(SOURCE_DIR, "generation.schema.json"), "utf8");
  cachedGenerationSchema = JSON.parse(raw);
  return cachedGenerationSchema;
}

/**
 * Strict JSON object parser shared by the Generator and (via
 * validatorPlaceholder.js) the semantic Validator response paths.
 *
 * Deliberately just `JSON.parse` on the untouched raw string -- no regex
 * extraction, no code-fence stripping, no trimming beyond what JSON.parse
 * itself tolerates (whitespace). Any code fence, leading/trailing prose, or
 * multiple JSON values makes `JSON.parse` throw, which is exactly the
 * "reject markdown code fences" / "reject prose before or after" behaviour
 * required -- not reimplemented, relied on directly.
 */
export function strictParseJsonObject(rawText) {
  if (typeof rawText !== "string") {
    return { ok: false, code: "PARSE_FAILURE", error: "response is not a string" };
  }
  let parsed;
  try {
    parsed = JSON.parse(rawText);
  } catch (err) {
    return { ok: false, code: "PARSE_FAILURE", error: `invalid JSON: ${err.message}` };
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { ok: false, code: "PARSE_FAILURE", error: "parsed value is not a single JSON object" };
  }
  return { ok: true, parsed };
}

/** Generator-specific wrapper (stable failure code for logging). */
export function parseGeneratorOutputStrict(rawText) {
  const result = strictParseJsonObject(rawText);
  if (!result.ok) {
    return { ok: false, code: "GENERATOR_PARSE_FAILURE", error: result.error };
  }
  return result;
}

/**
 * Builds a NON-MUTATING runtime copy of generation.schema.json with
 * properties.role.const pinned to selectedRole, per this task's explicit
 * requirement #7. Deep-cloned every call so concurrent Games using
 * different selectedRole values never share (or race on) the same schema
 * object.
 */
export function buildRuntimeGenerationSchema(selectedRole) {
  const source = loadGenerationSchema();
  const clone = JSON.parse(JSON.stringify(source));
  clone.properties.role = { ...clone.properties.role, const: selectedRole };
  return clone;
}

export function validateAgainstGenerationSchema(parsed, selectedRole) {
  const schema = buildRuntimeGenerationSchema(selectedRole);
  const validateFn = ajv.compile(schema);
  const valid = validateFn(parsed);
  if (!valid) {
    return { ok: false, code: "GENERATION_SCHEMA_FAILURE", errors: validateFn.errors };
  }
  return { ok: true };
}

// Detects the markdown constructs base.md's OUTPUT CONTRACT forbids
// ("no markdown formatting, no lists, no headers"): fenced code blocks,
// ATX headers, bullet/numbered list markers at line start, and bold/italic
// emphasis markers.
const MARKDOWN_PATTERN = /```|(^|\n)[ \t]{0,3}#{1,6}[ \t]|(^|\n)[ \t]{0,3}[-*+][ \t]|(^|\n)[ \t]{0,3}\d+\.[ \t]|\*\*[^*]+\*\*|__[^_]+__/;

function normalizeForDuplicateCheck(text) {
  return text.trim().replace(/\s+/g, " ").toLowerCase();
}

/**
 * Deterministic validation (requirement #8). Runs only after strict parse +
 * generation-schema validation have already passed -- this function still
 * re-checks role equality and message non-emptiness explicitly (redundant
 * with the schema's `const`/`minLength`, but the task requires the second
 * explicit code-level check regardless of schema enforcement) plus the
 * checks the schema cannot express: markdown detection, unexpected-field
 * detection (redundant with additionalProperties:false, same rationale),
 * grounding-ID membership against the eligible public context, grounding
 * IDs referencing AI/system messages, and exact-normalized-duplicate
 * detection against recent AI messages.
 *
 * Does not invent a semantic-similarity threshold (none is frozen anywhere
 * in the source package) -- duplicate detection is exact-normalized-string
 * only, per this task's explicit instruction.
 */
export function runDeterministicValidation(
  parsed,
  { selectedRole, eligibleMessageIds = [], aiOrSystemMessageIds = [], recentAiMessageTexts = [] } = {}
) {
  const failedCriteria = [];

  if (parsed.role !== selectedRole) failedCriteria.push("ROLE_MISMATCH");

  const message = parsed.message;
  if (typeof message !== "string" || message.trim().length === 0) {
    failedCriteria.push("EMPTY_MESSAGE");
  }

  if (typeof message === "string") {
    const schema = loadGenerationSchema();
    const maxLength = schema.properties?.message?.maxLength;
    if (typeof maxLength === "number" && message.length > maxLength) {
      failedCriteria.push("MESSAGE_TOO_LONG");
    }
    if (MARKDOWN_PATTERN.test(message)) {
      failedCriteria.push("MARKDOWN_DETECTED");
    }
  }

  const allowedKeys = new Set(["role", "message", "groundingMessageIds"]);
  const hasUnexpectedField = Object.keys(parsed).some((k) => !allowedKeys.has(k));
  if (hasUnexpectedField) failedCriteria.push("UNEXPECTED_FIELD");

  const groundingIds = Array.isArray(parsed.groundingMessageIds) ? parsed.groundingMessageIds : [];
  const eligibleSet = new Set(eligibleMessageIds);
  const aiOrSystemSet = new Set(aiOrSystemMessageIds);

  if (groundingIds.some((id) => aiOrSystemSet.has(id))) {
    failedCriteria.push("GROUNDING_ID_NOT_PARTICIPANT_MESSAGE");
  }
  if (groundingIds.some((id) => !eligibleSet.has(id))) {
    failedCriteria.push("UNKNOWN_GROUNDING_ID");
  }

  if (typeof message === "string") {
    const normalized = normalizeForDuplicateCheck(message);
    const isDuplicate = recentAiMessageTexts.some((t) => normalizeForDuplicateCheck(t) === normalized);
    if (isDuplicate) failedCriteria.push("DUPLICATE_OF_RECENT_AI_MESSAGE");
  }

  return { passed: failedCriteria.length === 0, failedCriteria };
}

export function getGenerationSchemaMaxLength() {
  return loadGenerationSchema().properties?.message?.maxLength ?? null;
}
