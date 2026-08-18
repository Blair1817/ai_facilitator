import assert from "node:assert/strict";
import test from "node:test";

import {
  createPilotGlobalAttributes,
  shouldStubGlobalAttributes,
} from "./tajribaPatchPolicy.js";

test("stubs only the unauthenticated base Tajriba connection", () => {
  assert.equal(shouldStubGlobalAttributes({ token: undefined }), true);
  assert.equal(shouldStubGlobalAttributes({ token: "" }), true);
  assert.equal(shouldStubGlobalAttributes({ token: "session-token" }), false);
});

test("supplies only the pilot registration gate and completion marker", () => {
  const events = [];
  createPilotGlobalAttributes().subscribe((event) => events.push(event));
  assert.deepEqual(events, [
    {
      attribute: { key: "experimentOpen", val: "true" },
      done: false,
    },
    { done: true },
  ]);
});
