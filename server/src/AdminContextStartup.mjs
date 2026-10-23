import net from "node:net";

const DEFAULT_ATTEMPTS = 60;
const DEFAULT_DELAY_MS = 500;
const DEFAULT_CONNECT_TIMEOUT_MS = 500;

export function parseAdminEndpoint(value) {
  const url = new URL(value);
  if (!["http:", "https:", "ws:", "wss:"].includes(url.protocol)) {
    throw new Error(`unsupported AdminContext URL protocol: ${url.protocol}`);
  }
  const secure = url.protocol === "https:" || url.protocol === "wss:";
  return {
    host: url.hostname,
    port: url.port ? Number(url.port) : secure ? 443 : 80,
  };
}

export function canConnectToEndpoint(host, port, timeoutMs = DEFAULT_CONNECT_TIMEOUT_MS) {
  return new Promise((resolve) => {
    const socket = net.createConnection({ host, port });
    let settled = false;
    const finish = (connected) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(connected);
    };
    socket.once("connect", () => finish(true));
    socket.once("error", () => finish(false));
    socket.setTimeout(timeoutMs, () => finish(false));
  });
}

export async function waitForAdminEndpoint(
  adminUrl,
  {
    attempts = DEFAULT_ATTEMPTS,
    delayMs = DEFAULT_DELAY_MS,
    connectTimeoutMs = DEFAULT_CONNECT_TIMEOUT_MS,
    connect = canConnectToEndpoint,
    wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    onRetry = () => {},
  } = {},
) {
  if (!Number.isInteger(attempts) || attempts < 1) {
    throw new RangeError("attempts must be a positive integer");
  }

  const endpoint = parseAdminEndpoint(adminUrl);
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    if (await connect(endpoint.host, endpoint.port, connectTimeoutMs)) return endpoint;
    if (attempt === attempts) break;
    onRetry({ attempt, attempts, delayMs, endpoint });
    await wait(delayMs);
  }

  throw new Error(
    `AdminContext endpoint ${endpoint.host}:${endpoint.port} did not become reachable ` +
    `after ${attempts} attempts`,
  );
}
