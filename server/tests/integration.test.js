/**
 * Integration tests: feature server -> getCandidateRoles (Step 4 only)
 * Requires feature server to be running:
 *   python src/feature_server.py
 *
 * 2026-08-07 rewrite: the old version of this file called selectRole()
 * directly on live feature-server output to get a final role, with no
 * semantic layer involved -- that whole code path no longer exists (see
 * utils.js's header comment / server/src/prompts/PROMPT_MODULE_STATUS.md's
 * addendum). Role selection now requires a Semantic Assessor LLM call
 * (SemanticAssessor.js) + Evidence Checker (EvidenceChecker.js) between
 * features and evaluateGate()/chooseRole() -- that full path is covered by
 * server/src/SemanticAssessor.test.mjs and server/src/EvidenceChecker.test.mjs
 * using a mocked LLM, not here.
 *
 * This file keeps its original, narrower purpose (a cheap check against
 * the REAL feature server, no LLM key needed) by testing only the part of
 * the pipeline that is still purely feature-based: getCandidateRoles(),
 * Step 4's high-recall pre-filter.
 *
 * Run:
 *   NODE_OPTIONS=--experimental-vm-modules npx jest tests/integration.test.js
 */

import { getCandidateRoles } from "../src/utils.js";

const FEATURE_SERVER = "http://localhost:5001";

async function getFeatures(messagePairs, redundancyThreshold = 0.85) {
  const messages = messagePairs.map(([sender, text]) => ({ sender, text }));
  const response = await fetch(FEATURE_SERVER + "/features", {
    method:  "POST",
    headers: { "Content-Type": "application/json" },
    body:    JSON.stringify({ messages, redundancy_threshold: redundancyThreshold })
  });
  return response.json();
}

// ── Health check ───────────────────────────────────────────────────────────────

describe("Feature server", () => {
  test("is reachable", async () => {
    const response = await fetch(FEATURE_SERVER + "/health");
    expect(response.ok).toBe(true);
  });
});

// ── Challenger candidate ─────────────────────────────────────────────────────

describe("Integration: Challenger candidate", () => {
  test("high agreement + no reasoning -> challenger becomes a candidate", async () => {
    const features = await getFeatures([
      ["Red",   "Yeah I agree Eldoron is the best"],
      ["Pink",  "Exactly makes sense to me"],
      ["Green", "Yes definitely Eldoron"],
      ["Red",   "Absolutely agreed"],
      ["Pink",  "Same here"],
      ["Green", "I agree too"],
    ]);

    expect(features.agreement_score).toBeGreaterThan(0.5);
    expect(features.justification_score).toBeLessThan(0.4);

    expect(getCandidateRoles(features)).toContain("challenger");
  });
});

// ── Expander candidate ────────────────────────────────────────────────────────

describe("Integration: Expander candidate", () => {
  test("repetitive messages -> expander becomes a candidate", async () => {
    const features = await getFeatures([
      ["Red",   "Eldoron is the best choice for the event"],
      ["Pink",  "Yes Eldoron is definitely the best choice"],
      ["Green", "Eldoron is the best choice I agree completely"],
      ["Red",   "I think Eldoron is clearly the best option available"],
      ["Pink",  "Eldoron is obviously the best choice we have"],
      ["Green", "Yes Eldoron is the best"],
    ]);

    expect(features.novelty_score).toBeLessThan(0.6);
    expect(getCandidateRoles(features)).toContain("expander");
  });
});

// ── No candidates -- Candidate Gate resolves Abstain without an LLM call ───────

describe("Integration: Productive discussion", () => {
  test("diverse substantive discussion -> no candidate roles (Candidate Gate would Abstain without calling the Semantic Assessor)", async () => {
    const features = await getFeatures([
      ["Red",   "The transportation infrastructure in Eldoron is excellent because of the new rail links"],
      ["Pink",  "However Myloria has stronger volunteer support according to the local council data"],
      ["Green", "Cragnio benefits from a dry season which means fewer weather cancellation risks"],
      ["Red",   "Based on the budget constraints Eldoron may require less facility repurposing"],
      ["Pink",  "Since Myloria has supportive local businesses the economic impact would be higher"],
      ["Green", "Therefore we should weigh the long term legacy benefits against short term costs"],
    ]);

    expect(features.justification_score).toBeGreaterThan(0.5);
    expect(features.novelty_score).toBeGreaterThan(0.4);
    expect(getCandidateRoles(features)).toEqual([]);
  });
});
