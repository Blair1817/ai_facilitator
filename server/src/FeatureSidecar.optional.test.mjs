import test from "node:test";
import assert from "node:assert/strict";
import { getCandidateRoles } from "./utils.js";

const FEATURE_SERVER = "http://localhost:5001";
const live = process.env.RUN_LIVE_FEATURE_SIDECAR === "1";

async function getFeatures(messagePairs, redundancyThreshold = 0.85) {
  const response = await fetch(`${FEATURE_SERVER}/features`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      messages: messagePairs.map(([sender, text]) => ({ sender, text })),
      redundancy_threshold: redundancyThreshold,
    }),
  });
  assert.equal(response.ok, true);
  return response.json();
}

test("live feature sidecar health", { skip: !live }, async () => {
  const response = await fetch(`${FEATURE_SERVER}/health`);
  assert.equal(response.ok, true);
});

test("live sidecar: high agreement and little reasoning produce a Challenger candidate", { skip: !live }, async () => {
  const features = await getFeatures([
    ["P1", "Yeah I agree option one is the best"],
    ["P2", "Exactly makes sense to me"],
    ["P3", "Yes definitely option one"],
    ["P1", "Absolutely agreed"],
    ["P2", "Same here"],
    ["P3", "I agree too"],
  ]);
  assert.ok(features.agreement_score > 0.5);
  assert.ok(features.justification_score < 0.4);
  assert.ok(getCandidateRoles(features).includes("challenger"));
});

test("live sidecar: repetitive messages produce an Expander candidate", { skip: !live }, async () => {
  const features = await getFeatures([
    ["P1", "Option one is the best choice for the event"],
    ["P2", "Yes option one is definitely the best choice"],
    ["P3", "Option one is the best choice I agree completely"],
    ["P1", "I think option one is clearly the best option available"],
    ["P2", "Option one is obviously the best choice we have"],
    ["P3", "Yes option one is the best"],
  ]);
  assert.ok(features.novelty_score < 0.6);
  assert.ok(getCandidateRoles(features).includes("expander"));
});

test("live sidecar: diverse substantive discussion yields no feature-level candidates", { skip: !live }, async () => {
  const features = await getFeatures([
    ["P1", "Option one has better transport because of the new rail links"],
    ["P2", "However option two has stronger volunteer support according to the council data"],
    ["P3", "Option three has fewer weather cancellation risks"],
    ["P1", "Based on budget constraints option one may require less repurposing"],
    ["P2", "Since option two has supportive businesses its economic impact could be higher"],
    ["P3", "Therefore we should weigh long-term benefits against short-term costs"],
  ]);
  assert.ok(features.justification_score > 0.5);
  assert.ok(features.novelty_score > 0.4);
  assert.deepEqual(getCandidateRoles(features), []);
});
