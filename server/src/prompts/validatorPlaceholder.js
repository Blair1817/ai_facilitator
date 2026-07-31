/**
 * validatorPlaceholder.js
 *
 * GRAIL scope-reduction refactor: the semantic Validator LLM is
 * DELIBERATELY NOT part of the live discussion runtime path. It was wired
 * in during an earlier revision of this codebase (Prompt 3B); this
 * revision removes that production wiring per the scope-reduction
 * objective ("do not build or preserve duplicate ... validation ...
 * systems" -- GRAIL's Static/Adaptive share one basic schema/role/length/
 * grounding validator instead, see server/src/prompts/GeneratorContract.mjs
 * and its use in server/src/callbacks.js).
 *
 * validation.schema.json (server/src/prompts/source/validation.schema.json)
 * is preserved as an OFFLINE / pilot-evaluation artifact only -- it defines
 * what a future offline semantic-quality check could grade candidate
 * interventions against, but nothing in the live callback path calls it or
 * imports this module. No validator.md (Validator PROMPT text) exists
 * anywhere in the source package either (prompt_design_specification.Rmd's
 * own checklist still has "编写 `validator.md`" unchecked).
 *
 * This module name is preserved unchanged (not renamed, not deleted) so a
 * later, separate task can reintroduce an offline/pilot evaluation use of
 * validation.schema.json without re-inventing this status/contract surface.
 */

import fs from "fs";
import path from "path";

// See promptLoader.js's header comment for why import.meta.url is not used
// here (esbuild's CJS output format empties it).
const ENTRY_DIR = process.argv[1] ? path.dirname(process.argv[1]) : path.join(process.cwd(), "dist");
const SOURCE_DIR = path.join(ENTRY_DIR, "prompts", "source");

export function getValidatorStatus() {
  let schemaExists = false;
  try {
    fs.accessSync(path.join(SOURCE_DIR, "validation.schema.json"));
    schemaExists = true;
  } catch {
    schemaExists = false;
  }
  return {
    implemented: false,
    calledInLiveRuntime: false,
    outputSchemaAvailable: schemaExists,
    promptAvailable: false,
    reason: "Semantic Validator LLM removed from the live discussion runtime path (GRAIL scope-reduction refactor). validation.schema.json is kept only as an offline/pilot evaluation artifact; no validator.md prompt text exists in the source package.",
  };
}

/**
 * Always returns NOT_IMPLEMENTED. Present so a future offline/pilot
 * evaluation task has a stable call site; deliberately not called by
 * callbacks.js or any other production code.
 */
export function validate(_candidateIntervention) {
  return {
    status: "NOT_IMPLEMENTED",
    ...getValidatorStatus(),
  };
}
