import assert from "node:assert/strict";
import test from "node:test";

import { buildStaticSharedTaskOverview } from "./StaticContext.mjs";

test("Shared task overview contains only the shared objective/requirements and alternative labels", () => {
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
