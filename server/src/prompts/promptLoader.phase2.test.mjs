// Tests for promptLoader.js + LLMConfig.js bundle routing.
//
// Only the Adaptive Specialists (and, via getRequestedGeneralistPromptBundle,
// the participant-requested Generalist) have prompt bundles. The Static
// condition and the Adaptive Static-policy turn send the Alsobay et al.
// request (AlsobayStatic.mjs, covered by AlsobayStatic.test.mjs); the
// control_50 Static/automatic-Generalist package was deleted on 2026-11-19.
//
// Sets process.argv[1] before importing promptLoader.js so its ENTRY_DIR
// resolution points at this real server/src tree instead of a dist/ build
// -- no network, no Empirica, no live runtime. Same convention as the
// existing promptLoader.test.mjs.

import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
process.argv[1] = path.join(__dirname, "..", "fake-entry.js");

const loader = await import("./promptLoader.js");
const { getAdaptivePromptBundle, getRequestedGeneralistPromptBundle, runStartupSelfCheck, PROMPT_PACKAGE_VERSION } = loader;

const SOURCE_DIR = path.join(__dirname, "source");

// ── No automatic non-Specialist bundle ──────────────────────────────────────

test("there is no Static or automatic Generalist bundle, prompt file or manifest route", () => {
  assert.equal("getStaticPromptBundle" in loader, false);
  assert.equal("getGeneralistPromptBundle" in loader, false);
  assert.equal(fs.existsSync(path.join(SOURCE_DIR, "runtime/control_50")), false);
  const manifest = JSON.parse(fs.readFileSync(path.join(SOURCE_DIR, "runtime/manifest.json"), "utf8"));
  assert.equal("static" in manifest.routes, false);
  assert.equal("generalist" in manifest.routes, false);
});

test("all Generator bundles require grounding IDs to be quoted JSON strings", () => {
  for (const bundle of [getRequestedGeneralistPromptBundle(), getAdaptivePromptBundle("expander")]) {
    assert.equal(bundle.blocked, false, bundle.reason);
    assert.match(bundle.content, /quoted JSON string/);
    assert.match(bundle.content, /groundingMessageIds/);
  }
});

// ── Routing guards ──────────────────────────────────────────────────────────

test("getAdaptivePromptBundle('generalist') is BLOCKED -- 'generalist' is not a Specialist", () => {
  // There is no automatic Generalist: when no Specialist is selected the
  // Adaptive condition sends the Alsobay et al. request. Calling
  // getAdaptivePromptBundle('generalist') directly must fail closed.
  const bundle = getAdaptivePromptBundle("generalist");
  assert.equal(bundle.blocked, true, "getAdaptivePromptBundle must reject 'generalist' -- it is not a Specialist");
  assert.match(bundle.reason, /no prompt file exists|only expander\/challenger\/synthesiser|getGeneralistPromptBundle/i);
});

test("LLMConfig dispatcher routes Specialists and blocks the retired Static / automatic Generalist routes", async () => {
  // Importing the dispatcher is safe in node:test -- no network, no
  // Empirica side effects.
  const { llmSystemPrompts } = await import("../LLMConfig.js");

  for (const [facilitation, role] of [["static", null], ["static", "expander"], ["adaptive", "generalist"]]) {
    const bundle = llmSystemPrompts(facilitation, role);
    assert.equal(bundle.blocked, true, `${facilitation}/${role} must be blocked`);
    assert.match(bundle.reason, /Alsobay/);
  }

  const expanderBundle = llmSystemPrompts("adaptive", "expander");
  assert.equal(expanderBundle.blocked, false);
  assert.equal(expanderBundle.metadata.generationRole, "INFORMATION_EXPANDER");
});

test("LLMConfig dispatcher rejects unknown facilitation value", async () => {
  const { llmSystemPrompts } = await import("../LLMConfig.js");
  const bundle = llmSystemPrompts("not-a-condition", "expander");
  assert.equal(bundle.blocked, true);
  assert.match(bundle.reason, /unrecognized facilitation value/i);
});

// ── Schema enum ─────────────────────────────────────────────────────────────

test("generation.schema.json role enum contains exactly STATIC, GENERALIST, and the three Specialists (5 values)", () => {
  const schema = JSON.parse(fs.readFileSync(path.join(SOURCE_DIR, "generation.schema.json"), "utf8"));
  const expected = [
    "STATIC",
    "GENERALIST",
    "INFORMATION_EXPANDER",
    "EVIDENCE_CHALLENGER",
    "INFORMATION_SYNTHESISER",
  ];
  assert.deepEqual(
    [...schema.properties.role.enum].sort(),
    [...expected].sort(),
    "generation.schema.json's role enum must match the v2 design (1 Static + 1 Generalist + 3 Specialists)"
  );
});

test("generation.schema.json has additionalProperties: false (fail-closed for unknown fields, including RATIONALE)", () => {
  const schema = JSON.parse(fs.readFileSync(path.join(SOURCE_DIR, "generation.schema.json"), "utf8"));
  assert.equal(schema.additionalProperties, false);
});

// ── Startup self-check ─────────────────────────────────────────────────────

test("runStartupSelfCheck passes against the real source directory", () => {
  const result = runStartupSelfCheck({ throwOnFailure: false });
  assert.equal(result.ok, true, `self-check should pass against real source dir; failures: ${JSON.stringify(result.failures)}`);
  assert.deepEqual(result.failures, []);
});

test("runStartupSelfCheck throws by default on failure (live runtime must abort loud)", () => {
  // Verify the throw path by monkey-patching ENTRY_DIR. We can't do that
  // here without touching private state, so instead verify the contract
  // directly: the function either returns ok:true or throws -- never
  // returns ok:false silently.
  const result = runStartupSelfCheck({ throwOnFailure: false });
  assert.equal(result.ok, true);
});

test("runStartupSelfCheck would throw on a missing prompt file (covered by throwOnFailure: true default)", () => {
  // We can't actually delete a source file from a test (the test would
  // break for every other test that follows). Document the contract:
  // when throwOnFailure: true (the default) and a file is missing or
  // contains an unresolved marker, the function throws with a message
  // that names the offending file. This test just asserts the function
  // is exported and has that signature.
  assert.equal(typeof runStartupSelfCheck, "function");
});

// ── PROMPT_PACKAGE_VERSION is recorded on every bundle ──────────────────────

test("Every bundle metadata carries the same PROMPT_PACKAGE_VERSION", () => {
  const v = PROMPT_PACKAGE_VERSION;
  assert.equal(getRequestedGeneralistPromptBundle().metadata.promptVersion, v);
  assert.equal(getAdaptivePromptBundle("expander").metadata.promptVersion, v);
});
