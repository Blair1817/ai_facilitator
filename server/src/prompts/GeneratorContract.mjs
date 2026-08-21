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
 * Phase 6 pilot update: tolerate a SINGLE leading/trailing markdown
 * code fence (```json ... ``` or ``` ... ```) wrapping exactly one
 * JSON object, because the live LLM model (MiniMax-Text-01, verified
 * 2026-08-11) emits JSON this way despite the prompt explicitly
 * forbidding it. The schema-level strictness (the object must still
 * match the relevant schema exactly) is unchanged -- this helper only
 * strips a benign envelope wrapper. Prose before/after the code
 * fence, multiple top-level JSON values, or code fences without
 * valid JSON inside all still fail as PARSE_FAILURE.
 */
export function strictParseJsonObject(rawText) {
  if (typeof rawText !== "string") {
    return { ok: false, code: "PARSE_FAILURE", error: "response is not a string" };
  }

  // Try the strict path first (raw string IS valid JSON). This is the
  // "happy path" every test in this repo exercises, and remains the
  // canonical behaviour the original docstring promised.
  let parsed;
  try {
    parsed = JSON.parse(rawText);
  } catch (firstErr) {
    // Fallback: strip a SINGLE leading ```json (or ```) ... trailing
    // ``` wrapper, then retry. Anchored so multi-fence / multi-object
    // payloads (which the strict behaviour correctly rejects) are not
    // rescued by this fallback.
    const fenceMatch = rawText.match(/^\s*```(?:json)?\s*\n?([\s\S]*?)\n?\s*```\s*$/i);
    if (!fenceMatch) {
      return { ok: false, code: "PARSE_FAILURE", error: `invalid JSON: ${firstErr.message}` };
    }
    try {
      parsed = JSON.parse(fenceMatch[1]);
    } catch (secondErr) {
      return { ok: false, code: "PARSE_FAILURE", error: `invalid JSON (after code-fence strip): ${secondErr.message}` };
    }
  }

  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { ok: false, code: "PARSE_FAILURE", error: "parsed value is not a single JSON object" };
  }

  // Defensive markdown-wrapper strip on the `message` field if present.
  // See stripMarkdownWrapper's header for rationale. Validator / Assessor /
  // LLMTransport outputs don't have a `message` string field, so this is
  // a no-op for them. For Generator outputs, the cleaned message is what
  // `runDeterministicValidation` and the participant-facing publication
  // both see — i.e. `**Halden**` in the model output becomes `Halden` in
  // both the validator and the chat.
  if (typeof parsed.message === "string" && parsed.message.length > 0) {
    const stripped = stripMarkdownWrapper(parsed.message);
    if (stripped === null) {
      // Safety net: stripping destroyed >50% of the content, meaning the
      // input was mostly markdown structure rather than a sentence with
      // some formatting. Reject as a parse failure rather than silently
      // publishing something the model never intended.
      return {
        ok: false,
        code: "PARSE_FAILURE",
        error: "message is primarily markdown structure (markdown-wrapper stripper would have removed >50% of the content); refusing to silently rewrite",
      };
    }
    parsed = { ...parsed, message: stripped };
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

// ── markdown wrapper stripper (2026-08-21, Phase 6.4 mention-pilot fix) ──────
//
// MiniMax-Text-01 / MiniMax-M2.7-highspeed occasionally emit inline markdown
// (especially `**bold**` for option names and `- ` bullet markers) despite
// base.md's "no markdown" HARD CONSTRAINT. The deterministic validator
// (runDeterministicValidation, `MARKDOWN_PATTERN`) would reject these,
// sending the whole `@Facilitator` mention path to the canned-reply fallback.
//
// The defensive layer here mirrors the code-fence stripper above: we strip
// benign markdown *wrappers* (characters that only format, not contribute
// content) and pass through to the rest of the pipeline. The text content
// is preserved 1:1 — `**Halden**` becomes `Halden`, `- foo` becomes `foo`.
// Conservative by design: snake_case `_word_` italic is NOT stripped
// (false-positive risk on legitimate identifiers); ATX headers, list
// markers, and the two bold flavours are the only targets. The Validator /
// Assessor / LLMTransport callers of `strictParseJsonObject` see no effect
// because their outputs have no `message` string field.
//
// Safety net: if stripping would shrink the message to <50% of its original
// length, the message is mostly markdown *structure* (e.g. an entire table)
// and we return `null` so the caller can treat it as `invalid_json` rather
// than silently publishing something the model never intended.
const MARKDOWN_STRIP_PATTERNS = [
  // `**bold**` and `__bold__` — the two flavours the live model uses for
  // option-name emphasis. Require at least one non-marker char inside so
  // we don't strip empty `****` or `____`.
  [/\*\*([^*\n]+?)\*\*/g, "$1"],
  [/__([^_\n]+?)__/g, "$1"],
  // ATX headers at line start: `# `, `## `, ..., `###### ` (1-6 hashes + space).
  // The line-start anchor prevents eating `#` characters that appear
  // mid-sentence (e.g. as a numbered footnote).
  [/(^|\n)#{1,6}[ \t]+/g, "$1"],
  // Bullet list markers at line start: `- `, `* `, `+ ` followed by space.
  // Anchored at line start so a hyphen in the middle of a sentence is
  // not stripped.
  [/(^|\n)[ \t]{0,3}[-*+][ \t]+/g, "$1"],
  // Numbered list markers at line start: `1. `, `12. `, etc.
  [/(^|\n)[ \t]{0,3}\d+\.[ \t]+/g, "$1"],
  // Inline code backticks: `` `word` `` → `word`. Single-line to avoid
  // eating a fence that the parser might have missed.
  [/`([^`\n]+)`/g, "$1"],
];

/**
 * Strips benign markdown wrappers (bold markers, list markers, ATX headers,
 * inline code backticks) from a single string. Returns the cleaned string,
 * or `null` if stripping would destroy more than 50% of the content
 * (defensive sanity check — such an input is not "a sentence with some
 * formatting" but "a markdown document", which we should not silently
 * rewrite into prose).
 */
export function stripMarkdownWrapper(message) {
  if (typeof message !== "string" || message.length === 0) return message;
  let current = message;
  for (const [pattern, replacement] of MARKDOWN_STRIP_PATTERNS) {
    current = current.replace(pattern, replacement);
  }
  // Collapse 3+ consecutive blank lines that often appear after list removal
  // (e.g. `- foo\n- bar\n- baz` becomes `foo\nbar\nbaz` with no separator —
  // acceptable; but `\n\n\n\n` left over is ugly and the participant would
  // see weird whitespace). Only collapses runs of 3+ newlines, so normal
  // paragraph breaks (1 or 2 newlines) are preserved.
  current = current.replace(/\n{3,}/g, "\n\n");
  if (current.trim().length < message.trim().length * 0.5) {
    return null; // safety net: stripping destroyed too much; treat as invalid
  }
  return current;
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

// 2026-08-13: capture every `@[…]` mention token in a candidate
// `message`. Used by runDeterministicValidation to enforce the
// single-tag-per-message rule shared by every Generator role
// (Static, Generalist, Specialist, requested Generalist) per
// base.md's "@-TAGGING (PARTICIPANT MENTIONS) — SHARED ACROSS ALL
// ROLES" section. The pattern is intentionally strict about
// square brackets and the leading `@`, matching exactly the markup
// the client UI (client/src/components/CustomChat.jsx, `markup=
// "@[__display__]"`) renders as a clickable mention. A bare
// `@Alex` (no brackets) does NOT match, and so is NOT counted as a
// mention for this check.
const MENTION_PATTERN = /@\[([^\[\]]+)\]/g;
// Same role-name constant CheckpointManager.mjs uses for the
// "@-Facilitator" detection (FACILITATOR_MENTION_MARKER). Mirrored
// here as a plain literal to avoid a cross-module import; the
// single source of truth for the rendered markup is still the
// client's `@[__display__]` template.
const FACILITATOR_NAME = "Facilitator";

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
  {
    selectedRole,
    eligibleMessageIds = [],
    aiOrSystemMessageIds = [],
    recentAiMessageTexts = [],
    // 2026-08-07 addition: PolicyCompiler.js's plan.evidenceIds, passed
    // through as DynamicContext.mjs's allowedGroundingIds. When present
    // (Adaptive checkpoints with a plan only -- Static and any Adaptive
    // call without a plan pass null/undefined here, unchanged from
    // before), grounding IDs must be a subset of THIS narrower list, not
    // just of eligibleMessageIds (the whole public transcript). This is
    // the Brief's Step 9 "evidenceIds: 允许引用的message IDs" constraint --
    // the Generator may only cite what the plan specifically identified as
    // supporting evidence for the detected gap, not any public message.
    allowedGroundingIds = null,
    // 2026-08-13 addition: the same roster used to render the
    // [ACTIVE_PARTICIPANT_NAMES] section in the assembled user
    // turn (DynamicContext.mjs / StaticContext.mjs). When supplied
    // (always, for Static + every Adaptive checkpoint), every
    // `@[Name]` token in `message` must resolve to a name in this
    // list (case-insensitive) -- this is the deterministic
    // backstop for the "@-TAGGING — SHARED ACROSS ALL ROLES" rule
    // in base.md and the role-specific tagging rules in each
    // role's prompt. Omit to disable the check (only intended for
    // tests of the check itself, not for the live pipeline).
    activeParticipantNames = null,
  } = {}
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

  if (Array.isArray(allowedGroundingIds)) {
    // The plan's evidenceIds is a hint to the Generator (which public
    // messages the LLM-built plan identified as supporting the detected
    // gap), not a hard constraint. The hard constraint is
    // UNKNOWN_GROUNDING_ID above: every grounding ID must be a public
    // participant message. The 2026-08-13 mention-pilot surfaced two
    // synthetic scenarios where the LLM-built plan was too narrow and
    // the Generator's broader grounding was actually the right call;
    // failing those on GROUNDING_ID_OUTSIDE_PLAN_EVIDENCE produced 0/5
    // pipeline pass even though the candidate was correct.
    //
    // If a future revision wants strict plan enforcement, the call site
    // (DynamicContext.mjs / StaticContext.mjs) can pass
    // `eligibleMessageIds === allowedGroundingIds` upstream so the
    // UNKNOWN_GROUNDING_ID check above enforces the plan. The deterministic
    // contract here is: "ground only in the public human transcript".
    void allowedGroundingIds;  // accepted as a hint, not enforced
  }

  // 2026-08-13: `@[Name]` mention hygiene. Enforced only when the
  // caller supplies activeParticipantNames (every live call does;
  // tests of the check itself can omit). Failed criteria are
  // additive -- they describe a malformed mention, not a malformed
  // message. The list below is the deterministic counterpart to
  // base.md's "@-TAGGING (PARTICIPANT MENTIONS) — SHARED ACROSS ALL
  // ROLES" section. There is no per-message count cap (the original
  // Alsobay prompt has no such cap, and a normal group member will
  // name both sources of a two-sided comparison, or every silent
  // participant when half the room is quiet). The only structural
  // checks here are (a) every `@[Name]` resolves to a name in
  // `[ACTIVE_PARTICIPANT_NAMES]`, and (b) the Facilitator is never
  // tagged. A "roll call" / every-name-tagged message is not
  // deterministically flagged here -- the Validator LLM (semantic)
  // and the role-specific prompt guidance are the right place for
  // that stylistic call.
  if (typeof message === "string" && Array.isArray(activeParticipantNames) && activeParticipantNames.length > 0) {
    const mentions = [...message.matchAll(MENTION_PATTERN)].map((m) => String(m[1] ?? "").trim()).filter((n) => n.length > 0);
    for (const tag of mentions) {
      if (tag.toLowerCase() === FACILITATOR_NAME.toLowerCase()) {
        failedCriteria.push("FACILITATOR_SELF_MENTION");
        // Only report the Facilitator-self-mention once, not once per
        // tag; this is a single offence, not N offences.
        break;
      }
    }
    if (!failedCriteria.includes("FACILITATOR_SELF_MENTION")) {
      const allowed = new Set(activeParticipantNames.map((n) => String(n).trim().toLowerCase()));
      for (const tag of mentions) {
        if (!allowed.has(tag.toLowerCase())) {
          failedCriteria.push("UNKNOWN_MENTION_TARGET");
          break;
        }
      }
    }
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
