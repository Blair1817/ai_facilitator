/**
 * promptLoader.js
 *
 * Two-facilitator design: Static uses base.md + static.md (the adapted
 * Alsobay D.2 prompt), while Adaptive-Generalist uses base.md +
 * generalist.md (the process-only frequency-control prompt). Adaptive may
 * instead select one of the three Specialist bundles when the Controller has
 * sufficient evidence. Explicit @Facilitator requests use base.md +
 * requested_generalist.md.
 *
 * This module is the single source of truth for the prompt bundle surface
 * and for fail-closed detection. It does NOT invent, complete, or rewrite
 * any research content. It only:
 *   - reads the source files as-is;
 *   - detects unresolved placeholder markers (`[[ TODO ]]`, "skeleton only",
 *     "content pending", "FRAMEWORK — content pending");
 *   - composes base + role/condition text exactly as given;
 *   - blocks (does not silently substitute) any request that would use a
 *     prompt containing such a marker;
 *   - assembles the "dynamic user context" using only the field names
 *     listed in prompt_design_specification.Rmd's "Context Fields" section.
 *
 * Does NOT touch feature extraction, role eligibility/priority/cooldown, or
 * intervention limits (those remain entirely in utils.js / feature_server.py
 * / callbacks.js's handleChat, unmodified by this module).
 *
 * Self-check (Phase 2.5): `runStartupSelfCheck()` validates the source
 * directory at boot time so a missing file or unresolved marker fails the
 * experiment loud (not silent at runtime). Called from `index.js`.
 */

import fs from "fs";
import path from "path";

// NOTE: deliberately not using import.meta.url here. server/package.json's
// esbuild build script bundles to CJS output format (no explicit --format
// flag), and esbuild emits an explicit warning that "import.meta" is empty
// in that format -- confirmed by actually building and seeing the warning,
// not assumed. Using process.argv[1] instead: the real runtime entry point
// is always `node dist/index.js` (see server/package.json's "dev" script),
// and the build's rsync step copies this module's ./source directory to
// dist/prompts/source alongside dist/index.js, so
// path.dirname(process.argv[1]) reliably resolves to the `dist/` directory
// in the one real execution path this app has.
const ENTRY_DIR = process.argv[1] ? path.dirname(process.argv[1]) : path.join(process.cwd(), "dist");
const MODULE_DIR = path.join(ENTRY_DIR, "prompts");
const SOURCE_DIR = path.join(MODULE_DIR, "source");

// The source package's own stated version (prompt_design_specification.Rmd
// front matter: "版本: v0.1（草稿，待冻结）"). No individual .md file carries
// its own version number, so this single package-level version is applied
// to every prompt sourced from it -- not invented per-file.
export const PROMPT_PACKAGE_VERSION = "v0.1-draft";

// Detects the exact unresolved-placeholder conventions actually used in the
// source files (verified by reading them, not guessed):
//   - "[[ TODO ... ]]"  (was used in v1 static.md; still a valid marker)
//   - "skeleton only"   (was used in v1 static.md header)
//   - "content pending" (was used in v1 static.md title)
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

// Maps the Adaptive Controller's actual (lowercase, unprefixed) Specialist
// role strings to the corresponding source prompt files. The v2 design adds
// "generalist" as a separate Adaptive mode (NOT a Specialist -- see the
// PROMPT_STATUS table below) handled by getGeneralistPromptBundle(). The
// old "facilitator" role (Participation-Balance / Gini-driven) is removed
// from utils.js's ROLES and has no corresponding .md file -- it will never
// be selected by the live pipeline.
const ADAPTIVE_SPECIALIST_FILES = {
  expander:    { file: "expander.md",    generationRole: "INFORMATION_EXPANDER" },
  challenger:  { file: "challenger.md",  generationRole: "EVIDENCE_CHALLENGER" },
  synthesiser: { file: "synthesiser.md", generationRole: "INFORMATION_SYNTHESISER" },
};

// v2 PROMPT_STATUS (Phase 2 update):
//   - base:        "draft" (no [[ TODO ]] markers, but still draft per
//                            prompt_design_specification.Rmd front matter).
//   - static:      "draft" (Phase 2.1 rewrote it to Alsobay D.2; the v1
//                            `[[ TODO ]]` markers are gone).
//   - generalist:  "draft" (Phase 2.2 -- new file, v2 design, no markers).
//   - expander, challenger, synthesiser: "draft" (no markers, not frozen).
//
// `promptStatus` is fixed per file (never derived from marker detection,
// never "final"/"complete") because the absence of a marker is a
// mechanical fact about text, not evidence of research approval -- see
// PROMPT_MODULE_STATUS.md.
//
// `sourceCompleteness` (returned per-bundle) is the actual gate for
// `blocked`; it's derived from marker detection and is either
// "no_markers_found" or "has_unresolved_markers".
const PROMPT_STATUS = {
  base: "draft",
  static: "draft",
  generalist: "draft",
  requested_generalist: "draft",
  expander: "draft",
  challenger: "draft",
  synthesiser: "draft",
};

function computeSourceCompleteness(incompleteMarkers) {
  return incompleteMarkers.length > 0 ? "has_unresolved_markers" : "no_markers_found";
}

function checkAndCompose(filename, roleKey) {
  const base = readSourceFile("base.md");
  const roleFile = readSourceFile(filename);
  const metadata = {
    promptName: roleKey,
    promptVersion: PROMPT_PACKAGE_VERSION,
    promptStatus: PROMPT_STATUS[roleKey] || null,
    condition: null,           // set by caller (Static / Adaptive)
    selectedRole: null,        // set by caller
  };

  if (base.error || roleFile.error) {
    return {
      blocked: true,
      reason: base.error || roleFile.error,
      metadata: { ...metadata, sourceCompleteness: "missing_file" },
    };
  }

  const combined = `${base.content}\n\n---\n\n${roleFile.content}`;
  const incomplete = detectIncompleteMarkers(combined);
  const sourceCompleteness = computeSourceCompleteness(incomplete);

  if (incomplete.length > 0) {
    return {
      blocked: true,
      reason: `${filename} (or base.md) contains unresolved placeholder marker(s): ${incomplete.join(", ")}. Refusing to send an incomplete/draft prompt to the LLM.`,
      metadata: { ...metadata, sourceCompleteness },
    };
  }

  return {
    blocked: false,
    content: combined,
    metadata: { ...metadata, sourceCompleteness },
  };
}

/**
 * Static facilitator. Keep this prompt distinct from Adaptive-Generalist:
 * matching concerns intervention opportunity/frequency, not prompt content.
 */
export function getStaticPromptBundle() {
  const result = checkAndCompose("static.md", "static");
  if (result.blocked) return result;
  return {
    blocked: false,
    content: result.content,
    metadata: {
      ...result.metadata,
      condition: "static",
      selectedRole: null,
      generationRole: "STATIC",
    },
  };
}

/**
 * Adaptive Generalist facilitator (matched-frequency control, Phase 2.2).
 * Adaptive condition when Controller emits "generalist" (no Specialist
 * clearly justified) -> role "GENERALIST".
 */
export function getGeneralistPromptBundle() {
  const result = checkAndCompose("generalist.md", "generalist");
  if (result.blocked) return result;
  return {
    blocked: false,
    content: result.content,
    metadata: {
      ...result.metadata,
      condition: "adaptive",
      selectedRole: "generalist",
      generationRole: "GENERALIST",
    },
  };
}

/**
 * Participant-requested Generalist. This is not an automatic intervention
 * condition: it answers an explicit @Facilitator request while retaining the
 * shared privacy, grounding, neutrality, and output-contract constraints.
 */
export function getRequestedGeneralistPromptBundle() {
  const result = checkAndCompose("requested_generalist.md", "requested_generalist");
  if (result.blocked) return result;
  return {
    blocked: false,
    content: result.content,
    metadata: {
      ...result.metadata,
      condition: "participant_requested",
      selectedRole: "requested_generalist",
      generationRole: "GENERALIST",
      triggerType: "PARTICIPANT_REQUEST",
    },
  };
}

/**
 * Adaptive Specialist facilitator (Phase 4: Controller selects one of
 * {expander, challenger, synthesiser}; this function is only called with
 * one of those three). Static AI is NOT routed through here.
 */
export function getAdaptivePromptBundle(selectedRole) {
  const roleEntry = ADAPTIVE_SPECIALIST_FILES[selectedRole];
  if (!roleEntry) {
    return {
      blocked: true,
      reason: `No prompt file exists in the source package for controller-selected Specialist role "${selectedRole}". Only expander/challenger/synthesiser are defined; generation.schema.json's role enum also has no matching entry. If the Controller emitted "generalist" here, route it via getGeneralistPromptBundle() instead.`,
      metadata: {
        promptName: selectedRole || "(none)",
        promptVersion: PROMPT_PACKAGE_VERSION,
        promptStatus: PROMPT_STATUS[selectedRole] || null,
        condition: "adaptive",
        selectedRole: selectedRole || null,
        sourceCompleteness: "no_prompt_for_role",
      },
    };
  }

  const result = checkAndCompose(roleEntry.file, selectedRole);
  if (result.blocked) return result;
  return {
    blocked: false,
    content: result.content,
    metadata: {
      ...result.metadata,
      condition: "adaptive",
      selectedRole,
      generationRole: roleEntry.generationRole,
    },
  };
}

// ── Self-check (Phase 2.5) ───────────────────────────────────────────────────

/**
 * Runs at experiment startup. Throws if any prompt/schema file required at
 * runtime is missing, unreadable, or contains unresolved placeholder
 * markers. A successful run logs to console; a failure must abort the
 * experiment loud (not silently allow the live pipeline to SILENT-every
 * checkpoint).
 *
 * Required files (Phase 2 + Phase 5.3):
 *   - base.md, static.md, generalist.md, requested_generalist.md, expander.md,
 *     challenger.md, synthesiser.md, assessor.md, validator.md
 *   - generation.schema.json, assessor.schema.json, validation.schema.json
 *
 * Note: validator.md is loaded by server/src/SemanticValidator.js's own
 * getValidatorPromptBundle(), not by a function exported here (mirrors
 * assessor.md's design -- the Assessor/Validator are not Generators, so
 * base.md is not merged in and the bundles live in their own modules).
 * The self-check still requires validator.md to exist with no unresolved
 * markers, since the live Validator LLM call (Phase 5.4) cannot proceed
 * without it.
 *
 * `throwOnFailure`: defaults to true. Set to false in tests that exercise
 * the failure path itself; in that case the function returns
 * `{ok:false, failures}` instead of throwing.
 */
export function runStartupSelfCheck({ throwOnFailure = true } = {}) {
  const required = [
    "base.md",
    "static.md",
    "generalist.md",
    "requested_generalist.md",
    "expander.md",
    "challenger.md",
    "synthesiser.md",
    "assessor.md",
    "validator.md",
    "generation.schema.json",
    "assessor.schema.json",
    "validation.schema.json",
  ];
  const failures = [];

  for (const f of required) {
    const r = readSourceFile(f);
    if (r.error) {
      failures.push({ file: f, kind: "missing", detail: r.error });
      continue;
    }
    // Only markdown-like files carry the marker check; JSON schemas are
    // validated by Ajv at first use, not here.
    if (f.endsWith(".md")) {
      const incomplete = detectIncompleteMarkers(r.content);
      if (incomplete.length > 0) {
        failures.push({ file: f, kind: "unresolved_marker", detail: incomplete.join(", ") });
      }
    }
  }

  if (failures.length > 0) {
    const detail = failures.map((f) => `  - [${f.kind}] ${f.file}: ${f.detail}`).join("\n");
    if (throwOnFailure) {
      throw new Error(
        `[promptLoader] Startup self-check FAILED. Refusing to start the experiment with incomplete prompt infrastructure:\n${detail}`
      );
    }
    return { ok: false, failures };
  }

  // eslint-disable-next-line no-console
  console.log(`[promptLoader] Startup self-check passed (${required.length} files verified, prompt package version ${PROMPT_PACKAGE_VERSION}).`);
  return { ok: true, failures: [] };
}

// ── assembleDynamicUserContext (unchanged shape, kept for backwards compat) ──

/**
 * Assembles the "dynamic user" turn using exactly the field names listed in
 * prompt_design_specification.Rmd's "Context Fields" -> "Generator 需要"
 * section: CHECKPOINT, SELECTED_ROLE, TASK_GENERAL_CONTEXT,
 * RELEVANT_DISCUSSION_STATE, LOCAL_CONTEXT, CUMULATIVE_PUBLIC_CONTEXT,
 * RECENT_AI_MESSAGES. This is a mechanical formatter over data
 * callbacks.js already computes (or, for taskGeneralContext, already has
 * available via round.get("generalInfo") but was not previously passing to
 * the LLM) -- it does not author new facilitation policy text.
 *
 * 2026-08-07 update: RELEVANT_DISCUSSION_STATE was previously UNDEFINED and
 * omitted entirely (no header, no content) because nothing in the live
 * pipeline produced a value for it that didn't risk leaking internal
 * feature values/thresholds/reasoning, which base.md's HARD CONSTRAINTS
 * forbid. Now that PolicyCompiler.js (Step 8, added the same day -- see
 * PROMPT_MODULE_STATUS.md's addendum) produces a `plan` with an
 * already-safe, plain-language `gap` description (built only from
 * EvidenceChecker-verified spans, never from raw scores/thresholds), that
 * plan's `gap` is what fills this field for Adaptive Specialist
 * checkpoints. Static (and any Adaptive call made without a plan, which
 * after v2 design includes the Generalist path -- see audit-phase1.md
 * v3 §3.5) still omits the section exactly as before -- passing no
 * `relevantDiscussionState` argument is unchanged, additive-only behavior
 * for every existing caller.
 *
 * 2026-08-11 update: Delibra spec §11 — added 3 more plan fields
 * (`target`, `requiredReasoningAct`, `answerableQuestionTemplate`) as
 * their own sections. Same omit-rule as RELEVANT_DISCUSSION_STATE:
 * added only when a plan is present (Adaptive Specialist with a
 * compilePlan() output). These are NOT user-supplied, so the
 * `assembleDynamicUserContext` signature gains 3 new optional params.
 * Existing callers that don't pass them (Static, Adaptive Generalist)
 * get byte-for-byte identical output.
 */
export function assembleDynamicUserContext({
  checkpoint,
  selectedRoleForDisplay,
  taskGeneralContext,
  cumulativePublicContext,
  localContext,
  recentAiMessages,
  relevantDiscussionState,
  target,
  requiredReasoningAct,
  answerableQuestionTemplate,
  allowedGroundingMessageIds,
}) {
  const sections = [
    [`[CHECKPOINT]`, checkpoint ?? "(not provided)"],
    [`[SELECTED_ROLE]`, selectedRoleForDisplay ?? "(not provided)"],
    [`[TASK_GENERAL_CONTEXT]`, taskGeneralContext || "(not provided)"],
  ];
  // Only added when a caller actually supplies a value (PolicyCompiler's
  // plan.gap, for Adaptive Specialist checkpoints with a plan) -- omitted
  // entirely otherwise, preserving the exact prior behavior for every
  // other caller (Static, Adaptive Generalist).
  if (relevantDiscussionState) {
    sections.push([`[RELEVANT_DISCUSSION_STATE]`, relevantDiscussionState]);
  }
  // Spec §11 additions: 3 more plan fields, same omit-when-absent rule.
  // Format the target label / message-id as a single line so the
  // Generator sees a stable, machine-greppable shape. These are
  // role-fixed values from PolicyCompiler (per-role constants for the
  // latter two; per-factor for target) -- no risk of leaking internal
  // feature values, just structural role guidance.
  if (target !== undefined && target !== null) {
    const targetLine = target.kind === "message"
      ? `messageId: ${target.messageId}`
      : `missing label: ${target.label}`;
    sections.push([`[TARGET]`, targetLine]);
  }
  if (requiredReasoningAct) {
    sections.push([`[REQUIRED_REASONING_ACT]`, requiredReasoningAct]);
  }
  if (answerableQuestionTemplate) {
    sections.push([`[ANSWERABLE_QUESTION_TEMPLATE]`, answerableQuestionTemplate]);
  }
  if (Array.isArray(allowedGroundingMessageIds)) {
    sections.push([
      `[ALLOWED_GROUNDING_MESSAGE_IDS]`,
      allowedGroundingMessageIds.length ? allowedGroundingMessageIds.join(", ") : "(none)",
    ]);
  }
  sections.push(
    [`[CUMULATIVE_PUBLIC_CONTEXT]`, cumulativePublicContext || "(no messages yet)"],
    [`[LOCAL_CONTEXT]`, localContext || "(no messages yet)"],
    [`[RECENT_AI_MESSAGES]`, recentAiMessages || "(none yet)"],
  );
  return sections.map(([header, body]) => `${header}\n${body}`).join("\n\n");
}
