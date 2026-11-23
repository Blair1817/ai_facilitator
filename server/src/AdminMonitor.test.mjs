import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { createAdminMonitor } from "./AdminMonitor.mjs";
import { createMonitorHandler, readEmpiricaAdminUsers } from "./AdminMonitorServer.mjs";

function store(data = {}, id = "scope") { return { id, get: k => data[k], set: (k, v) => { data[k] = v; }, data }; }
function world(stageName = "Preparation") {
  const game = store({ treatmentName: "main", sequenceId: "S1", chat_round_0: [
    { messageId: "m1", sender: { id: "p0", name: "Green", hexCode: "00aa00" }, speakerType: "human", text: "email me at a@b.com", timestamp: 1 },
    { messageId: "m2", sender: { id: "ai", name: "Facilitator" }, speakerType: "facilitator", text: "Let us begin", timestamp: 2 },
  ] }, "g1");
  const round = store({ taskIndex: 0 }, "r1");
  const stage = store({ name: stageName, duration: 600 }, "s1"); stage.round = round; stage.currentGame = game;
  const players = Array.from({ length: 3 }, (_, i) => ({
    ...store({ participantID: `part${i}`, name: ["Green", "Blue", "Red"][i], prolificPID: `pid${i}`, prolificStudyID: "st", prolificSessionID: `ses${i}` }, `p${i}`),
    round: store({ [`personalProgress_${stageName}`]: { index: 0, startedAt: 1 } }, `pr${i}`), stage: store(), currentGame: game,
  }));
  game.players = players; game.currentRound = round; game.currentStage = stage;
  const flushes = [];
  const monitor = createAdminMonitor({ now: () => 1000 });
  monitor.register({ on: () => {}, flush: () => flushes.push(1) });
  monitor.trackGame(game);
  return { game, round, stage, players, monitor, flushes };
}
function req(w, fields) { return { requestId: crypto.randomUUID(), stageId: w.stage.id, stageVersion: w.stage.get("testControlVersion") || 0, ...fields }; }

test("snapshot lists running games and shows personal progress", () => {
  const w = world();
  assert.deepEqual(w.monitor.listGames().map(g => [g.id, g.status, g.stage]), [["g1", "running", "Preparation"]]);
  const snap = w.monitor.snapshotGame("g1", { role: "viewer" });
  assert.equal(snap.players[0].personal.current, "Task information");
  assert.equal(snap.players[0].rejoin, undefined, "viewers never see identifiers");
  assert.equal(snap.controls, undefined);
  const admin = w.monitor.snapshotGame("g1", { role: "admin" });
  assert.equal(admin.players[0].rejoin.query, "?PROLIFIC_PID=pid0&STUDY_ID=st&SESSION_ID=ses0");
  assert.equal(admin.chat.messages.length, 2);
});

test("admin can move one participant forward and back without touching others", () => {
  const w = world(); const p = w.players[0];
  let r = w.monitor.control("g1", req(w, { action: "goto_page", playerId: "p0", index: 0, version: 0, targetIndex: 2 }));
  assert.equal(r.status, "accepted"); assert.equal(r.destination, "Initial decision");
  assert.equal(p.round.get("personalProgress_Preparation").index, 2);
  assert.equal(w.players[1].round.get("personalProgress_Preparation").index, 0);
  p.round.set("reviewQuizPassed", true); p.round.set("initialDecision", { choice: "kept" });
  r = w.monitor.control("g1", req(w, { action: "goto_page", playerId: "p0", index: 2, version: 1, targetIndex: 1 }));
  assert.equal(r.status, "accepted");
  assert.equal(p.round.get("reviewQuizPassed"), null, "completion marker cleared on return");
  assert.equal(p.round.get("initialDecision").choice, "kept", "saved answers stay");
  assert.ok(w.flushes.length >= 2);
});

test("stale, duplicate and unknown requests are rejected or replayed", () => {
  const w = world();
  const q = req(w, { action: "goto_page", playerId: "p0", index: 0, version: 0, targetIndex: 1 });
  assert.equal(w.monitor.control("g1", q).status, "accepted");
  assert.equal(w.monitor.control("g1", q).status, "accepted", "same requestId replays receipt");
  assert.equal(w.players[0].round.get("personalProgress_Preparation").index, 1);
  assert.equal(w.monitor.control("g1", { ...q, requestId: "x2" }).reason, "stale_progress");
  assert.equal(w.monitor.control("g1", req(w, { action: "end_stage", stageId: "old" })).reason, "stale_stage");
  assert.equal(w.monitor.control("g1", req(w, { action: "delete_everything" })).reason, "unknown_action");
  assert.equal(w.monitor.control("nope", req(w, { action: "end_stage" })).reason, "game_not_found");
});

test("end stage marks the stage as admin-ended and ends it like a timeout", () => {
  const w = world("FinalDecision");
  const r = w.monitor.control("g1", req(w, { action: "end_stage" }));
  assert.equal(r.status, "accepted"); assert.equal(r.destination, "Round 1 · Individual assessment");
  assert.equal(w.stage.get("ended"), true); assert.equal(w.stage.get("adminEndedAt"), 1000);
  assert.equal(w.stage.get("testSkippedAt"), undefined, "normal timeout finalisation still runs");
  assert.equal(w.round.get("finalDecisionOutcome"), undefined);
  const log = w.monitor.snapshotGame("g1", { role: "admin" }).controls;
  assert.equal(log.at(-1).action, "end_stage");
});

test("skipping forward past an unfinished shared break is refused", () => {
  const w = world("Followup"); w.round.set("decisionFlowVersion", 2);
  // v2 follow-up pages: TLX, SubjectiveSurvey, Break
  const r = w.monitor.control("g1", req(w, { action: "goto_page", playerId: "p0", index: 0, version: 0, targetIndex: 3 }));
  assert.equal(r.reason, "use_shared_break_control");
});

test("empirica.toml admin users are parsed", () => {
  const toml = `name = "GRAIL"\n[tajriba.auth]\nsrtoken = "x"\n\n[[tajriba.auth.users]]\nname = "Admin"\nusername = "admin"\npassword = "p\\"w"\n\n[[tajriba.auth.users]]\nusername = "ra"\npassword = "two"\n[other]\nusername = "ignored"\n`;
  assert.deepEqual(readEmpiricaAdminUsers(toml), [{ username: "admin", password: 'p"w' }, { username: "ra", password: "two" }]);
  assert.deepEqual(readEmpiricaAdminUsers(null), []);
});

async function withServer(w, fn) {
  const handler = createMonitorHandler({ monitor: w.monitor, basePath: "/exports", viewer: { username: "exp", password: "ev" },
    adminUsers: [{ username: "admin", password: "ap" }], auditFile: path.join(os.tmpdir(), `monitor-audit-${process.pid}.jsonl`) });
  const server = http.createServer(async (rq, rs) => { if (!(await handler(rq, rs))) { rs.writeHead(404); rs.end(); } });
  await new Promise(r => server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${server.address().port}/exports/monitor`;
  try { await fn(base); } finally { server.close(); }
}
const auth = (u, p) => ({ authorization: "Basic " + Buffer.from(`${u}:${p}`).toString("base64") });

test("viewer can read redacted data but cannot control; admin can", async () => {
  const w = world();
  await withServer(w, async base => {
    assert.equal((await fetch(`${base}/api/games`)).status, 401);
    assert.equal((await fetch(`${base}/api/games`, { headers: auth("exp", "wrong") })).status, 401);
    const viewer = await (await fetch(`${base}/api/games/g1`, { headers: auth("exp", "ev") })).json();
    assert.equal(viewer.role, "viewer");
    assert.ok(!viewer.chat.messages[0].text.includes("a@b.com"), "viewer chat is redacted");
    const body = JSON.stringify(req(w, { action: "end_stage" }));
    const json = { "content-type": "application/json", "x-monitor-request": "1" };
    assert.equal((await fetch(`${base}/api/games/g1/control`, { method: "POST", headers: { ...auth("exp", "ev"), ...json }, body })).status, 403);
    assert.equal((await fetch(`${base}/api/games/g1/control`, { method: "POST", headers: { ...auth("admin", "ap"), "content-type": "application/json" }, body })).status, 400, "csrf header required");
    assert.equal(w.stage.get("ended"), undefined);
    const ok = await fetch(`${base}/api/games/g1/control`, { method: "POST", headers: { ...auth("admin", "ap"), ...json }, body });
    assert.equal(ok.status, 200); assert.equal(w.stage.get("ended"), true);
    const page = await fetch(base, { headers: auth("admin", "ap") });
    assert.equal(page.status, 200); assert.match(await page.text(), /Delibra live monitor/);
  });
});

test("placeholder stage durations are hidden and page time is reported", () => {
  const w = world(); w.stage.set("duration", 1000000000);
  const snap = w.monitor.snapshotGame("g1", { role: "admin" });
  assert.equal(snap.stageInfo.durationSeconds, null);
  assert.equal(snap.players[0].personal.pageStartedAt, 1);
  assert.equal(snap.players[0].personal.currentId, "TaskInformation");
  w.stage.set("duration", 900);
  assert.equal(w.monitor.snapshotGame("g1").stageInfo.durationSeconds, 900);
});

test("admin interventions are flagged in transcript, questionnaire and HTML exports", async () => {
  const { adminInterventionsForRound, describeAdminIntervention, renderQuestionnaireCsv } = await import("./ExportService.mjs");
  const events = [
    { status: "accepted", action: "end_stage", stageName: "FinalDecision", roundId: "r1", timestamp: 1700000000000, actor: "admin" },
    { status: "accepted", action: "goto_page", stageName: "Preparation", roundId: "r1", playerId: "p1", targetIndex: 3, destination: "Finished", timestamp: 1700000000001 },
    { status: "accepted", action: "goto_page", stageName: "Preparation", roundId: "r1", playerId: "p2", targetIndex: 0, timestamp: 1700000000002 },
  ];
  const game = { id: "g", adminControlEvents: events };
  assert.equal(adminInterventionsForRound(game, "r1").length, 3);
  assert.deepEqual(adminInterventionsForRound(game, "r1", "p1").map(e => e.action), ["end_stage", "goto_page"]);
  assert.match(describeAdminIntervention(events[0]), /ended stage `FinalDecision` early/);
  const bundle = { game, players: [{ id: "p1", name: "Green" }], rounds: [{ id: "r1", taskIndex: 0, perPlayer: { p1: {} } }] };
  const { csv, columns } = renderQuestionnaireCsv(bundle);
  assert.equal(columns.at(-1), "admin_interventions");
  assert.match(csv, /end_stage:FinalDecision@1700000000000;goto_page:Preparation->3@1700000000001/);
});
