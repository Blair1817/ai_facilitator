import assert from "node:assert/strict";
import test from "node:test";

import { buildStaticSharedTaskOverview, buildStaticUserContext } from "./StaticContext.mjs";

test("Static overview contains only the shared objective/requirements and alternative labels", () => {
  const overview = buildStaticSharedTaskOverview({
    generalInfo: "# Task A: Choose a site\n\nChoose the most suitable site. All sites meet safety requirements.\n\n## Alpha\n\n- Public fact that is outside the overview.\n\n## Beta\n\n- Another public fact.",
    decisionOptions: [{ id: "secret-a", label: "Alpha" }, { id: "secret-b", label: "Beta" }],
  });

  assert.match(overview, /Choose the most suitable site/);
  assert.match(overview, /All sites meet safety requirements/);
  assert.match(overview, /Available alternatives: Alpha, Beta\./);
  assert.doesNotMatch(overview, /Task A/);
  assert.doesNotMatch(overview, /Public fact|Another public fact|secret-a|secret-b/);
});

test("Static context contains the complete chronological public transcript, timestamps, and timing", () => {
  const context = buildStaticUserContext({
    chat: [
      { timestamp: 1_000, messageType: "human", speakerType: "human", sender: { id: "p1", name: "Green" }, content: "Hello" },
      { timestamp: 2_000, messageType: "facilitator", speakerType: "facilitator", sender: { id: "ai", name: "Facilitator" }, content: "What else should be considered?" },
      { timestamp: 3_000, messageType: "timer_reminder", speakerType: "timer_reminder", sender: { id: "timer", name: "Timer" }, content: "1 minute remains." },
      { timestamp: 4_000, messageType: "human", speakerType: "human", sender: { id: "p2", name: "Blue" }, content: "I have another point" },
    ],
    remainingTimeMs: 75_000,
    elapsedTimeMs: 525_000,
  });

  assert.match(context.userContent, /Time remaining: 1:15/);
  assert.match(context.userContent, /Elapsed discussion time: 8:45/);
  assert.match(context.userContent, /\[m0\] \[1970-01-01T00:00:01\.000Z\] @\[Green\]: Hello/);
  assert.match(context.userContent, /\[m1\].*@\[Facilitator\]: What else should be considered\?/);
  assert.match(context.userContent, /\[m2\].*\[Timer\]: 1 minute remains\./);
  assert.match(context.userContent, /\[m3\].*@\[Blue\]: I have another point/);
  assert.ok(context.userContent.indexOf("[m0]") < context.userContent.indexOf("[m3]"));
  assert.deepEqual(context.eligibleMessageIds, ["m0", "m3"]);
  assert.deepEqual(context.aiOrSystemMessageIds, ["m1", "m2"]);
  assert.deepEqual(context.recentAiMessageTexts, ["What else should be considered?"]);
});

test("Static context API has no private-response or Adaptive-routing inputs", () => {
  const source = buildStaticUserContext.toString();
  for (const forbidden of ["playerContent", "profileSlot", "taskVersion", "sequenceId", "threshold", "selectedRole", "routingRationale"] ) {
    assert.equal(source.includes(forbidden), false, `${forbidden} must not be an input to Static context assembly`);
  }
});
