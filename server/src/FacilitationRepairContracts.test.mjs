import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const dirname = path.dirname(fileURLToPath(import.meta.url));
const callbacksSource = readFileSync(path.join(dirname, "callbacks.js"), "utf8");
const promptLoaderSource = readFileSync(path.join(dirname, "prompts/promptLoader.js"), "utf8");
const requestedPromptSource = readFileSync(path.join(dirname, "prompts/source/requested_generalist.md"), "utf8");

test("Static and Adaptive-Generalist compose their distinct approved prompt sources", () => {
  const staticStart = promptLoaderSource.indexOf("export function getStaticPromptBundle");
  const generalistStart = promptLoaderSource.indexOf("export function getGeneralistPromptBundle");
  const staticBody = promptLoaderSource.slice(staticStart, generalistStart);
  const adaptiveStart = promptLoaderSource.indexOf("export function getAdaptivePromptBundle", generalistStart);
  const generalistBody = promptLoaderSource.slice(generalistStart, adaptiveStart);

  assert.ok(staticStart >= 0 && generalistStart > staticStart && adaptiveStart > generalistStart);
  assert.match(staticBody, /checkAndCompose\("static\.md",\s*"static"\)/);
  assert.match(generalistBody, /checkAndCompose\("generalist\.md",\s*"generalist"\)/);
  assert.doesNotMatch(staticBody, /checkAndCompose\("generalist\.md"/);
});

test("Static and Generalist prompt files are both startup dependencies", () => {
  const selfCheckStart = promptLoaderSource.indexOf("export function runStartupSelfCheck");
  const selfCheckBody = promptLoaderSource.slice(selfCheckStart);
  const requiredArray = selfCheckBody.slice(
    selfCheckBody.indexOf("const required = ["),
    selfCheckBody.indexOf("];", selfCheckBody.indexOf("const required = [")) + 2,
  );
  assert.match(requiredArray, /"static\.md"/);
  assert.match(requiredArray, /"generalist\.md"/);
});

// Actual bounded recovery behavior is exercised in AdaptivePipeline and
// AdaptiveRecovery tests; this contract checks shared prompt/publication wiring.
test("Adaptive recovery uses the same Static generator/validator path", () => {
  const start = callbacksSource.indexOf("async function fallback()");
  const end = callbacksSource.indexOf("async function generate(selection)", start);
  const fallback = callbacksSource.slice(start, end);
  assert.ok(start > 0 && end > start);
  assert.match(fallback, /selectedRole = "STATIC"/);
  assert.match(fallback, /buildGeneratorContext\([^;]*"static", null, null\)/);
  assert.match(fallback, /runSharedGeneration\(/);
  assert.match(fallback, /role: "STATIC"/);
  assert.match(callbacksSource, /recordPublish\(game, \{ role: result\.role/);
});

test("@Facilitator routes to a participant-requested Generalist before automatic policies", () => {
  const handleStart = callbacksSource.indexOf("async function handleChat");
  const handleBody = callbacksSource.slice(handleStart);
  const requestRoute = handleBody.indexOf("if (isMentionCheckpoint)");
  const automaticAttempt = handleBody.indexOf("recordAttempt(game, humanMessageCount, now)");
  const staticRoute = handleBody.indexOf('if (facilitation === "static")');

  assert.ok(requestRoute >= 0 && requestRoute < automaticAttempt && automaticAttempt < staticRoute);
  assert.match(handleBody, /getRequestedGeneralistPromptBundle\(\)/);
  assert.match(handleBody, /routingDecision\s*=\s*"REQUESTED_GENERALIST"/);
  assert.match(handleBody, /postParticipantRequestFallback\(/);
});

test("requested Generalist prompt preserves privacy, grounding, and neutrality boundaries", () => {
  assert.match(requestedPromptSource, /private participant profiles/i);
  assert.match(requestedPromptSource, /correct answers/i);
  assert.match(requestedPromptSource, /shared public task overview and public discussion/i);
  assert.match(requestedPromptSource, /Private reports, hidden facts, and answer keys are not provided/i);
  assert.match(requestedPromptSource, /Never choose, recommend, rank, vote for/i);
  assert.match(requestedPromptSource, /Do not remain silent/i);
});

test("requested replies are logged separately from automatic intervention budgets", () => {
  assert.match(callbacksSource, /recordParticipantRequest\(game,\s*humanMessageCount\)/);
  assert.match(callbacksSource, /recordParticipantRequestedPublish\(game,/);
  assert.match(callbacksSource, /triggerType\s*=\s*"PARTICIPANT_REQUEST"/);
  assert.match(callbacksSource, /participantRequested:\s*isMentionCheckpoint/);
  assert.match(callbacksSource, /if \(requestedResult\.published\)/);
  assert.match(callbacksSource, /totalFallbackMessages/);
  assert.doesNotMatch(
    callbacksSource.slice(
      callbacksSource.indexOf("function postParticipantRequestFallback"),
      callbacksSource.indexOf("async function handleChat"),
    ),
    /totalInterventions/,
  );
});

test("shared public task overview reaches formal generators without private profiles", () => {
  assert.match(callbacksSource, /buildStaticSharedTaskOverview\(\{/);
  assert.match(callbacksSource, /generalInfo:\s*game\.currentRound\?\.get\("generalInfo"\)/);
  assert.match(callbacksSource, /decisionOptions:\s*game\.currentRound\?\.get\("decisionOptions"\)/);
  const generatorBody = callbacksSource.slice(
    callbacksSource.indexOf("function buildGeneratorContext"),
    callbacksSource.indexOf("// ── Shared generation/validation/publication path"),
  );
  assert.doesNotMatch(generatorBody, /playerContent|profileSlot|HPTConfig/);
  assert.match(generatorBody, /generalInfo:\s*publicTaskOverview/);
});
