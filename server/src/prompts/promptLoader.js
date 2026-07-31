/**
 * promptLoader.js
 *
 * Loads and composes the prompt files under ./source (copied verbatim from
 * the user-provided Prompt source package -- see
 * server/src/prompts/PROMPT_MODULE_STATUS.md for provenance and status).
 *
 * This module does NOT invent, complete, or rewrite any research content.
 * It only:
 *   - reads the source files as-is;
 *   - detects unresolved placeholder markers ([[ TODO ]], "skeleton",
 *     "content pending", "FRAMEWORK — content pending");
 *   - composes base + role/condition text exactly as given;
 *   - blocks (does not silently substitute) any request that would use a
 *     prompt containing such a marker;
 *   - assembles the "dynamic user context" using only the field names
 *     listed in prompt_design_specification.Rmd's "Context Fields" section
 *     (CHECKPOINT, SELECTED_ROLE, TASK_GENERAL_CONTEXT,
 *     RELEVANT_DISCUSSION_STATE, LOCAL_CONTEXT, CUMULATIVE_PUBLIC_CONTEXT,
 *     RECENT_AI_MESSAGES) -- mechanical field-passing, not new policy text.
 *
 * Does NOT touch feature extraction, role eligibility/priority/cooldown, or
 * intervention limits (those remain entirely in utils.js / feature_server.py
 * / callbacks.js's handleChat, unmodified by this module).
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
//   - "[[ TODO ... ]]"  (static.md, multiple)
//   - "skeleton only"   (static.md header note)
//   - "content pending" (static.md title: "FRAMEWORK — content pending")
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

// Maps the Controller's actual (lowercase, unprefixed) role strings --
// see server/src/utils.js's ROLE_PRIORITY, unmodified by this module -- to
// the corresponding source prompt file. "facilitator" (Participation
// Balance / Gini-driven) is a role the Controller can select but has no
// corresponding prompt file anywhere in the source package, and no entry
// in generation.schema.json's role enum (STATIC, INFORMATION_EXPANDER,
// EVIDENCE_CHALLENGER, INFORMATION_SYNTHESISER) -- this is a real,
// pre-existing gap, not something this module papers over. See
// PROMPT_MODULE_STATUS.md.
const ADAPTIVE_ROLE_FILES = {
  expander: { file: "expander.md", generationRole: "INFORMATION_EXPANDER" },
  challenger: { file: "challenger.md", generationRole: "EVIDENCE_CHALLENGER" },
  synthesiser: { file: "synthesiser.md", generationRole: "INFORMATION_SYNTHESISER" },
};

// CORRECTED (per explicit instruction): the absence of a `[[ TODO ]]`/
// skeleton marker in a source file is a MECHANICAL fact about the text, not
// evidence that the research team has approved or frozen it as final
// content. prompt_design_specification.Rmd's own front matter states the
// whole package is "版本: v0.1（草稿，待冻结）" (draft, pending freeze) --
// nothing in this package has been through a research-approval step.
// `promptStatus` therefore represents ONLY approval/freeze state and is
// fixed per file, never derived from marker detection, and never set to
// "final" or "complete":
//   - base / expander / challenger / synthesiser: "draft" (no [[ TODO ]]
//     markers found, but not research-approved/frozen -- still draft).
//   - static: "skeleton_pending" (both draft AND mechanically incomplete).
// Mechanical completeness (marker detection) is recorded separately in
// `sourceCompleteness`, which is what actually gates `blocked`.
const PROMPT_STATUS = {
  base: "draft",
  static: "skeleton_pending",
  expander: "draft",
  challenger: "draft",
  synthesiser: "draft",
};

function computeSourceCompleteness(incompleteMarkers) {
  return incompleteMarkers.length > 0 ? "has_unresolved_markers" : "no_markers_found";
}

/**
 * Static condition: base.md + static.md.
 * static.md is a confirmed skeleton (multiple [[ TODO ]] markers) as of the
 * copy taken for this module -- this WILL currently always return
 * blocked:true. That is the correct, intended behavior per this task's
 * requirement #11, not a bug.
 */
export function getStaticPromptBundle() {
  const base = readSourceFile("base.md");
  const staticFile = readSourceFile("static.md");
  const metadata = {
    promptName: "static",
    promptVersion: PROMPT_PACKAGE_VERSION,
    promptStatus: PROMPT_STATUS.static,
    condition: "static",
    selectedRole: null,
  };

  if (base.error || staticFile.error) {
    return {
      blocked: true,
      reason: base.error || staticFile.error,
      metadata: { ...metadata, sourceCompleteness: "missing_file" },
    };
  }

  const combined = `${base.content}\n\n---\n\n${staticFile.content}`;
  const incomplete = detectIncompleteMarkers(combined);
  const sourceCompleteness = computeSourceCompleteness(incomplete);

  if (incomplete.length > 0) {
    return {
      blocked: true,
      reason: `static.md contains unresolved placeholder marker(s): ${incomplete.join(", ")}. Refusing to send an incomplete/draft prompt to the LLM.`,
      metadata: { ...metadata, sourceCompleteness },
    };
  }

  return {
    blocked: false,
    content: combined,
    metadata: { ...metadata, sourceCompleteness, generationRole: "STATIC" },
  };
}

/**
 * Adaptive condition: base.md + the role file matching the Controller's
 * actual selected role (unchanged input -- this module does not select,
 * re-select, or override the role).
 */
export function getAdaptivePromptBundle(selectedRole) {
  const metadata = {
    promptName: selectedRole || "(none)",
    promptVersion: PROMPT_PACKAGE_VERSION,
    promptStatus: PROMPT_STATUS[selectedRole] || null,
    condition: "adaptive",
    selectedRole: selectedRole || null,
  };

  const roleEntry = ADAPTIVE_ROLE_FILES[selectedRole];
  if (!roleEntry) {
    return {
      blocked: true,
      reason: `No prompt file exists in the source package for controller-selected role "${selectedRole}". Only expander/challenger/synthesiser are defined; generation.schema.json's role enum also has no matching entry. This is a pre-existing gap between the Controller's role set (utils.js ROLE_PRIORITY) and the Prompt source package, not something this loader invents a fallback for.`,
      metadata: { ...metadata, sourceCompleteness: "no_prompt_for_role" },
    };
  }

  const base = readSourceFile("base.md");
  const roleFile = readSourceFile(roleEntry.file);
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
      reason: `${roleEntry.file} contains unresolved placeholder marker(s): ${incomplete.join(", ")}. Refusing to send an incomplete/draft prompt to the LLM.`,
      metadata: { ...metadata, sourceCompleteness },
    };
  }

  return {
    blocked: false,
    content: combined,
    metadata: { ...metadata, sourceCompleteness, generationRole: roleEntry.generationRole },
  };
}

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
 * RELEVANT_DISCUSSION_STATE is UNDEFINED and is not sent to the LLM at all.
 * Corrected per explicit instruction: this field must not contain any
 * self-authored explanatory text, and no engineering-status commentary may
 * be sent to the model. The spec defines this as a required Generator input
 * field but does not specify its wording, and base.md's HARD CONSTRAINTS
 * forbid exposing raw feature values/thresholds/scoring to the model.
 * Until the research team defines this field, the section is omitted
 * entirely from the assembled text (no header, no placeholder line, no
 * content). Its undefined status is recorded only in
 * PROMPT_MODULE_STATUS.md and in code comments -- never in what gets sent
 * to the LLM.
 */
export function assembleDynamicUserContext({
  checkpoint,
  selectedRoleForDisplay,
  taskGeneralContext,
  cumulativePublicContext,
  localContext,
  recentAiMessages,
}) {
  const sections = [
    [`[CHECKPOINT]`, checkpoint ?? "(not provided)"],
    [`[SELECTED_ROLE]`, selectedRoleForDisplay ?? "(not provided)"],
    [`[TASK_GENERAL_CONTEXT]`, taskGeneralContext || "(not provided)"],
    // RELEVANT_DISCUSSION_STATE intentionally omitted -- see doc comment above.
    [`[CUMULATIVE_PUBLIC_CONTEXT]`, cumulativePublicContext || "(no messages yet)"],
    [`[LOCAL_CONTEXT]`, localContext || "(no messages yet)"],
    [`[RECENT_AI_MESSAGES]`, recentAiMessages || "(none yet)"],
  ];
  return sections.map(([header, body]) => `${header}\n${body}`).join("\n\n");
}
