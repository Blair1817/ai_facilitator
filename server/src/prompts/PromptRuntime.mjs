import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";

const entryDir = process.argv[1] ? path.dirname(process.argv[1]) : path.join(process.cwd(), "dist");
export const RUNTIME_SOURCE_DIR = path.join(entryDir, "prompts", "source", "runtime");
export const AUTOMATIC_MAX_WORDS = 50;
export const SYNTHESISER_MAX_WORDS = 55;
export const PROMPT_RUNTIME_VERSION = "v3.2";
export const SPECIALIST_ROLES = Object.freeze({ expander: "INFORMATION_EXPANDER", challenger: "EVIDENCE_CHALLENGER", synthesiser: "INFORMATION_SYNTHESISER" });
export function isSpecialistRole(role) { return Object.values(SPECIALIST_ROLES).includes(role); }
export function readRuntimeFile(filename) {
  if (filename.includes("..") || path.isAbsolute(filename)) throw new Error("Invalid prompt source path");
  return fs.readFileSync(path.join(RUNTIME_SOURCE_DIR, filename), "utf8");
}
export function readRuntimeManifest() { return JSON.parse(readRuntimeFile("manifest.json")); }
export function runtimeGeneratorBundle(route) {
  const metadata = { promptName: route, promptVersion: PROMPT_RUNTIME_VERSION, promptStatus: "research_review_draft", condition: null, selectedRole: null };
  try {
    const manifest = readRuntimeManifest();
    const entry = manifest.routes[route];
    if (!entry) throw new Error(`Unknown prompt route: ${route}`);
    const content = entry.generatorFiles.map(readRuntimeFile).join(manifest.compositionSeparator);
    if (/\[\[\s*TODO\b|skeleton\s+only|content\s+pending/i.test(content)) throw new Error("Incomplete runtime prompt");
    return { blocked: false, content, metadata: { ...metadata, sourceCompleteness: "no_markers_found", promptHash: createHash("sha256").update(content).digest("hex"), maxWords: entry.maxWords ?? null } };
  } catch (error) { return { blocked: true, reason: error.message, metadata: { ...metadata, sourceCompleteness: "missing_or_invalid_runtime_package" } }; }
}
export function validatorRuntimePath(selectedRole, triggerType) {
  if (triggerType === "PARTICIPANT_REQUEST") return "frozen_control/validator.md";
  return isSpecialistRole(selectedRole) ? "specialist/validator.md" : "control_50/validator.md";
}
export function verifyRuntimeSources() {
  const manifest = readRuntimeManifest();
  for (const [filename, expected] of Object.entries(manifest.files)) {
    const content = fs.readFileSync(path.join(RUNTIME_SOURCE_DIR, filename));
    if (createHash("sha256").update(content).digest("hex") !== expected.sha256) throw new Error(`Prompt integrity mismatch: ${filename}`);
  }
  return true;
}
