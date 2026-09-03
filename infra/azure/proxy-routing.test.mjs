import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CADDYFILE = path.join(HERE, "Caddyfile");
const ACA_FRAGMENT = path.join(HERE, "containerapp-export-sidecar.fragment.yaml");
const EXPORT_AUTH = `Basic ${Buffer.from("researcher:test-password").toString("base64")}`;

test("Caddy and ACA configuration preserve the secure routing contract", () => {
  const caddy = fs.readFileSync(CADDYFILE, "utf8");
  assert.match(caddy, /^:8080\s*\{/m);
  assert.match(caddy, /@exports path \/exports \/exports\/\*/);
  assert.match(caddy, /handle @exports\s*\{\s*reverse_proxy 127\.0\.0\.1:3001\s*\}/s);
  assert.doesNotMatch(caddy, /handle_path|uri\s+(?:strip_prefix|replace)|basic_auth/);
  assert.match(caddy, /reverse_proxy 127\.0\.0\.1:3000\s*\{\s*header_up -Authorization/s);
  assert.doesNotMatch(caddy, /header_up -Authorization[\s\S]*127\.0\.0\.1:3001/);

  const aca = fs.readFileSync(ACA_FRAGMENT, "utf8");
  assert.match(aca, /targetPort: 8080/);
  assert.match(aca, /image: __ACR_LOGIN_SERVER__\/delibra-export-gateway:__IMMUTABLE_TAG__/);
  assert.match(aca, /name: EXPORT_BASE_PATH\s+value: \/exports/);
  assert.match(aca, /name: EXPORT_BIND_HOST\s+value: 127\.0\.0\.1/);
  assert.match(aca, /name: EXPORT_PORT\s+value: "3001"/);
  assert.match(aca, /name: EXPORT_ALLOW_RAW\s+value: "0"/);
  assert.match(aca, /name: TAJRIBA_CONFIG\s+value: \/run\/secrets\/empirica\.toml/);
  assert.match(aca, /name: EXPORT_AUTH_USERNAME\s+secretRef: export-auth-username/);
  assert.match(aca, /name: EXPORT_AUTH_PASSWORD\s+secretRef: export-auth-password/);
  assert.doesNotMatch(aca, /targetPort: 3001|exposedPort: 3001/);
});

test("real Caddy proxies HTTP and WebSocket traffic with route-specific Authorization handling", {
  skip: process.env.CADDY_BIN ? false : "set CADDY_BIN to run the real proxy integration",
}, async () => {
  const caddyBin = process.env.CADDY_BIN;
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "delibra-caddy-test-"));
  const empiricaRequests = [];
  const exportRequests = [];
  let websocketRequest;
  const websocketSockets = new Set();
  let exportServer;
  let caddyProcess;

  const empiricaServer = http.createServer((req, res) => {
    empiricaRequests.push({ url: req.url, authorization: req.headers.authorization ?? null });
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ upstream: "empirica", path: req.url }));
  });
  empiricaServer.on("upgrade", (req, socket) => {
    websocketSockets.add(socket);
    socket.once("close", () => websocketSockets.delete(socket));
    websocketRequest = { url: req.url, authorization: req.headers.authorization ?? null };
    const accept = createHash("sha1")
      .update(`${req.headers["sec-websocket-key"]}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`)
      .digest("base64");
    socket.write(
      "HTTP/1.1 101 Switching Protocols\r\n" +
      "Upgrade: websocket\r\n" +
      "Connection: Upgrade\r\n" +
      `Sec-WebSocket-Accept: ${accept}\r\n\r\n`,
    );
  });

  const makeExportServer = () => http.createServer((req, res) => {
    exportRequests.push({ url: req.url, authorization: req.headers.authorization ?? null });
    if (req.headers.authorization !== EXPORT_AUTH) {
      res.writeHead(401, { "www-authenticate": 'Basic realm="export"' });
      res.end("unauthorized");
      return;
    }
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ upstream: "export", path: req.url }));
  });

  try {
    const empiricaPort = await listenRandom(empiricaServer);
    exportServer = makeExportServer();
    const exportPort = await listenRandom(exportServer);
    const gatewayPort = await reservePort();
    const testConfig = fs.readFileSync(CADDYFILE, "utf8")
      .replace(":8080", `:${gatewayPort}`)
      .replace("127.0.0.1:3000", `127.0.0.1:${empiricaPort}`)
      .replace("127.0.0.1:3001", `127.0.0.1:${exportPort}`);
    const testConfigPath = path.join(tmpDir, "Caddyfile");
    fs.writeFileSync(testConfigPath, testConfig, "utf8");

    caddyProcess = spawn(caddyBin, ["run", "--config", testConfigPath, "--adapter", "caddyfile"], {
      env: { ...process.env, XDG_CONFIG_HOME: tmpDir, XDG_DATA_HOME: tmpDir },
      stdio: ["ignore", "pipe", "pipe"],
    });
    const caddyLogs = [];
    caddyProcess.stdout.on("data", (chunk) => caddyLogs.push(chunk));
    caddyProcess.stderr.on("data", (chunk) => caddyLogs.push(chunk));
    await waitForHttp(`http://127.0.0.1:${gatewayPort}/` , caddyProcess, caddyLogs);

    for (const requestPath of ["/", "/admin/"]) {
      const response = await fetch(`http://127.0.0.1:${gatewayPort}${requestPath}`, {
        headers: { authorization: EXPORT_AUTH },
      });
      const body = await response.text();
      assert.equal(
        response.status,
        200,
        `unexpected response for ${requestPath}: ${body}\n${Buffer.concat(caddyLogs).toString("utf8")}`,
      );
      assert.deepEqual(JSON.parse(body), { upstream: "empirica", path: requestPath });
    }
    assert.deepEqual(empiricaRequests.map((request) => request.authorization), [null, null, null]);

    const noAuth = await fetch(`http://127.0.0.1:${gatewayPort}/exports/`);
    assert.equal(noAuth.status, 401);
    const withAuth = await fetch(`http://127.0.0.1:${gatewayPort}/exports/`, {
      headers: { authorization: EXPORT_AUTH },
    });
    assert.equal(withAuth.status, 200);
    assert.deepEqual(await withAuth.json(), { upstream: "export", path: "/exports/" });
    const download = await fetch(`http://127.0.0.1:${gatewayPort}/exports/games/GAME1/bundle.zip`, {
      headers: { authorization: EXPORT_AUTH },
    });
    assert.equal(download.status, 200);
    assert.deepEqual(await download.json(), {
      upstream: "export",
      path: "/exports/games/GAME1/bundle.zip",
    });
    assert.equal(exportRequests.at(-1).authorization, EXPORT_AUTH);

    const websocketStatus = await websocketHandshake(gatewayPort, "/query", EXPORT_AUTH);
    assert.match(websocketStatus, /^HTTP\/1\.1 101 /);
    assert.deepEqual(websocketRequest, { url: "/query", authorization: null });

    await closeServer(exportServer);
    exportServer = null;
    const participantStillWorks = await fetch(`http://127.0.0.1:${gatewayPort}/`);
    assert.equal(participantStillWorks.status, 200);
    const failedExport = await fetch(`http://127.0.0.1:${gatewayPort}/exports/`, {
      headers: { authorization: EXPORT_AUTH },
    });
    assert.equal(failedExport.status, 502);
  } finally {
    if (caddyProcess && caddyProcess.exitCode === null && caddyProcess.signalCode === null) {
      const exited = new Promise((resolve) => caddyProcess.once("exit", resolve));
      caddyProcess.kill("SIGTERM");
      await exited;
    }
    if (exportServer) await closeServer(exportServer);
    for (const socket of websocketSockets) socket.destroy();
    await closeServer(empiricaServer);
  }
});

function listenRandom(server) {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve(server.address().port));
  });
}

async function reservePort() {
  const server = net.createServer();
  const port = await listenRandom(server);
  await closeServer(server);
  return port;
}

function closeServer(server) {
  if (!server.listening) return Promise.resolve();
  return new Promise((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
    server.closeAllConnections?.();
  });
}

async function waitForHttp(url, processHandle, logs) {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    if (processHandle.exitCode !== null) {
      throw new Error(`Caddy exited early (${processHandle.exitCode}): ${Buffer.concat(logs).toString("utf8")}`);
    }
    try {
      const response = await fetch(url);
      await response.arrayBuffer();
      return;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }
  throw new Error(`Caddy did not become ready: ${Buffer.concat(logs).toString("utf8")}`);
}

function websocketHandshake(port, requestPath, authorization) {
  return new Promise((resolve, reject) => {
    const socket = net.connect(port, "127.0.0.1");
    let response = "";
    socket.setTimeout(5_000, () => socket.destroy(new Error("WebSocket handshake timed out")));
    socket.once("error", reject);
    socket.once("connect", () => {
      socket.write(
        `GET ${requestPath} HTTP/1.1\r\n` +
        `Host: 127.0.0.1:${port}\r\n` +
        "Connection: Upgrade\r\n" +
        "Upgrade: websocket\r\n" +
        "Sec-WebSocket-Version: 13\r\n" +
        "Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n" +
        `Authorization: ${authorization}\r\n\r\n`,
      );
    });
    socket.on("data", (chunk) => {
      response += chunk.toString("utf8");
      if (response.includes("\r\n\r\n")) {
        socket.destroy();
        resolve(response.split("\r\n", 1)[0]);
      }
    });
  });
}
