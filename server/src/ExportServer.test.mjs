import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { ExportService } from "./ExportService.mjs";
import {
  createExportServer,
  listenExportServer,
  readExportServerConfig,
} from "./ExportServer.mjs";

const AUTH_USERNAME = "researcher";
const AUTH_PASSWORD = "correct horse battery staple";
const AUTHORIZATION = `Basic ${Buffer.from(`${AUTH_USERNAME}:${AUTH_PASSWORD}`, "utf8").toString("base64")}`;

// ── Shared fixture (mirrors ExportService.test.mjs but local) ──────────

function attr(scope, key, value) {
  scope.attributes.push({ key, value: typeof value === "string" ? value : JSON.stringify(value) });
  return scope;
}
function makeScope(id, kind, builder = () => {}) {
  const scope = { id, kind, attributes: [] };
  builder(scope);
  return scope;
}
const T = (v) => JSON.stringify(v);
function fixture() {
  const batch = makeScope("BATCH1", "batch", (s) => {
    attr(s, "status", "ended");
    attr(s, "treatment", { name: "main", gameDuration: 10, phase1Duration: 2 });
    attr(s, "createdAt", "2026-08-15T10:00:00+08:00");
  });
  const game = makeScope("GAME1", "game", (s) => {
    attr(s, "batchID", T("BATCH1"));
    attr(s, "status", "ended");
    attr(s, "treatment", { gameDuration: 10, phase1Duration: 2 });
    attr(s, "treatmentName", "main");
    attr(s, "sequenceId", "S2");
    attr(s, "startedAt", "2026-08-15T10:05:00+08:00");
    attr(s, "endedAt", "2026-08-15T10:45:00+08:00");
    attr(s, "totalInterventions", 2);
    attr(s, "llmLogIndex", []);
    attr(s, "chat_round_0", [
      { text: "I prefer option A.", sender: { id: "p1", name: "Red" }, ts: 1723705200000 },
    ]);
  });
  const player = makeScope("p1", "player", (s) => {
    attr(s, "gameID", T("GAME1"));
    attr(s, "name", "Red");
    attr(s, "introDone", true);
    attr(s, "ended", "debriefing");
    attr(s, "finalQuestions", {
      submissionId: "p1:1723705900000",
      firstTaskCarryover: "yes",
      firstTaskCarryoverDescription: "Email me at a@b.co.",
      facilitatorDifference: 4,
      preferredFacilitator: "second_task",
      submittedAt: 1723705900000,
    });
  });
  const round = makeScope("R0", "round", (s) => {
    attr(s, "gameID", T("GAME1"));
    attr(s, "index", 0);
    attr(s, "taskIndex", 0);
    attr(s, "taskVersion", "A");
    attr(s, "facilitation", "adaptive");
    attr(s, "tlxSurvey", { tlxMentalDemand: 5, tlxPhysicalDemand: 2, tlxTemporalDemand: 7, tlxPerformance: 4, tlxEffort: 6, tlxFrustration: 3, submittedAt: 1 });
    attr(s, "initialChoice", "A");
    attr(s, "reviewQuizPassed", true);
  });
  return [batch, game, player, round];
}

function makeMockAdmin(scopes) {
  const all = scopes;
  function applyOne(scopeList, filter) {
    if (!filter) return scopeList;
    let out = scopeList;
    if (Array.isArray(filter.kinds) && filter.kinds.length > 0) {
      out = out.filter((s) => filter.kinds.includes(s.kind));
    }
    if (Array.isArray(filter.ids) && filter.ids.length > 0) {
      out = out.filter((s) => filter.ids.includes(s.id));
    }
    if (Array.isArray(filter.kvs) && filter.kvs.length > 0) {
      out = out.filter((s) =>
        filter.kvs.every(({ key, val }) =>
          (s.attributes || []).some((a) => a.key === key && a.value === val),
        ),
      );
    }
    return out;
  }
  return {
    scopes: async ({ filter, first = 100, after = null } = {}) => {
      const filterList = Array.isArray(filter) ? filter : filter == null ? [] : [filter];
      let matched = all;
      for (const f of filterList) {
        matched = applyOne(matched, f);
      }
      const startIdx = after ? matched.findIndex((s) => s.id === after) + 1 : 0;
      const end = startIdx + first;
      const slice = matched.slice(startIdx, end);
      return {
        edges: slice.map((node) => ({ node, cursor: node.id })),
        pageInfo: {
          hasNextPage: end < matched.length,
          endCursor: slice.length > 0 ? slice[slice.length - 1].id : null,
        },
      };
    },
  };
}

async function startServer(service, auditFile, options = {}) {
  const server = createExportServer({
    service,
    auditFile,
    authUsername: AUTH_USERNAME,
    authPassword: AUTH_PASSWORD,
    ...options,
  });
  await listenExportServer(server, { port: 0, host: "127.0.0.1" });
  const { port } = server.address();
  return {
    server,
    base: `http://127.0.0.1:${port}`,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

function fetchText(url, headers = {}, { authenticate = true } = {}) {
  return new Promise((resolve, reject) => {
    const requestHeaders = authenticate ? { authorization: AUTHORIZATION, ...headers } : headers;
    http.get(url, { headers: requestHeaders }, (res) => {
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => {
        const buf = Buffer.concat(chunks);
        resolve({ status: res.statusCode, headers: res.headers, body: buf.toString("utf8"), buffer: buf });
      });
    }).on("error", reject);
  });
}

async function makeRunningServer(options = {}) {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "export-server-"));
  const auditFile = path.join(tmpDir, "audit.jsonl");
  const service = new ExportService({ admin: makeMockAdmin(fixture()) });
  const handle = await startServer(service, auditFile, options);
  return { ...handle, auditFile, tmpDir };
}

test("GET / renders a list page with batches, games, and download links", async () => {
  const srv = await makeRunningServer();
  try {
    const { status, body } = await fetchText(srv.base + "/");
    assert.equal(status, 200);
    assert.match(body, /<title>Delibra research export<\/title>/);
    assert.match(body, /BATCH1/);
    assert.match(body, /GAME1/);
    assert.match(body, /\/games\/GAME1\/questionnaire\.csv/);
    assert.match(body, /\/games\/GAME1\/transcript\.md/);
    assert.match(body, /\/games\/GAME1\/bundle\.zip/);
    assert.match(body, /redact/);
    assert.match(body, />main<\/td>/);
    assert.doesNotMatch(body, /\[object Object\]/);
    assert.match(body, /<option value="main"/);
    assert.doesNotMatch(body, /<option value="static"/);
    assert.doesNotMatch(body, /<option value="adaptive"/);
    // audit line recorded
    const audit = fs.readFileSync(srv.auditFile, "utf8").trim().split("\n");
    assert.equal(audit.length, 1);
    const rec = JSON.parse(audit[0]);
    assert.equal(rec.endpoint, "list-batches");
    assert.equal(rec.requester, AUTH_USERNAME);
    assert.equal(rec.format, "html");
  } finally {
    await srv.close();
  }
});

test("GET /batches/:batchId/games returns a JSON list with game-level treatment filtering", async () => {
  const srv = await makeRunningServer();
  try {
    const { status, body } = await fetchText(srv.base + "/batches/BATCH1/games?treatment=main&limit=5&offset=0");
    assert.equal(status, 200);
    const parsed = JSON.parse(body);
    assert.equal(parsed.total, 1);
    assert.equal(parsed.items[0].id, "GAME1");
    assert.equal(parsed.items[0].treatment, "main");
    assert.equal(parsed.limit, 5);
    assert.equal(parsed.offset, 0);
  } finally {
    await srv.close();
  }
});

test("GET /games/:id/questionnaire.csv streams CSV with ETag and audit entry", async () => {
  const srv = await makeRunningServer();
  try {
    const { status, headers, body } = await fetchText(srv.base + "/games/GAME1/questionnaire.csv");
    assert.equal(status, 200);
    assert.match(headers["content-type"], /text\/csv/);
    assert.match(headers["content-disposition"], /attachment/);
    assert.ok(headers["etag"], "etag is set from sha256");
    // ETag must be a quoted sha256
    assert.match(headers["etag"], /^"[a-f0-9]{64}"$/);
    // The CSV must include Red's TLX row and the per-round form
    assert.match(body, /tlx_mental/);
    // Default redact: email replaced
    assert.match(body, /\[REDACTED_EMAIL\]/);
    // Audit recorded
    const audit = fs.readFileSync(srv.auditFile, "utf8").trim().split("\n");
    const csv = audit.map((l) => JSON.parse(l)).find((r) => r.endpoint === "questionnaire.csv");
    assert.ok(csv, "questionnaire.csv audit entry present");
    assert.equal(csv.format, "csv");
    assert.equal(csv.redact, true);
    assert.equal(csv.sizeBytes, Buffer.byteLength(body, "utf8"));
  } finally {
    await srv.close();
  }
});

test("GET /games/:id/questionnaire.csv?raw=1 keeps the raw text only when raw is enabled", async () => {
  const srv = await makeRunningServer({ allowRaw: true });
  try {
    const { status, body } = await fetchText(srv.base + "/games/GAME1/questionnaire.csv?raw=1");
    assert.equal(status, 200);
    assert.ok(body.includes("a@b.co"), "raw text retained");
    const audit = fs.readFileSync(srv.auditFile, "utf8").trim().split("\n");
    const csv = audit.map((l) => JSON.parse(l)).find((r) => r.endpoint === "questionnaire.csv");
    assert.equal(csv.redact, false);
  } finally {
    await srv.close();
  }
});

test("raw export is disabled by default and truthy raw forms receive 403", async () => {
  const srv = await makeRunningServer();
  try {
    for (const raw of ["1", "true", "TRUE", "yes", "on"]) {
      const { status } = await fetchText(`${srv.base}/games/GAME1/questionnaire.csv?raw=${raw}`);
      assert.equal(status, 403);
    }
    const { status, body } = await fetchText(srv.base + "/games/GAME1/questionnaire.csv");
    assert.equal(status, 200);
    assert.match(body, /\[REDACTED_EMAIL\]/);
    assert.doesNotMatch(body, /a@b\.co/);
  } finally {
    await srv.close();
  }
});

test("GET /games/:id/transcript.md streams Markdown with chat", async () => {
  const srv = await makeRunningServer();
  try {
    const { status, headers, body } = await fetchText(srv.base + "/games/GAME1/transcript.md");
    assert.equal(status, 200);
    assert.match(headers["content-type"], /text\/markdown/);
    assert.match(body, /# Game GAME1/);
    assert.match(body, /Red.*I prefer option A/);
  } finally {
    await srv.close();
  }
});

test("GET /games/:id/bundle.zip streams a ZIP and records size + sha256", async () => {
  const srv = await makeRunningServer();
  try {
    const { status, headers, buffer } = await fetchText(srv.base + "/games/GAME1/bundle.zip");
    assert.equal(status, 200);
    assert.match(headers["content-type"], /application\/zip/);
    // ZIP magic header
    assert.equal(buffer.slice(0, 4).toString("binary"), "PK\u0003\u0004");
    const audit = fs.readFileSync(srv.auditFile, "utf8").trim().split("\n");
    const rec = audit.map((l) => JSON.parse(l)).find((r) => r.endpoint === "bundle.zip");
    assert.ok(rec);
    assert.equal(rec.format, "zip");
    assert.ok(rec.sha256 && rec.sha256.length === 64);
    assert.equal(rec.sizeBytes, buffer.length);
  } finally {
    await srv.close();
  }
});

test("GET /games/:id for an unknown game returns 404 with ExportNotFoundError in the audit", async () => {
  const srv = await makeRunningServer();
  try {
    const { status, body } = await fetchText(srv.base + "/games/NOPE");
    assert.equal(status, 404);
    assert.match(body, /not found|NOPE/i);
  } finally {
    await srv.close();
  }
});

test("POST / is rejected with 405", async () => {
  const srv = await makeRunningServer();
  try {
    const res = await new Promise((resolve, reject) => {
      const req = http.request(
        {
          host: "127.0.0.1",
          port: new URL(srv.base).port,
          path: "/",
          method: "POST",
          headers: { authorization: AUTHORIZATION },
        },
        (r) => r.on("data", () => {}).on("end", () => resolve(r)),
      );
      req.on("error", reject);
      req.end();
    });
    assert.equal(res.statusCode, 405);
  } finally {
    await srv.close();
  }
});

test("authenticated HEAD preserves headers and omits the download body", async () => {
  const srv = await makeRunningServer({ basePath: "/exports" });
  try {
    const res = await new Promise((resolve, reject) => {
      const req = http.request(
        {
          host: "127.0.0.1",
          port: new URL(srv.base).port,
          path: "/exports/games/GAME1/questionnaire.csv",
          method: "HEAD",
          headers: { authorization: AUTHORIZATION },
        },
        (response) => {
          const chunks = [];
          response.on("data", (chunk) => chunks.push(chunk));
          response.on("end", () => resolve({ response, body: Buffer.concat(chunks) }));
        },
      );
      req.on("error", reject);
      req.end();
    });
    assert.equal(res.response.statusCode, 200);
    assert.match(res.response.headers["content-type"], /text\/csv/);
    assert.equal(res.body.length, 0);
  } finally {
    await srv.close();
  }
});

test("audit log records source IP from CF-Connecting-IP when present", async () => {
  const srv = await makeRunningServer();
  try {
    await fetchText(srv.base + "/batches", { "cf-connecting-ip": "203.0.113.42" });
    const audit = fs.readFileSync(srv.auditFile, "utf8").trim().split("\n");
    const rec = JSON.parse(audit[0]);
    assert.equal(rec.sourceIp, "203.0.113.42");
  } finally {
    await srv.close();
  }
});

test("Basic Auth rejects absent and invalid credentials and accepts correct credentials", async () => {
  const srv = await makeRunningServer();
  try {
    const absent = await fetchText(srv.base + "/", {}, { authenticate: false });
    assert.equal(absent.status, 401);
    assert.match(absent.headers["www-authenticate"], /^Basic /);

    const wrong = await fetchText(
      srv.base + "/",
      { authorization: `Basic ${Buffer.from("researcher:wrong").toString("base64")}` },
      { authenticate: false },
    );
    assert.equal(wrong.status, 401);

    const correct = await fetchText(srv.base + "/");
    assert.equal(correct.status, 200);
  } finally {
    await srv.close();
  }
});

test("missing Basic Auth server configuration fails closed", () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "export-server-auth-"));
  const service = new ExportService({ admin: makeMockAdmin(fixture()) });
  assert.throws(
    () => createExportServer({ service, auditFile: path.join(tmpDir, "audit.jsonl") }),
    /Basic Auth credentials are required/,
  );
});

test("audit records only authenticated username and never credentials or proxy JWT fragments", async () => {
  const srv = await makeRunningServer();
  const fakeJwt = "secret.jwt.fragment-that-must-not-be-persisted";
  try {
    const { status } = await fetchText(srv.base + "/batches", {
      "cf-access-authenticated-user-email": "spoofed@example.com",
      "cf-access-jwt-assertion": fakeJwt,
    });
    assert.equal(status, 200);
    const auditText = fs.readFileSync(srv.auditFile, "utf8");
    const rec = JSON.parse(auditText.trim());
    assert.equal(rec.requester, AUTH_USERNAME);
    assert.doesNotMatch(auditText, new RegExp(AUTH_PASSWORD.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
    assert.doesNotMatch(auditText, /Authorization|Basic|secret\.jwt|spoofed@example\.com/i);
  } finally {
    await srv.close();
  }
});

test("configured /exports base path contains all HTML navigation and download routes", async () => {
  const srv = await makeRunningServer({ basePath: "/exports" });
  try {
    const redirect = await fetchText(srv.base + "/exports");
    assert.equal(redirect.status, 308);
    assert.equal(redirect.headers.location, "/exports/");

    const { status, body } = await fetchText(srv.base + "/exports/");
    assert.equal(status, 200);
    assert.match(body, /action="\/exports\/"/);
    assert.match(body, /href="\/exports\/" class="reset"/);
    assert.match(body, /\/exports\/games\/GAME1\/questionnaire\.csv/);
    assert.match(body, /\/exports\/games\/GAME1\/transcript\.md/);
    assert.match(body, /\/exports\/games\/GAME1\/bundle\.zip/);
    assert.doesNotMatch(body, /(?:href|action)="\/(?:games|batches)(?:\/|\")/);

    assert.equal((await fetchText(srv.base + "/exports/batches")).status, 200);
    assert.equal((await fetchText(srv.base + "/exports/batches/BATCH1/games")).status, 200);
    assert.equal((await fetchText(srv.base + "/exports/games/GAME1")).status, 200);
    assert.equal((await fetchText(srv.base + "/exports/games/GAME1/questionnaire.csv")).status, 200);
    assert.equal((await fetchText(srv.base + "/exports/games/GAME1/transcript.md")).status, 200);
    assert.equal((await fetchText(srv.base + "/exports/games/GAME1/bundle.zip")).status, 200);
    assert.equal((await fetchText(srv.base + "/")).status, 404);
    assert.equal((await fetchText(srv.base + "/batches")).status, 404);
    assert.equal((await fetchText(srv.base + "/games/GAME1/questionnaire.csv")).status, 404);
  } finally {
    await srv.close();
  }
});

test("researcher page does not advertise raw bypass when raw is disabled", async () => {
  const srv = await makeRunningServer();
  try {
    const { body } = await fetchText(srv.base + "/");
    assert.doesNotMatch(body, /\?raw=1|opt out/i);
  } finally {
    await srv.close();
  }
});

test("listen helper respects bind-host configuration", async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "export-server-bind-"));
  const server = createExportServer({
    service: new ExportService({ admin: makeMockAdmin(fixture()) }),
    auditFile: path.join(tmpDir, "audit.jsonl"),
    authUsername: AUTH_USERNAME,
    authPassword: AUTH_PASSWORD,
  });
  try {
    const address = await listenExportServer(server, { port: 0, host: "127.0.0.1" });
    assert.equal(address.address, "127.0.0.1");
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test("runtime configuration defaults securely and preserves Tajriba overrides", () => {
  const config = readExportServerConfig({
    EXPORT_AUTH_USERNAME: AUTH_USERNAME,
    EXPORT_AUTH_PASSWORD: AUTH_PASSWORD,
    TAJRIBA_CONFIG: "/tmp/local-empirica.toml",
    TAJRIBA_SRTOKEN: "local-token",
    TAJRIBA_URL: "http://127.0.0.1:3999/query",
  });
  assert.equal(config.host, "127.0.0.1");
  assert.equal(config.port, 3001);
  assert.equal(config.basePath, "/exports");
  assert.equal(config.allowRaw, false);
  assert.equal(config.tajribaConfig, "/tmp/local-empirica.toml");
  assert.equal(config.tajribaSrToken, "local-token");
  assert.equal(config.tajribaUrl, "http://127.0.0.1:3999/query");

  const overridden = readExportServerConfig({
    EXPORT_AUTH_USERNAME: AUTH_USERNAME,
    EXPORT_AUTH_PASSWORD: AUTH_PASSWORD,
    EXPORT_BIND_HOST: "127.0.0.2",
    EXPORT_PORT: "3011",
    EXPORT_BASE_PATH: "research-exports/",
    EXPORT_ALLOW_RAW: "1",
  });
  assert.equal(overridden.host, "127.0.0.2");
  assert.equal(overridden.port, 3011);
  assert.equal(overridden.basePath, "/research-exports");
  assert.equal(overridden.allowRaw, true);
  assert.equal(overridden.tajribaConfig, undefined);
});
