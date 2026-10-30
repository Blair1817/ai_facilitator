import test from "node:test";
import assert from "node:assert/strict";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { readFile } from "node:fs/promises";
import { build } from "../../client/node_modules/esbuild/lib/main.js";
import { createClient } from "../../client/node_modules/graphql-ws/lib/client.mjs";
import { monitorTajribaTransport } from "../../client/src/pilot/tajribaTransportRecovery.mjs";

async function until(predicate) {
  const end = Date.now() + 2_000;
  while (!predicate()) {
    assert.ok(Date.now() < end, "expected transport event before timeout");
    await sleep(5);
  }
}

async function browserSDK() {
  const bundle = await build({
    stdin: {
      contents: `import "./src/pilot/tajriba-reconnect-watchdog.js";
        export { Tajriba } from "@empirica/tajriba";
        export { ParticipantConnection } from "./node_modules/@empirica/core/dist/chunk-UMPSA52E.js";
        export { BehaviorSubject } from "rxjs";`,
      resolveDir: fileURLToPath(new URL("../../client/", import.meta.url)),
    },
    plugins: [{ name: "expose-real-participant-connection-for-test", setup(builder) {
      builder.onLoad({ filter: /chunk-UMPSA52E\.js$/ }, async ({ path }) => ({
        contents: `${await readFile(path, "utf8")}\nexport { ParticipantConnection };`, loader: "js",
      }));
    } }],
    bundle: true, write: false, format: "esm", platform: "browser", target: "es2022",
  });
  return import(`data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].text).toString("base64")}`);
}

function sockets(policy = () => ({})) {
  const all = [];
  class Socket {
    static CONNECTING = 0; static OPEN = 1; static CLOSING = 2; static CLOSED = 3;
    constructor() {
      this.index = all.length;
      this.readyState = 0;
      this.protocol = "graphql-transport-ws";
      this.sent = [];
      all.push(this);
      queueMicrotask(() => { this.readyState = 1; this.onopen?.(); });
    }
    receive(message) {
      queueMicrotask(() => {
        if (this.readyState === 1) this.onmessage?.({ data: JSON.stringify(message) });
      });
    }
    send(raw) {
      const m = JSON.parse(raw);
      this.sent.push(m);
      const config = policy(this.index);
      if (m.type === "connection_init" && config.ack !== false) this.receive({ type: "connection_ack" });
      if (m.type === "ping" && config.pong !== false) this.receive({ type: "pong" });
      if (m.type === "subscribe" && config.next !== false) {
        this.receive({ id: m.id, type: "next", payload: { data: { value: this.index } } });
      }
    }
    close(code = 1000, reason = "") {
      if (this.readyState === 3) return;
      this.readyState = 3;
      queueMicrotask(() => this.onclose?.({ code, reason, wasClean: code === 1000 }));
    }
  }
  return { Socket, all };
}

function transport(fixture, options = {}) {
  return createClient({
    url: "ws://synthetic.invalid/query", webSocketImpl: fixture.Socket,
    lazy: false, keepAlive: 5, retryAttempts: 100,
    retryWait: async () => {}, onNonLazyError: () => {}, ...options,
  });
}

test("missing pong retries the existing operation without replacing its client", async (t) => {
  const fixture = sockets(i => ({ pong: i !== 0 }));
  const client = transport(fixture);
  const reasons = [], received = [];
  const monitor = monitorTajribaTransport(client, { pongTimeoutMs: 30, report: r => reasons.push(r) });
  const unsubscribe = client.subscribe({ query: "subscription { value }" }, {
    next: r => received.push(r.data.value), error: assert.fail, complete() {},
  });
  t.after(async () => { monitor.stop(); unsubscribe(); await client.dispose(); });
  await until(() => received.includes(1));
  assert.deepEqual(received.slice(0, 2), [0, 1]);
  assert.deepEqual(reasons, ["heartbeat response timed out"]);
  assert.equal(fixture.all.length, 2);
  await sleep(50);
  assert.equal(fixture.all.length, 2, "healthy pong responses must prevent further recovery");
});

test("responsive pongs cannot mask a frozen business subscription", async (t) => {
  const fixture = sockets(i => ({ next: i !== 0 }));
  const client = transport(fixture);
  const reasons = [];
  const monitor = monitorTajribaTransport(client, {
    probeIntervalMs: 10, probeTimeoutMs: 25, report: r => reasons.push(r),
    probe: sink => client.subscribe({ query: "subscription { value }" }, sink),
  });
  t.after(async () => { monitor.stop(); await client.dispose(); });
  await until(() => fixture.all.length === 2);
  await sleep(60);
  assert.deepEqual(reasons, ["subscription response timed out"]);
  assert.equal(fixture.all.length, 2);
  assert.ok(fixture.all[0].sent.some(m => m.type === "ping"));
});

test("three simultaneous abnormal disconnects restore each existing subscription", async (t) => {
  const fixture = sockets();
  const received = [[], [], []];
  const clients = received.map(() => transport(fixture));
  const monitors = clients.map(client => monitorTajribaTransport(client));
  const unsubscribes = clients.map((client, index) => client.subscribe({ query: "subscription { value }" }, {
    next: result => received[index].push(result.data.value), error: assert.fail, complete() {},
  }));
  t.after(async () => {
    monitors.forEach(monitor => monitor.stop());
    unsubscribes.forEach(unsubscribe => unsubscribe());
    await Promise.all(clients.map(client => client.dispose()));
  });
  await until(() => received.every(results => results.length === 1));
  fixture.all.slice().forEach(socket => socket.close(1006, "synthetic network loss"));
  await until(() => received.every(results => results.length === 2));
  assert.equal(fixture.all.length, 6);
  assert.equal(fixture.all.filter(socket => socket.readyState === 1).length, 3);
  assert.ok(fixture.all.every(socket => socket.sent.filter(m => m.type === "subscribe").length === 1));
});

test("handshake deadline retries a socket that opens but never acknowledges", async (t) => {
  const fixture = sockets(i => ({ ack: i !== 0 }));
  const client = transport(fixture);
  const reasons = [];
  const monitor = monitorTajribaTransport(client, { connectTimeoutMs: 25, report: r => reasons.push(r) });
  t.after(async () => { monitor.stop(); await client.dispose(); });
  await until(() => fixture.all.length === 2);
  await until(() => fixture.all[1].sent.some(m => m.type === "connection_init"));
  assert.deepEqual(reasons, ["connection acknowledgement timed out"]);
});

test("background/offline deadlines defer, and stopping removes their pending retries", async () => {
  const fixture = sockets(() => ({ pong: false }));
  const client = transport(fixture);
  let suspended = true;
  const reasons = [];
  const monitor = monitorTajribaTransport(client, {
    pongTimeoutMs: 15, isSuspended: () => suspended, report: r => reasons.push(r),
  });
  try {
    await sleep(60);
    assert.equal(fixture.all.length, 1);
    assert.deepEqual(reasons, []);
    suspended = false;
    await until(() => fixture.all.length === 2);
    monitor.stop();
    const count = fixture.all.length;
    await sleep(40);
    assert.equal(fixture.all.length, count);
    assert.equal(reasons.length, 1);
  } finally { monitor.stop(); await client.dispose(); }
});

test("a GraphQL probe error is a live response, not a reason to discard the session", async (t) => {
  const fixture = sockets();
  const client = transport(fixture);
  const reasons = [];
  let probes = 0, cancellations = 0;
  const monitor = monitorTajribaTransport(client, {
    probeIntervalMs: 8, probeTimeoutMs: 15, report: r => reasons.push(r),
    probe: sink => {
      probes++;
      sink.error([{ message: "Access Denied" }]);
      return () => { cancellations++; };
    },
  });
  t.after(async () => { monitor.stop(); await client.dispose(); });
  await until(() => probes >= 3);
  assert.deepEqual(reasons, []);
  assert.equal(cancellations, probes, "even synchronous responses must release the probe");
  assert.equal(fixture.all.length, 1);
});

test("SDK marks connected only after GraphQL ACK and stop cannot resurrect its client", async () => {
  const fixture = sockets(() => ({ ack: false }));
  const original = { WebSocket: globalThis.WebSocket, window: globalThis.window, document: globalThis.document };
  globalThis.WebSocket = fixture.Socket;
  globalThis.window = new EventTarget();
  globalThis.document = Object.assign(new EventTarget(), { hidden: false });
  // The browser SDK has directory imports unsupported by native Node ESM.
  // Bundle the actual application entry and SDK as the production client does.
  const { Tajriba } = await browserSDK();
  const taj = new Tajriba("http://synthetic.invalid/query", "synthetic-session");
  try {
    taj.connect();
    await until(() => fixture.all[0]?.sent.some(m => m.type === "connection_init"));
    assert.equal(taj.connected, false, "raw WebSocket open is not authenticated readiness");
    fixture.all[0].receive({ type: "connection_ack" });
    await until(() => taj.connected);
    const originalClient = taj._wsClient;
    taj.on("closed", () => taj.connect());
    taj.stop();
    await sleep(20);
    assert.equal(taj._wsClient, undefined);
    assert.equal(fixture.all.length, 1, "intentional stop must not re-open a connection");
    await originalClient.dispose();
  } finally {
    taj.removeAllListeners("closed");
    taj.stop();
    Object.assign(globalThis, original);
  }
});

test("temporary participant handshake failure retries the same saved session", async () => {
  const { ParticipantConnection, BehaviorSubject } = await browserSDK();
  const session = { token: "synthetic-session", participant: { id: "synthetic-participant" } };
  const sessions = new BehaviorSubject(session);
  let attempts = 0, resets = 0, stopped = 0;
  const part = { connected: true, on() {}, removeAllListeners() {}, stop() { stopped++; } };
  const taj = { connected: new BehaviorSubject(true), async sessionParticipant(token, participant) {
    assert.equal(token, session.token);
    assert.equal(participant, session.participant);
    if (++attempts === 1) throw Object.assign(new Error("synthetic timeout"), { code: "TAJRIBA_SESSION_CONNECT_TIMEOUT" });
    return part;
  } };
  const connection = new ParticipantConnection(taj, sessions, () => { resets++; });
  try {
    await until(() => connection.connected.getValue());
    assert.equal(attempts, 2);
    assert.equal(resets, 0);
    assert.equal(sessions.getValue(), session);
  } finally { connection.stop(); }
  assert.equal(stopped, 1);
});

test("leaving during a pending participant handshake disposes its late result", async () => {
  const { ParticipantConnection, BehaviorSubject } = await browserSDK();
  let resolve, stopped = 0;
  const pending = new Promise(r => { resolve = r; });
  const taj = { connected: new BehaviorSubject(true), sessionParticipant: () => pending };
  const connection = new ParticipantConnection(taj,
    new BehaviorSubject({ token: "synthetic", participant: { id: "synthetic" } }), assert.fail);
  await sleep(5);
  connection.stop();
  resolve({ stop() { stopped++; } });
  await until(() => stopped === 1);
  assert.equal(connection.participant.getValue(), undefined);
  assert.equal(connection.connected.getValue(), false);
});
