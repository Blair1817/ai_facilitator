import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const dir = path.dirname(fileURLToPath(import.meta.url));
const callbacks = readFileSync(path.join(dir, "callbacks.js"), "utf8");
const formalHandle = callbacks.slice(callbacks.indexOf("async function handleChat"));

test("formal LLM call sites receive only the sanitised shared task overview", () => {
  assert.match(formalHandle, /buildStaticSharedTaskOverview\(\{/);
  assert.match(formalHandle, /get\("generalInfo"\)/);
  assert.match(formalHandle, /get\("decisionOptions"\)/);
  assert.match(formalHandle, /taskGeneralContext:\s*(?:built\.taskGeneralContext|buildStaticSharedTaskOverview\(\{)/);
  assert.match(callbacks, /generalInfo:\s*publicTaskOverview/);
  assert.doesNotMatch(formalHandle, /get\("playerContent"\)|get\("private|privateProfile|hiddenFacts|answerKey/i);
});

test("formal LLM handlers subscribe only to formal transcripts", () => {
  assert.match(formalHandle, /chat_round_/);
  assert.doesNotMatch(formalHandle, /practice_icebreaker_chat|buildIcebreakerLLMMessages/);
  assert.doesNotMatch(callbacks, /handleIcebreakerChat|IcebreakerFacilitator|PRACTICE_ICEBREAKER/);
});
