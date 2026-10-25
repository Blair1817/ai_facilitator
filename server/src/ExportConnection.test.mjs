import assert from "node:assert/strict";
import http from "node:http";
import test from "node:test";
import { once } from "node:events";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { WebSocketServer } from "ws";
import { connectExportAdmin } from "./ExportConnection.mjs";

// Exercise the bundled SDK used in production. Its bare ESM entry has a
// directory import that Node cannot resolve without esbuild.
const built = await build({
  stdin: { contents: 'export { Tajriba, TajribaAdmin } from "@empirica/tajriba";', resolveDir: fileURLToPath(new URL("..", import.meta.url)) },
  bundle: true, platform: "node", format: "cjs", write: false,
});
const sdkModule = { exports: {} };
new Function("require", "module", "exports", built.outputFiles[0].text)(createRequire(import.meta.url), sdkModule, sdkModule.exports);
const sdk = sdkModule.exports;

test("export survives an invalid 1006 close frame and can still query research data", { timeout: 15000 }, async (t) => {
  const requests = [];
  const server = http.createServer(async (req, res) => {
    let body = "";
    for await (const part of req) body += part;
    const operation = JSON.parse(body);
    requests.push({ query: operation.query, auth: req.headers.authorization });
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify(operation.query.includes("registerService")
      ? { data: { registerService: { sessionToken: "test-session" } } }
      : { data: { scopes: { edges: [], pageInfo: { hasNextPage: false } } } }));
  });
  const wss = new WebSocketServer({ server });
  const sockets = [];
  const connectionParams = [];
  wss.on("connection", (socket) => {
    sockets.push(socket);
    socket.on("error", () => {});
    socket.on("message", (raw) => {
      const message = JSON.parse(raw);
      if (message.type === "connection_init") {
        connectionParams.push(message.payload);
        socket.send(JSON.stringify({ type: "connection_ack" }));
      }
    });
  });
  let admin;
  t.after(async () => {
    admin?.stop();
    for (const socket of wss.clients) socket.terminate();
    wss.close();
    await new Promise((resolve) => server.close(resolve));
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const errors = [];
  let notifyError;
  const gotError = new Promise((resolve) => { notifyError = resolve; });
  admin = await connectExportAdmin({
    url: `http://127.0.0.1:${server.address().port}/query`,
    srtoken: "test-service-token",
    sdk,
    onTransportError: (error) => { errors.push(error); notifyError(); },
  });
  assert.equal(sockets.length, 2, "registration and admin both use SDK sockets");
  // Reproduce the actual incident at the wire level. 1006 is forbidden in a
  // close frame, so ws emits an error which previously crashed callbacks.
  sockets[1]._socket.write(Buffer.from([0x88, 0x02, 0x03, 0xee]));
  await gotError;
  assert.equal(errors[0].error.code, "WS_ERR_INVALID_CLOSE_CODE");
  const scopes = await admin.scopes({ kinds: ["game"] });
  assert.deepEqual(scopes.edges, []);
  assert.equal(connectionParams[1].authToken, "Bearer test-session");
  assert.match(requests.at(-1).query, /scopes/);
  assert.equal(admin.listenerCount("error"), 1);
});
