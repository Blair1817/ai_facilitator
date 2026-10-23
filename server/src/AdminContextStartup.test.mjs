import assert from "node:assert/strict";
import test from "node:test";

import {
  initialiseAdminContextWithRetry,
  isTransientAdminContextError,
} from "./AdminContextStartup.mjs";

test("classifies connection-refused startup errors as transient", () => {
  assert.equal(
    isTransientAdminContextError(new Error("connect ECONNREFUSED 127.0.0.1:3000")),
    true,
  );
  assert.equal(isTransientAdminContextError(new Error("invalid session token")), false);
});

test("retries transient startup failures and returns the first successful context", async () => {
  let calls = 0;
  const waits = [];
  const retries = [];
  const expected = { connected: true };

  const actual = await initialiseAdminContextWithRetry(
    async () => {
      calls += 1;
      if (calls < 3) throw new Error("connect ECONNREFUSED 127.0.0.1:3000");
      return expected;
    },
    {
      attempts: 4,
      delayMs: 25,
      wait: async (ms) => waits.push(ms),
      onRetry: ({ attempt }) => retries.push(attempt),
    },
  );

  assert.equal(actual, expected);
  assert.equal(calls, 3);
  assert.deepEqual(waits, [25, 25]);
  assert.deepEqual(retries, [1, 2]);
});

test("does not retry a non-transient startup failure", async () => {
  let calls = 0;
  await assert.rejects(
    initialiseAdminContextWithRetry(async () => {
      calls += 1;
      throw new Error("invalid session token");
    }),
    /invalid session token/,
  );
  assert.equal(calls, 1);
});

test("stops after the configured transient retry budget", async () => {
  let calls = 0;
  await assert.rejects(
    initialiseAdminContextWithRetry(
      async () => {
        calls += 1;
        throw new Error("connect ECONNREFUSED 127.0.0.1:3000");
      },
      { attempts: 3, delayMs: 0, wait: async () => {} },
    ),
    /ECONNREFUSED/,
  );
  assert.equal(calls, 3);
});
