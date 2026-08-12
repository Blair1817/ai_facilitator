import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const dir = path.dirname(fileURLToPath(import.meta.url));
const callbacks = readFileSync(path.join(dir, "callbacks.js"), "utf8");
const icebreaker = readFileSync(path.join(dir, "IcebreakerFacilitator.mjs"), "utf8");
const formalHandle = callbacks.slice(callbacks.indexOf("async function handleChat"));
const icebreakerHandle = callbacks.slice(
  callbacks.indexOf("async function handleIcebreakerChat"),
  callbacks.indexOf('// ── on("game", "chat_round_N")'),
);

test("formal LLM call sites with task-context parameters pass an empty value", () => {
  assert.doesNotMatch(formalHandle, /get\("generalInfo"\)/);
  assert.doesNotMatch(formalHandle, /get\("decisionOptions"\)/);
  assert.match(formalHandle, /taskGeneralContext:\s*""/);
  assert.match(callbacks, /generalInfo:\s*""/);
  assert.match(callbacks, /taskGeneralContext:\s*""/);
  assert.match(callbacks, /Task materials are not available to the facilitator/);
});

test("icebreaker and formal handlers use different transcript keys and context builders", () => {
  assert.match(icebreakerHandle, /intro_round_/);
  assert.match(icebreakerHandle, /buildIcebreakerLLMMessages\(chat\)/);
  assert.doesNotMatch(icebreakerHandle, /chat_round_|buildGeneratorContext|assessSemanticFactors|validateCandidate|generalInfo|decisionOptions|playerContent/);
  assert.match(formalHandle, /chat_round_/);
  assert.doesNotMatch(formalHandle, /intro_round_|buildIcebreakerLLMMessages/);
});

test("icebreaker boundary module imports no task or formal-pipeline source", () => {
  const imports = icebreaker.split("\n").filter((line) => /^\s*import\s/u.test(line)).join("\n");
  assert.equal(imports, "");
});
