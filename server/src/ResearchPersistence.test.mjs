import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const dirname = path.dirname(fileURLToPath(import.meta.url));
const clientRoot = path.join(dirname, "../../client/src");
const read = (relativePath) => readFileSync(path.join(clientRoot, relativePath), "utf8");
const serverPackage = JSON.parse(readFileSync(path.join(dirname, "../package.json"), "utf8"));
const callbacksSource = readFileSync(path.join(dirname, "callbacks.js"), "utf8");
const viteConfigSource = readFileSync(path.join(clientRoot, "../vite.config.js"), "utf8");

const clientFinalizedRoundForms = [
  ["stages/InitialDecision.jsx", "initialDecision"],
  ["intro-exit/TLX.jsx", "tlxSurvey"],
  ["intro-exit/SubjectiveSurvey.jsx", "subjectiveSurvey"],
];

test("client-finalized round research forms restore a browser-local draft and store a timestamped final record", () => {
  for (const [relativePath, recordKey] of clientFinalizedRoundForms) {
    const source = read(relativePath);
    assert.match(source, /usePersistentDraft/);
    assert.match(source, new RegExp(`player\\.round\\.set\\("${recordKey}"`));
    assert.match(source, /submittedAt: Date\.now\(\)/);
    assert.match(source, /clearDraftKeys/);
  }
});

test("FinalDecision restores private local drafts but only the server writes its finalized timestamped record", () => {
  const source = read("stages/FinalDecision.jsx");
  assert.match(source, /usePersistentDraft/);
  assert.match(source, /finalDecisionDraftRequest/);
  assert.match(source, /finalDecisionConfirmRequest/);
  assert.doesNotMatch(source, /player\.round\.set\("finalDecision"/);
  assert.match(callbacksSource, /participant\.round\.set\("finalDecision", \{/);
  assert.match(callbacksSource, /submittedAt: now/);
});

test("global exit forms wait for their exact stored submission before advancing", () => {
  for (const [relativePath, recordKey] of [
    ["intro-exit/FinalQuestions.jsx", "finalQuestions"],
    ["intro-exit/ExpFeedback.jsx", "expFeedback"],
  ]) {
    const source = read(relativePath);
    assert.match(source, /usePersistentDraft/);
    assert.match(source, new RegExp(`player\\.set\\("${recordKey}"`));
    assert.match(source, /storedSubmission\?\.submissionId !== pendingSubmissionId/);
    assert.match(source, /submittedAt: Date\.now\(\)/);
  }
});

test("chat drafts survive reloads while sent messages use the reviewed server request boundary", () => {
  const source = read("components/CustomChat.jsx");
  assert.match(source, /form: "chat"/);
  assert.match(source, /usePersistentDraft/);
  assert.match(source, /player\.set\("humanMessageRequest"/);
});

test("server build bundles Empirica dependencies required by the callbacks runtime", () => {
  assert.doesNotMatch(serverPackage.scripts.build, /--packages=external/);
  assert.match(serverPackage.scripts.build, /--bundle/);
  assert.match(serverPackage.scripts.build, /createRequire/);
});

test("onGameStart imports the THRESHOLDS value persisted in systemInfo", () => {
  assert.match(callbacksSource, /import\s*\{[^}]*\bTHRESHOLDS\b[^}]*\}\s*from\s*["']\.\/utils\.js["']/s);
  assert.match(callbacksSource, /thresholds:\s*THRESHOLDS/);
});

test("local player dev server accepts Empirica's IPv6 localhost proxy", () => {
  assert.match(viteConfigSource, /host:\s*["']::["']/);
});
