/**
 * SemanticValidator.js
 *
 * Architecture doc Step 7 (Q6 = "完整实现"). New module added 2026-08-10
 * to reintroduce the semantic Validator LLM + repair loop that the GRAIL
 * scope-reduction refactor removed. See:
 *   - audit-phase1.md §6 Q6 (decision: complete implementation)
 *   - server/src/prompts/source/validator.md (the LLM prompt text)
 *   - server/src/prompts/source/validation.schema.json (the LLM output
 *     contract -- 7 booleans, passed/failedCriteria computed downstream)
 *
 * Single LLM call per invocation: given the candidate intervention the
 * Generator just produced, ask the model to audit it against 13 semantic
 * criteria (the original 7 — notGrounded / nonNeutral / roleMisaligned /
 * inventedInformation / recommendationDetected / unsupportedInformationDetected
 * / unsupportedConsensusClaim — plus the 6 the Delibra spec §11 requires
 * which Phase 5 missed: optionSteering / requiredReasoningActMissing /
 * unanswerable / hiddenInformationInference / repetition / length).
 * Returns the 13 booleans verbatim. Does NOT compute passed/failedCriteria
 * (that's the deterministic downstream's job, same division of
 * responsibility as Assessor -> EvidenceChecker).
 *
 * Repair loop: the caller (server/src/callbacks.js) owns the loop. On a
 * failed audit, the caller regenerates the candidate once with the
 * failedCriteria list injected as user-turn feedback. This module just
 * produces the audit verdict; the caller decides what to do with it. On
 * a second failure, the caller logs the failure strongly and silently
 * drops the intervention (per Q6 persistent-failure = Silent + 强 log
 * 标记).
 *
 * No fetch, no dotenv, no Empirica import in this file. The actual network
 * call is INJECTED (the `callLLM` parameter) rather than performed here --
 * same convention as SemanticAssessor.js. So this module can be exercised
 * in tests with a fake `callLLM` and no network/API key.
 */

import fs from "fs";
import path from "path";
import Ajv from "ajv";
import { strictParseJsonObject } from "./prompts/GeneratorContract.mjs";
import { withMessageIds, formatMessagesWithIds } from "./prompts/DynamicContext.mjs";

// Same reasoning as promptLoader.js/GeneratorContract.mjs/SemanticAssessor.js
// for why import.meta.url is not used: esbuild's CJS bundle output empties
// it, and the real runtime entry point is always `node dist/index.js` with
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

// The 13 semantic criteria, in the exact order required by the LLM output
// contract (validator.md) and validation.schema.json. Used both to
// build the user-turn checklist and to verify the LLM response contains
// every required field. Order is meaningful: the repair-loop feedback
// (injected by the caller as a [PRIOR_FAILED_CRITERIA] section) reuses
// the same order so the LLM sees a consistent shape.
//
// First 7: Phase 5 frozen (audit-phase1.md Q6, 7-criterion v2 design).
// Last 6: Delibra spec §11 ("检查 grounding、option steering、role fidelity、
// required reasoning act、问题是否可回答、false consensus、hidden-information
// inference、repetition、length 和 tone"). Tone is covered by `nonNeutral`
// (overlap). The other 6 are added now to close the spec gap.
export const VALIDATOR_CRITERIA = Object.freeze([
  // Phase 5 frozen
  "notGrounded",
  "nonNeutral",
  "roleMisaligned",
  "inventedInformation",
  "recommendationDetected",
  "unsupportedInformationDetected",
  "unsupportedConsensusClaim",
  // Delibra spec §11 additions (2026-08-11)
  "optionSteering",
  "requiredReasoningActMissing",
  "unanswerable",
  "hiddenInformationInference",
  "repetition",
  "length",
]);

/**
 * Mirrors SemanticAssessor.js's getAssessorPromptBundle() contract
 * ({blocked, content|reason, metadata}) but for validator.md alone --
 * deliberately NOT combined with base.md. validator.md's own header
 * scopes it to "semantic validator, not a Generator", so base.md's
 * Generator-specific OUTPUT CONTRACT does not apply here and is not
 * merged in.
 */
export function getValidatorPromptBundle() {
  const file = readSourceFile("validator.md");
  const metadata = { promptName: "validator", promptStatus: "draft_unapproved" };

  if (file.error) {
    return { blocked: true, reason: file.error, metadata: { ...metadata, sourceCompleteness: "missing_file" } };
  }
  const incomplete = detectIncompleteMarkers(file.content);
  if (incomplete.length > 0) {
    return {
      blocked: true,
      reason: `validator.md contains unresolved placeholder marker(s): ${incomplete.join(", ")}.`,
      metadata: { ...metadata, sourceCompleteness: "has_unresolved_markers" },
    };
  }
  return { blocked: false, content: file.content, metadata: { ...metadata, sourceCompleteness: "no_markers_found" } };
}

let cachedValidatorSchema = null;
function loadValidatorSchema() {
  if (cachedValidatorSchema) return cachedValidatorSchema;
  const raw = fs.readFileSync(path.join(SOURCE_DIR, "validation.schema.json"), "utf8");
  cachedValidatorSchema = JSON.parse(raw);
  return cachedValidatorSchema;
}

const ajv = new Ajv({ strict: false, allErrors: true });

/**
 * Validates the parsed LLM response against validation.schema.json.
 * The schema requires exactly the 13 booleans (no `passed` / no
 * `failedCriteria` -- those are computed downstream by the deterministic
 * helper, see `computeValidatorVerdict` below).
 */
export function validateAgainstValidatorSchema(parsed) {
  const validateFn = ajv.compile(loadValidatorSchema());
  const valid = validateFn(parsed);
  if (!valid) {
    return { ok: false, code: "VALIDATOR_SCHEMA_FAILURE", errors: validateFn.errors };
  }
  return { ok: true };
}

/**
 * Deterministic verdict computation. The LLM returns only the 13 booleans;
 * this helper turns them into the {passed, failedCriteria} shape every
 * other module in the pipeline uses. Done in code, not by the LLM, to
 * avoid the LLM self-summarising and producing logically inconsistent
 * verdicts (e.g. flagging `notGrounded: true` but also claiming `passed:
 * true`).
 */
export function computeValidatorVerdict(booleans) {
  const failedCriteria = [];
  for (const k of VALIDATOR_CRITERIA) {
    if (booleans[k] === true) failedCriteria.push(k);
  }
  return {
    passed: failedCriteria.length === 0,
    failedCriteria,
  };
}

/**
 * Validator-only provider-envelope parser. The live provider sometimes puts
 * one valid fenced JSON object first and then appends an explanation despite
 * the prompt forbidding prose. Generator output remains strict; only this
 * internal, schema-validated audit response may ignore text after the first
 * complete fence.
 */
export function parseValidatorResponse(rawText) {
  const strict = strictParseJsonObject(rawText);
  if (strict.ok) return strict;
  if (typeof rawText !== "string") return strict;
  const leadingFence = rawText.match(/^\s*```(?:json)?\s*\n?([\s\S]*?)\n?\s*```/i);
  if (!leadingFence) return strict;
  return strictParseJsonObject(leadingFence[1]);
}

/**
 * Builds the Validator's user turn. Reuses DynamicContext.mjs's message-ID
 * annotation so any ground-truth checks (none enforced by the Validator
 * LLM itself today, but the convention is preserved for symmetry with the
 * Generator and the Assessor) use IDs that mean the same thing across the
 * pipeline.
 *
 * When `priorFailedCriteria` is provided (the repair-loop case), an extra
 * [PRIOR_FAILED_CRITERIA] section is appended to the end of the user turn
 * so the LLM knows the previous attempt failed on those specific criteria
 * and should focus its audit there. `priorCandidate` is the previous
 * failed candidate's message text (so the LLM can compare), distinct
 * from the new `candidate` argument which is what it is asked to audit
 * this time.
 */
export function buildValidatorUserContext({
  chat,
  candidate,
  selectedRole,
  taskGeneralContext,
  priorFailedCriteria = null,
  priorCandidate = null,
}) {
  const chatWithIds = withMessageIds(chat);
  const humanWithIds = chatWithIds.filter((m) => m.sender.id !== "ai");
  const localWithIds = humanWithIds.slice(-6);

  const cumulativePublicContext = formatMessagesWithIds(humanWithIds);
  const localContext = formatMessagesWithIds(localWithIds);

  const sections = [
    ["[SELECTED_ROLE]", selectedRole || "(not provided)"],
    ["[CANDIDATE]", JSON.stringify(candidate, null, 2)],
    ["[TASK_GENERAL_CONTEXT]", taskGeneralContext || "(not provided)"],
    ["[CUMULATIVE_PUBLIC_CONTEXT]", cumulativePublicContext || "(no messages yet)"],
    ["[LOCAL_CONTEXT]", localContext || "(no messages yet)"],
  ];

  // Repair-loop hint: only added when this is a re-audit after a prior
  // failure. The shape is the exact [PRIOR_FAILED_CRITERIA] section the
  // validator.md prompt documents; absent entirely on the first call so
  // the LLM doesn't waste effort on an unfamiliar section.
  if (Array.isArray(priorFailedCriteria) && priorFailedCriteria.length > 0) {
    const failedList = priorFailedCriteria.join(", ");
    const priorText = priorCandidate && typeof priorCandidate === "object"
      ? JSON.stringify({ role: priorCandidate.role, message: priorCandidate.message, groundingMessageIds: priorCandidate.groundingMessageIds }, null, 2)
      : "(unavailable)";
    sections.push([
      "[PRIOR_FAILED_CRITERIA]",
      `The previous candidate at this checkpoint was rejected for: ${failedList}.\nPrevious candidate (for reference only, do NOT audit it again -- audit the new CANDIDATE above):\n${priorText}\nFocus the audit on the listed criteria; ignore ones not in the list.`,
    ]);
  }

  const userContent = sections.map(([header, body]) => `${header}\n${body}`).join("\n\n");

  return { userContent };
}

/**
 * The single exported entry point. `callLLM` must have the same contract
 * as callbacks.js's existing getLLMResponse: async (messages) =>
 * {success:true, data, rawText} | {success:false, error}. This module
 * never performs the fetch itself.
 *
 * Returns:
 *   {success:true, verdict: {passed, failedCriteria, booleans}}
 *     - booleans is the raw 13-key object the LLM returned (kept for
 *       logging/auditing; callers should branch on verdict.passed).
 *   {success:false, code, error} on any failure (blocked prompt, LLM
 *     error, invalid JSON, schema failure).
 *
 * `priorFailedCriteria` and `priorCandidate` (both optional, both for
 * the repair-loop case) are forwarded to buildValidatorUserContext.
 */
export async function validateCandidate({
  chat,
  candidate,
  selectedRole,
  taskGeneralContext,
  callLLM,
  priorFailedCriteria = null,
  priorCandidate = null,
}) {
  if (typeof callLLM !== "function") {
    throw new Error("validateCandidate() requires a callLLM(messages) function to be injected -- it does not perform network calls itself.");
  }

  const promptResult = getValidatorPromptBundle();
  if (promptResult.blocked) {
    return { success: false, code: "VALIDATOR_PROMPT_BLOCKED", error: promptResult.reason };
  }

  const { userContent } = buildValidatorUserContext({
    chat,
    candidate,
    selectedRole,
    taskGeneralContext,
    priorFailedCriteria,
    priorCandidate,
  });
  const messages = [
    { role: "system", content: promptResult.content },
    { role: "user", content: userContent },
  ];

  const llmResponse = await callLLM(messages);
  if (!llmResponse.success) {
    return { success: false, code: "VALIDATOR_API_ERROR", error: llmResponse.error };
  }

  const parseResult = parseValidatorResponse(llmResponse.rawText);
  if (!parseResult.ok) {
    return { success: false, code: "VALIDATOR_PARSE_FAILURE", error: parseResult.error };
  }

  const schemaResult = validateAgainstValidatorSchema(parseResult.parsed);
  if (!schemaResult.ok) {
    return { success: false, code: "VALIDATOR_SCHEMA_FAILURE", error: JSON.stringify(schemaResult.errors) };
  }

  const booleans = parseResult.parsed;
  const verdict = computeValidatorVerdict(booleans);
  return { success: true, verdict: { ...verdict, booleans } };
}
