import assert from "node:assert/strict";
import test from "node:test";

import {
  parseAdminEndpoint,
  waitForAdminEndpoint,
} from "./AdminContextStartup.mjs";

test("parses callback URLs into TCP endpoints", () => {
  assert.deepEqual(parseAdminEndpoint("http://localhost:3000/query"), {
    host: "localhost",
    port: 3000,
  });
  assert.deepEqual(parseAdminEndpoint("wss://example.test/query"), {
    host: "example.test",
    port: 443,
  });
});

test("waits until the callback endpoint accepts a TCP connection", async () => {
  let calls = 0;
  const waits = [];
  const retries = [];

  const endpoint = await waitForAdminEndpoint(
    "http://localhost:3000/query",
    {
      connect: async (host, port, timeoutMs) => {
        assert.equal(host, "localhost");
        assert.equal(port, 3000);
        assert.equal(timeoutMs, 40);
        calls += 1;
        return calls === 3;
      },
      attempts: 4,
      delayMs: 25,
      connectTimeoutMs: 40,
      wait: async (ms) => waits.push(ms),
      onRetry: ({ attempt }) => retries.push(attempt),
    },
  );

  assert.deepEqual(endpoint, { host: "localhost", port: 3000 });
  assert.equal(calls, 3);
  assert.deepEqual(waits, [25, 25]);
  assert.deepEqual(retries, [1, 2]);
});

test("returns immediately when the callback endpoint is already reachable", async () => {
  let calls = 0;
  const endpoint = await waitForAdminEndpoint(
    "http://127.0.0.1:3000/query",
    {
      connect: async () => {
        calls += 1;
        return true;
      },
      wait: async () => assert.fail("wait should not be called"),
    },
  );

  assert.deepEqual(endpoint, { host: "127.0.0.1", port: 3000 });
  assert.equal(calls, 1);
});

test("stops after the configured endpoint wait budget", async () => {
  let calls = 0;
  await assert.rejects(
    waitForAdminEndpoint(
      "http://localhost:3000/query",
      {
        connect: async () => {
          calls += 1;
          return false;
        },
        attempts: 3,
        delayMs: 0,
        wait: async () => {},
      },
    ),
    /did not become reachable after 3 attempts/,
  );
  assert.equal(calls, 3);
});
