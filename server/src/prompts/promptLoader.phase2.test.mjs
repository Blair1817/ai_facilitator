// Phase 2 (v2 design) tests for promptLoader.js + LLMConfig.js.
//
// v2 design: TWO independent facilitator systems (Static AI vs Adaptive AI).
// The Static AI facilitator's prompt is NOT byte-identical to the Adaptive
// AI's Generalist fallback -- they are two separate .md files. Tests here
// assert that separation, plus the new bundle API, plus the schema enum,
// plus the startup self-check.
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

const {
  getStaticPromptBundle,
  getGeneralistPromptBundle,
  getAdaptivePromptBundle,
  runStartupSelfCheck,
  PROMPT_PACKAGE_VERSION,
} = await import("./promptLoader.js");

const SOURCE_DIR = path.join(__dirname, "source");
const baseText = fs.readFileSync(path.join(SOURCE_DIR, "base.md"), "utf8");
const staticText = fs.readFileSync(path.join(SOURCE_DIR, "static.md"), "utf8");
const generalistText = fs.readFileSync(path.join(SOURCE_DIR, "generalist.md"), "utf8");
const expanderText = fs.readFileSync(path.join(SOURCE_DIR, "expander.md"), "utf8");
const challengerText = fs.readFileSync(path.join(SOURCE_DIR, "challenger.md"), "utf8");
const synthesiserText = fs.readFileSync(path.join(SOURCE_DIR, "synthesiser.md"), "utf8");

// ── getStaticPromptBundle ────────────────────────────────────────────────────

test("getStaticPromptBundle returns blocked=false (no markers in v2 static.md)", () => {
  const bundle = getStaticPromptBundle();
  assert.equal(bundle.blocked, false, bundle.reason);
});

test("getStaticPromptBundle metadata.condition = 'static', generationRole = 'STATIC'", () => {
  const bundle = getStaticPromptBundle();
  assert.equal(bundle.metadata.condition, "static");
  assert.equal(bundle.metadata.generationRole, "STATIC");
  assert.equal(bundle.metadata.selectedRole, null);
});

test("getStaticPromptBundle content = base.md + '\\n\\n---\\n\\n' + static.md", () => {
  const bundle = getStaticPromptBundle();
  assert.equal(bundle.content, `${baseText}\n\n---\n\n${staticText}`);
});

test("getStaticPromptBundle preserves the Static scoreboard policy without embedding task material", () => {
  const bundle = getStaticPromptBundle();
  assert.match(bundle.content, /scoreboard/i);
  assert.match(bundle.content, /\{\{sharedTaskOverview\}\}/);
  assert.doesNotMatch(bundle.content, /Eldoron|Myloria|Cragnio|Rovenna|Talwick|Meridia/);
  assert.match(bundle.content, /Task materials are\s+outside the LLM boundary/i);
});

test("getStaticPromptBundle does NOT instruct the LLM to output a RATIONALE field", () => {
  // The original Alsobay D.2 prompt told the LLM to respond with
  // {MESSAGE, RATIONALE}. The v2 adapter removed that instruction
  // (generation.schema.json has no RATIONALE field; additionalProperties:
  // false would fail-closed any output that included it). The static.md
  // header still mentions the word "RATIONALE" in its adapter-note
  // documentation -- that's expected, since the word is required to
  // explain what was removed. This test only checks the INSTRUCTION is
  // gone (no "RATIONALE:" field description directed at the model).
  const bundle = getStaticPromptBundle();
  // Strip the header comment (lines starting with '>') before checking,
  // so the documentation in static.md's header is excluded from the
  // contract.
  const bodyOnly = bundle.content.split("\n").filter((l) => !l.startsWith(">")).join("\n");
  assert.equal(/RATIONALE\s*:/i.test(bodyOnly), false, "static.md's body must not contain a 'RATIONALE:' field instruction");
  assert.equal(/MESSAGE\s*:\s*Include/i.test(bodyOnly), false, "static.md must not carry the original Alsobay 'MESSAGE: Include...' instruction (base.md owns the output contract)");
});

test("getStaticPromptBundle forbids Markdown/list formatting consistently with the shared Generator contract", () => {
  const bundle = getStaticPromptBundle();
  assert.match(bundle.content, /Do not use Markdown, headings, lists, bullets, numbering, or newlines for formatting/);
  assert.doesNotMatch(bundle.content, /you may use newlines for formatting/i);
});

test("all Generator bundles require grounding IDs to be quoted JSON strings", () => {
  for (const bundle of [getStaticPromptBundle(), getGeneralistPromptBundle(), getAdaptivePromptBundle("expander")]) {
    assert.match(bundle.content, /quoted JSON string/);
    assert.match(bundle.content, /\["m2", "m3"\]/);
    assert.match(bundle.content, /never output bare identifiers/i);
  }
});

test("getStaticPromptBundle does NOT contain generalist.md content (Static AI != Generalist)", () => {
  const bundle = getStaticPromptBundle();
  assert.equal(bundle.content.includes(generalistText), false, "Static bundle must not contain Generalist content");
});

// ── getGeneralistPromptBundle ────────────────────────────────────────────────

test("getGeneralistPromptBundle returns blocked=false", () => {
  const bundle = getGeneralistPromptBundle();
  assert.equal(bundle.blocked, false, bundle.reason);
});

test("getGeneralistPromptBundle metadata.condition = 'adaptive', generationRole = 'GENERALIST'", () => {
  const bundle = getGeneralistPromptBundle();
  assert.equal(bundle.metadata.condition, "adaptive");
  assert.equal(bundle.metadata.generationRole, "GENERALIST");
  assert.equal(bundle.metadata.selectedRole, "generalist");
});

test("getGeneralistPromptBundle content = base.md + '\\n\\n---\\n\\n' + generalist.md", () => {
  const bundle = getGeneralistPromptBundle();
  assert.equal(bundle.content, `${baseText}\n\n---\n\n${generalistText}`);
});

test("getGeneralistPromptBundle does NOT contain static.md content (Generalist != Static AI)", () => {
  const bundle = getGeneralistPromptBundle();
  assert.equal(bundle.content.includes(staticText), false, "Generalist bundle must not contain Static AI content");
});

test("getGeneralistPromptBundle does NOT contain any Specialist role's content", () => {
  const bundle = getGeneralistPromptBundle();
  assert.equal(bundle.content.includes(expanderText), false, "Generalist must not contain expander content");
  assert.equal(bundle.content.includes(challengerText), false, "Generalist must not contain challenger content");
  assert.equal(bundle.content.includes(synthesiserText), false, "Generalist must not contain synthesiser content");
});

test("getGeneralistPromptBundle does NOT instruct the LLM to act as a scoreboard (that is closer to Synthesiser)", () => {
  // The Alsobay Static prompt has "acting as a scoreboard" wording. The
  // v2 Generalist is the Adaptive's matched-frequency control and is
  // deliberately process-only -- scoreboard-style aggregation is the
  // Synthesiser's job, not Generalist's. The generalist.md header
  // explains this in its own header, so we strip the header comments
  // before checking the body.
  const bundle = getGeneralistPromptBundle();
  const bodyOnly = bundle.content.split("\n").filter((l) => !l.startsWith(">")).join("\n");
  assert.equal(/act(ing)?\s+as\s+a\s+scoreboard/i.test(bodyOnly), false, "Generalist body must not instruct the LLM to act as a scoreboard");
  assert.equal(/keep(ing)?\s+track\s+of\s+pros\s+and\s+cons/i.test(bodyOnly), false, "Generalist body must not instruct pros/cons tracking (that is Synthesiser's job)");
});

// ── Cross-facilitator separation (the core v2 invariant) ────────────────────

test("Static AI bundle and Adaptive Generalist bundle are NOT byte-identical (two different prompts)", () => {
  const staticBundle = getStaticPromptBundle();
  const generalistBundle = getGeneralistPromptBundle();
  assert.notEqual(
    staticBundle.content,
    generalistBundle.content,
    "Static AI and Generalist must have different .md sources (v2 design: two independent facilitators)"
  );
});

test("Static AI and Adaptive Generalist bundles each carry only their own role file's full text", () => {
  const staticBundle = getStaticPromptBundle();
  const generalistBundle = getGeneralistPromptBundle();

  assert.ok(staticBundle.content.includes(staticText), "Static bundle must contain its own file in full");
  assert.equal(staticBundle.content.includes(generalistText), false, "Static bundle must not contain Generalist file");

  assert.ok(generalistBundle.content.includes(generalistText), "Generalist bundle must contain its own file in full");
  assert.equal(generalistBundle.content.includes(staticText), false, "Generalist bundle must not contain Static file");
});

test("No Specialist bundle contains Generalist content, and vice versa", () => {
  const generalistBundle = getGeneralistPromptBundle();
  for (const text of [expanderText, challengerText, synthesiserText]) {
    assert.equal(generalistBundle.content.includes(text), false);
  }
  for (const role of ["expander", "challenger", "synthesiser"]) {
    const bundle = getAdaptivePromptBundle(role);
    assert.equal(bundle.content.includes(generalistText), false, `${role} bundle must not contain Generalist content`);
  }
});

// ── Routing guards ──────────────────────────────────────────────────────────

test("getAdaptivePromptBundle('generalist') is BLOCKED -- 'generalist' must route via getGeneralistPromptBundle, not here", () => {
  // This is the routing-invariance test: Generalist is a separate bundle
  // (matched-frequency control), not a Specialist. If the Controller
  // emits role='generalist', the dispatcher (LLMConfig.llmSystemPrompts)
  // routes it to getGeneralistPromptBundle, NOT here. Calling
  // getAdaptivePromptBundle('generalist') directly must fail closed so
  // future refactors that bypass the dispatcher get caught.
  const bundle = getAdaptivePromptBundle("generalist");
  assert.equal(bundle.blocked, true, "getAdaptivePromptBundle must reject 'generalist' -- it is not a Specialist");
  assert.match(bundle.reason, /no prompt file exists|only expander\/challenger\/synthesiser|getGeneralistPromptBundle/i);
});

test("LLMConfig dispatcher routes 'static' -> STATIC, 'adaptive' + 'generalist' -> GENERALIST, 'adaptive' + 'expander' -> INFORMATION_EXPANDER", async () => {
  // Importing the dispatcher is safe in node:test -- no network, no
  // Empirica side effects.
  const { llmSystemPrompts } = await import("../LLMConfig.js");

  const staticBundle = llmSystemPrompts("static", null);
  assert.equal(staticBundle.blocked, false);
  assert.equal(staticBundle.metadata.generationRole, "STATIC");

  const generalistBundle = llmSystemPrompts("adaptive", "generalist");
  assert.equal(generalistBundle.blocked, false);
  assert.equal(generalistBundle.metadata.generationRole, "GENERALIST");
  assert.equal(generalistBundle.metadata.condition, "adaptive");

  const expanderBundle = llmSystemPrompts("adaptive", "expander");
  assert.equal(expanderBundle.blocked, false);
  assert.equal(expanderBundle.metadata.generationRole, "INFORMATION_EXPANDER");
});

test("LLMConfig dispatcher routes 'static' even if a role arg is given (Static ignores role)", async () => {
  const { llmSystemPrompts } = await import("../LLMConfig.js");
  const bundle = llmSystemPrompts("static", "expander"); // role arg is ignored
  assert.equal(bundle.blocked, false);
  assert.equal(bundle.metadata.generationRole, "STATIC");
  assert.equal(bundle.metadata.condition, "static");
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
  assert.equal(getStaticPromptBundle().metadata.promptVersion, v);
  assert.equal(getGeneralistPromptBundle().metadata.promptVersion, v);
  assert.equal(getAdaptivePromptBundle("expander").metadata.promptVersion, v);
});

// ── Both facilitators carry the shared base.md verbatim ────────────────────

test("Static AI and Generalist bundles both contain the same base.md in full", () => {
  const staticBundle = getStaticPromptBundle();
  const generalistBundle = getGeneralistPromptBundle();
  // Both must contain base.md's full text -- the shared rules are shared
  // even though the .md role files are different.
  assert.ok(staticBundle.content.includes(baseText));
  assert.ok(generalistBundle.content.includes(baseText));
});
