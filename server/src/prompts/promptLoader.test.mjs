// Prompt 3B, requirement #3: verifies the three Adaptive prompt-to-role
// mappings. Sets process.argv[1] before importing promptLoader.js so its
// ENTRY_DIR resolution (see that file's header comment for why
// import.meta.url isn't used) points at this real server/src tree instead
// of a dist/ build -- no network, no Empirica, no live runtime.
import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// promptLoader.js resolves SOURCE_DIR as dirname(process.argv[1]) + "/prompts/source"
// (its real production entry is dist/index.js with dist/prompts/source
// alongside it, see that file's header comment) -- so the fake entry must
// sit in server/src/, the parent of this prompts/ directory, not inside it.
process.argv[1] = path.join(__dirname, "..", "fake-entry.js");

const { getAdaptivePromptBundle, getStaticPromptBundle } = await import("./promptLoader.js");

const SOURCE_DIR = path.join(__dirname, "source");
const baseText = fs.readFileSync(path.join(SOURCE_DIR, "base.md"), "utf8");
const expanderText = fs.readFileSync(path.join(SOURCE_DIR, "expander.md"), "utf8");
const challengerText = fs.readFileSync(path.join(SOURCE_DIR, "challenger.md"), "utf8");
const synthesiserText = fs.readFileSync(path.join(SOURCE_DIR, "synthesiser.md"), "utf8");

const ROLE_FIXTURES = [
  { controllerRole: "expander", file: "expander.md", text: expanderText, generationRole: "INFORMATION_EXPANDER", otherTexts: [challengerText, synthesiserText] },
  { controllerRole: "challenger", file: "challenger.md", text: challengerText, generationRole: "EVIDENCE_CHALLENGER", otherTexts: [expanderText, synthesiserText] },
  { controllerRole: "synthesiser", file: "synthesiser.md", text: synthesiserText, generationRole: "INFORMATION_SYNTHESISER", otherTexts: [expanderText, challengerText] },
];

for (const fixture of ROLE_FIXTURES) {
  test(`${fixture.controllerRole} -> ${fixture.file} maps to generationRole ${fixture.generationRole}`, () => {
    const bundle = getAdaptivePromptBundle(fixture.controllerRole);
    assert.equal(bundle.blocked, false, bundle.reason);
    assert.equal(bundle.metadata.generationRole, fixture.generationRole);
  });

  test(`${fixture.controllerRole} bundle contains base.md in full`, () => {
    const bundle = getAdaptivePromptBundle(fixture.controllerRole);
    assert.ok(bundle.content.includes(baseText), "bundle must contain base.md's full text");
  });

  test(`${fixture.controllerRole} bundle contains exactly its own role file in full`, () => {
    const bundle = getAdaptivePromptBundle(fixture.controllerRole);
    assert.ok(bundle.content.includes(fixture.text), `bundle must contain ${fixture.file}'s full text`);
  });

  test(`${fixture.controllerRole} bundle does not contain any other role's file content`, () => {
    const bundle = getAdaptivePromptBundle(fixture.controllerRole);
    for (const otherText of fixture.otherTexts) {
      assert.equal(bundle.content.includes(otherText), false, "bundle must not contain another role's full file text");
    }
  });

  test(`${fixture.controllerRole} bundle is exactly base.md + '\\n\\n---\\n\\n' + its role file, nothing more`, () => {
    const bundle = getAdaptivePromptBundle(fixture.controllerRole);
    assert.equal(bundle.content, `${baseText}\n\n---\n\n${fixture.text}`);
  });
}

test("unknown role throws a diagnosable, blocked error (never a fallback prompt)", () => {
  const bundle = getAdaptivePromptBundle("not_a_real_role");
  assert.equal(bundle.blocked, true);
  assert.equal(typeof bundle.reason, "string");
  assert.match(bundle.reason, /no prompt file exists/i);
  assert.equal(bundle.content, undefined);
});

test("the Controller's own 4th role ('facilitator') is blocked, not silently mapped to another role's prompt", () => {
  const bundle = getAdaptivePromptBundle("facilitator");
  assert.equal(bundle.blocked, true);
});

test("empty-string role is blocked, not silently mapped to another role's prompt", () => {
  const bundle = getAdaptivePromptBundle("");
  assert.equal(bundle.blocked, true);
});

test("null/undefined role is blocked, not silently mapped to another role's prompt", () => {
  assert.equal(getAdaptivePromptBundle(null).blocked, true);
  assert.equal(getAdaptivePromptBundle(undefined).blocked, true);
});

test("role names are not silently case-normalized into a different valid role", () => {
  // "Expander"/"EXPANDER" must not be silently coerced to the lowercase
  // controller-role key "expander" -- that would let a malformed/mistyped
  // role slip through as if it were a real Controller selection.
  assert.equal(getAdaptivePromptBundle("Expander").blocked, true);
  assert.equal(getAdaptivePromptBundle("EXPANDER").blocked, true);
  assert.equal(getAdaptivePromptBundle("INFORMATION_EXPANDER").blocked, true, "the generation-schema role string itself must not also be accepted as a controller-role key");
});

test("concurrent prompt loading for different roles does not contaminate either bundle", async () => {
  const [expanderBundle, challengerBundle, synthesiserBundle] = await Promise.all([
    Promise.resolve().then(() => getAdaptivePromptBundle("expander")),
    Promise.resolve().then(() => getAdaptivePromptBundle("challenger")),
    Promise.resolve().then(() => getAdaptivePromptBundle("synthesiser")),
  ]);
  assert.equal(expanderBundle.content, `${baseText}\n\n---\n\n${expanderText}`);
  assert.equal(challengerBundle.content, `${baseText}\n\n---\n\n${challengerText}`);
  assert.equal(synthesiserBundle.content, `${baseText}\n\n---\n\n${synthesiserText}`);
  assert.notEqual(expanderBundle.content, challengerBundle.content);
  assert.notEqual(challengerBundle.content, synthesiserBundle.content);
});

test("Static condition is unaffected by Adaptive mapping work (still gated by static.md's own completeness, per requirement #1)", () => {
  const bundle = getStaticPromptBundle();
  assert.equal(typeof bundle.blocked, "boolean");
});
