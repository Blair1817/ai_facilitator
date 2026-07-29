/**
 * Integration tests: feature server → selectRole
 * Requires feature server to be running:
 *   python src/feature_server.py
 *
 * Run:
 *   NODE_OPTIONS=--experimental-vm-modules npx jest tests/integration.test.js
 */

import { selectRole } from "../src/utils.js";

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

// ── Challenger scenario ────────────────────────────────────────────────────────

describe("Integration: Challenger scenario", () => {
  test("high agreement + no reasoning → challenger selected", async () => {
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

    const result = selectRole(features, 300000, null, false);
    expect(result.role).toBe("challenger");
  });
});

// ── Facilitator scenario ───────────────────────────────────────────────────────

describe("Integration: Facilitator scenario", () => {
  test("one dominant speaker → facilitator selected", async () => {
    const features = await getFeatures([
      ["Red", "I think Eldoron is the best choice because of its transport links"],
      ["Red", "Also Eldoron has great sports facilities and welcoming residents"],
      ["Red", "Furthermore Eldoron is a top tourist destination with good weather"],
      ["Red", "And the infrastructure is excellent for large scale international events"],
      ["Pink",  "Ok"],
      ["Green", "Yes"],
    ]);

    expect(features.gini_score).toBeGreaterThan(0.4);

    const result = selectRole(features, 300000, null, false);
    expect(result.role).toBe("facilitator");
  });
});

// ── Expander scenario ──────────────────────────────────────────────────────────

describe("Integration: Expander scenario", () => {
  test("repetitive messages → expander selected", async () => {
    const features = await getFeatures([
      ["Red",   "Eldoron is the best choice for the event"],
      ["Pink",  "Yes Eldoron is definitely the best choice"],
      ["Green", "Eldoron is the best choice I agree completely"],
      ["Red",   "I think Eldoron is clearly the best option available"],
      ["Pink",  "Eldoron is obviously the best choice we have"],
      ["Green", "Yes Eldoron is the best"],
    ]);

    expect(features.novelty_score).toBeLessThan(0.6);

    const result = selectRole(features, 300000, null, false);
    expect(["expander", "challenger"]).toContain(result.role);
  });
});

// ── Forced synthesiser ─────────────────────────────────────────────────────────

describe("Integration: Forced synthesiser", () => {
  test("fires in last 15 seconds regardless of features", async () => {
    const features = await getFeatures([
      ["Red",   "I think Eldoron is the best choice"],
      ["Pink",  "What about Myloria though"],
      ["Green", "Cragnio has some good points too"],
      ["Red",   "We need to make a decision soon"],
      ["Pink",  "Let me share what I know"],
      ["Green", "The weather is an important factor"],
    ]);

    const result = selectRole(features, 15000, null, false);
    expect(result.role).toBe("synthesiser");
    expect(result.forced).toBe(true);
  });
});

// ── Productive discussion ──────────────────────────────────────────────────────

describe("Integration: Productive discussion", () => {
  test("diverse substantive discussion → silent", async () => {
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

    const result = selectRole(features, 300000, null, false);
    expect(result.role).toBe("silent");
  });
});