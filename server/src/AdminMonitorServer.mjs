/**
 * AdminMonitorServer.mjs
 *
 * HTTP surface for the live researcher monitor, mounted on the export
 * server under `<basePath>/monitor`. Requests are dispatched here before
 * the export server's single-download lock so polling never competes with
 * a running export.
 *
 * Roles (HTTP Basic):
 *   - admin:  any user in empirica.toml `[[tajriba.auth.users]]` (the same
 *             accounts as Empirica /admin). Can view raw chat, see rejoin
 *             links and POST controls.
 *   - viewer: the export account (EXPORT_AUTH_USERNAME/PASSWORD). Read-only;
 *             chat is redacted the same way as exports.
 *
 * Routes:
 *   GET  <base>/monitor                         HTML console
 *   GET  <base>/monitor/api/me                  { role }
 *   GET  <base>/monitor/api/games[?all=1]       game list
 *   GET  <base>/monitor/api/games/:id           live game snapshot
 *   POST <base>/monitor/api/games/:id/control   admin only; JSON body
 *
 * POST requires `content-type: application/json` and the header
 * `x-monitor-request: 1`, which browsers cannot send cross-site without a
 * CORS preflight (this server answers none), so Basic credentials cached
 * by the browser cannot be replayed by another site.
 */

import { createHash, timingSafeEqual } from "node:crypto";

import { recordExportEvent } from "./ExportAudit.mjs";

const MAX_BODY_BYTES = 8 * 1024;

export function readEmpiricaAdminUsers(tomlText) {
  if (typeof tomlText !== "string") return [];
  const users = [];
  const blocks = tomlText.split(/^\s*\[\[tajriba\.auth\.users\]\]\s*$/m).slice(1);
  for (const block of blocks) {
    const section = block.split(/^\s*\[/m)[0];
    const field = name => {
      const m = new RegExp(`^\\s*${name}\\s*=\\s*"((?:[^"\\\\]|\\\\.)*)"\\s*$`, "m").exec(section);
      return m ? m[1].replace(/\\(["\\])/g, "$1") : null;
    };
    const username = field("username"), password = field("password");
    if (username && password) users.push({ username, password });
  }
  return users;
}

export function createMonitorHandler({
  monitor,
  basePath = "/",
  viewer,
  adminUsers = [],
  auditFile,
  participantUrl = null,
}) {
  if (!monitor) throw new Error("createMonitorHandler: monitor is required");
  const root = basePath === "/" ? "/monitor" : `${basePath}/monitor`;

  function authenticate(req) {
    const creds = parseBasic(req.headers.authorization);
    if (!creds) return null;
    // Evaluate every candidate so timing does not reveal which list matched.
    let role = null, username = null;
    for (const user of adminUsers) {
      if (safeEqual(creds.username, user.username) & safeEqual(creds.password, user.password)) {
        role ??= "admin"; username ??= user.username;
      }
    }
    if (!role && viewer && safeEqual(creds.username, viewer.username) & safeEqual(creds.password, viewer.password)) {
      role = "viewer"; username = viewer.username;
    }
    return role ? { role, username } : null;
  }

  return async function handleMonitor(req, res) {
    const url = new URL(req.url, "http://localhost");
    if (url.pathname !== root && !url.pathname.startsWith(`${root}/`)) return false;
    const path = url.pathname.slice(root.length) || "/";
    const who = authenticate(req);
    if (!who) {
      send(res, 401, { error: "authentication required" }, { "www-authenticate": 'Basic realm="Delibra monitor", charset="UTF-8"' });
      return true;
    }
    const audit = record => auditFile ? recordExportEvent({ auditFile, record: {
      requester: who.username, role: who.role, sourceIp: sourceIp(req), userAgent: req.headers["user-agent"] || "unknown", ...record,
    } }).catch(() => {}) : Promise.resolve();

    if (req.method === "GET" && (path === "/" || path === "")) {
      await audit({ endpoint: "monitor", format: "html" });
      res.writeHead(200, {
        "content-type": "text/html; charset=utf-8",
        "cache-control": "no-store",
        "x-frame-options": "DENY",
        "content-security-policy": "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; img-src 'self' data:",
      });
      res.end(renderMonitorPage({ root, exportsRoot: basePath === "/" ? "" : basePath, role: who.role, participantUrl }));
      return true;
    }
    if (req.method === "GET" && path === "/api/me") {
      send(res, 200, { role: who.role, username: who.username });
      return true;
    }
    if (req.method === "GET" && path === "/api/games") {
      send(res, 200, { items: monitor.listGames({ includeEnded: url.searchParams.get("all") === "1" }), role: who.role });
      return true;
    }
    const detail = path.match(/^\/api\/games\/([^/]+)$/);
    if (req.method === "GET" && detail) {
      const snapshot = monitor.snapshotGame(decodeURIComponent(detail[1]), { role: who.role });
      if (!snapshot) send(res, 404, { error: "game not found (or not loaded in this callbacks process)" });
      else send(res, 200, { ...snapshot, role: who.role });
      return true;
    }
    const control = path.match(/^\/api\/games\/([^/]+)\/control$/);
    if (control) {
      if (req.method !== "POST") { send(res, 405, { error: "method not allowed" }); return true; }
      if (who.role !== "admin") {
        await audit({ endpoint: "monitor-control", gameId: control[1], outcome: "forbidden" });
        send(res, 403, { error: "only Empirica admin accounts can control games" });
        return true;
      }
      if (req.headers["x-monitor-request"] !== "1" || !/^application\/json\b/i.test(req.headers["content-type"] || "")) {
        send(res, 400, { error: "missing monitor request headers" });
        return true;
      }
      let body;
      try {
        body = JSON.parse(await readBody(req));
      } catch {
        send(res, 400, { error: "invalid JSON body" });
        return true;
      }
      const gameId = decodeURIComponent(control[1]);
      const result = monitor.control(gameId, body, { actor: who.username });
      await audit({ endpoint: "monitor-control", gameId, action: body?.action, playerId: body?.playerId ?? null,
        targetIndex: body?.targetIndex ?? null, outcome: result.status, reason: result.reason });
      send(res, result.status === "accepted" ? 200 : 409, result);
      return true;
    }
    send(res, 404, { error: "not found" });
    return true;
  };
}

function parseBasic(header) {
  if (typeof header !== "string") return null;
  const m = /^Basic\s+([^\s]+)$/i.exec(header);
  if (!m) return null;
  const decoded = Buffer.from(m[1], "base64").toString("utf8");
  const i = decoded.indexOf(":");
  if (i < 0) return null;
  return { username: decoded.slice(0, i), password: decoded.slice(i + 1) };
}

function safeEqual(a, b) {
  const ah = createHash("sha256").update(String(a), "utf8").digest();
  const bh = createHash("sha256").update(String(b), "utf8").digest();
  return timingSafeEqual(ah, bh) ? 1 : 0;
}

function sourceIp(req) {
  const cf = req.headers["cf-connecting-ip"];
  if (typeof cf === "string" && cf) return cf;
  const xff = req.headers["x-forwarded-for"];
  if (typeof xff === "string" && xff) return xff.split(",")[0].trim();
  return req.socket?.remoteAddress || "unknown";
}

function send(res, status, payload, headers = {}) {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", ...headers });
  res.end(JSON.stringify(payload));
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on("data", chunk => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) { reject(new Error("body too large")); req.destroy(); return; }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

function renderMonitorPage({ root, exportsRoot, role, participantUrl }) {
  const config = JSON.stringify({ root, exportsRoot, role, participantUrl }).replace(/</g, "\\u003c");
  return `<!doctype html>
<html lang="en-GB"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Delibra live monitor</title>
<style>
  :root { --bg:#f6f7f9; --card:#fff; --line:#e3e6ea; --muted:#6b7280; --ok:#16a34a; --bad:#dc2626; --warn:#d97706; --accent:#2563eb; }
  * { box-sizing:border-box; }
  body { margin:0; font:14px/1.45 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; background:var(--bg); color:#111827; }
  header { display:flex; align-items:center; gap:12px; padding:10px 16px; background:#111827; color:#fff; }
  header a { color:#cbd5e1; font-size:12px; }
  header .role { margin-left:auto; font-size:12px; padding:2px 8px; border-radius:999px; background:#374151; }
  header .role.admin { background:#b45309; }
  #conn { font-size:12px; color:#fca5a5; }
  main { display:grid; grid-template-columns: 300px 1fr; gap:12px; padding:12px; height: calc(100vh - 44px); }
  .card { background:var(--card); border:1px solid var(--line); border-radius:10px; padding:12px; overflow:auto; }
  #games .g { padding:8px; border-radius:8px; cursor:pointer; border:1px solid transparent; }
  #games .g:hover { background:#f3f4f6; } #games .g.sel { border-color:var(--accent); background:#eff6ff; }
  .muted { color:var(--muted); font-size:12px; } .warntext { color:var(--warn); } .badtext { color:var(--bad); font-weight:600; }
  .pill { display:inline-block; font-size:11px; padding:1px 6px; border-radius:999px; background:#e5e7eb; margin-left:4px; }
  .pill.running { background:#dcfce7; } .pill.lobby { background:#fef3c7; } .pill.ended { background:#e5e7eb; } .pill.test { background:#fde68a; } .pill.alert { background:#fee2e2; color:#991b1b; }
  #detail { display:grid; grid-template-rows:auto auto 1fr; gap:12px; min-height:0; }
  #bottom { display:grid; grid-template-columns: 3fr 2fr; gap:12px; min-height:0; }
  table { width:100%; border-collapse:collapse; } td, th { text-align:left; padding:6px; border-bottom:1px solid var(--line); vertical-align:top; }
  tr.offline td { background:#fef2f2; }
  .dot { display:inline-block; width:9px; height:9px; border-radius:50%; margin-right:6px; background:var(--bad); } .dot.on { background:var(--ok); }
  .pages { display:flex; flex-wrap:wrap; gap:4px; }
  .page { font-size:12px; padding:2px 6px; border-radius:6px; border:1px solid var(--line); background:#fff; font-family:inherit; }
  .page.done { background:#f3f4f6; color:var(--muted); } .page.cur { border-color:var(--accent); background:#dbeafe; font-weight:600; }
  button.page { cursor:pointer; } button.page:hover { border-color:var(--warn); background:#fffbeb; }
  .btn { padding:6px 10px; border-radius:8px; border:1px solid var(--line); background:#fff; cursor:pointer; font-family:inherit; }
  .btn.danger { border-color:#fca5a5; color:#991b1b; } .btn:disabled { opacity:.4; cursor:not-allowed; } .btn.small { padding:3px 8px; font-size:12px; }
  #chat .m { padding:6px 0; border-bottom:1px dashed var(--line); } #chat .who { font-weight:600; }
  #chat .ai .who { color:#7c3aed; } #chat .sys .who { color:var(--muted); }
  #status { min-height:20px; margin-top:6px; } .err { color:var(--bad); } .okmsg { color:var(--ok); }
  code { font-size:12px; background:#f3f4f6; padding:1px 4px; border-radius:4px; word-break:break-all; }
  .timer { font-variant-numeric: tabular-nums; }
</style></head>
<body>
<header><strong>Delibra live monitor</strong><a id="exportsLink" href="#">Research exports ↗</a><span class="muted" id="clock"></span><span id="conn"></span><span class="role" id="role"></span></header>
<main>
  <section class="card"><label class="muted"><input type="checkbox" id="showEnded"> Show ended sessions</label><div id="games"></div></section>
  <section id="detail"><div class="card muted">← Select a session</div></section>
</main>
<script>
const CFG = ${config};
const ADMIN = CFG.role === "admin";
const $ = s => document.querySelector(s);
let selected = new URLSearchParams(location.hash.slice(1)).get("game");
let snapshot = null, lastKey = "", lastRenderAt = 0, busy = false, stickChat = true, statusHtml = "";
$("#role").textContent = ADMIN ? "Admin · can intervene" : "Read-only";
if (ADMIN) $("#role").classList.add("admin");
$("#exportsLink").href = (CFG.exportsRoot || "") + "/";
const esc = v => String(v ?? "").replace(/[&<>"']/g, c => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));
const STATUS = { running:"Running", lobby:"In lobby", ended:"Ended" };
const STAGES = { Preparation:"Preparation (individual pages)", Followup:"Follow-up questionnaires (individual pages)", Task:"Group discussion", Discussion:"Group discussion" };
const REASONS = { stale_stage:"The stage has changed. Check the latest state and try again.", stale_progress:"Progress has just changed (the participant moved on). Check the latest state and try again.",
  page_boundary:"That page is out of range.", use_shared_break_control:"You cannot skip past an unfinished shared break. Wait until all three have reached it, then use Skip shared break.",
  break_not_ready:"Not all three participants have reached the break yet.", player_not_found:"Participant not found.", game_not_found:"Session not found.",
  not_personal_page:"This stage has no individual pages.", unknown_action:"Unknown action.", invalid_request:"Invalid request." };
const ACTIONS = { goto_page:"Moved individual page", end_stage:"Ended stage", skip_break:"Skipped shared break" };
const stageLabel = s => s ? (STAGES[s.name] || s.label) : "-";
function dur(ms) { ms = Math.max(0, Math.round(ms / 1000)); const m = Math.floor(ms / 60), s = ms % 60; return m >= 60 ? Math.floor(m / 60) + " h " + (m % 60) + " min" : m + ":" + String(s).padStart(2, "0"); }
function ago(ts) { if (!ts) return ""; const s = Math.round((Date.now() - ts) / 1000); return s < 60 ? s + " s ago" : s < 3600 ? Math.round(s / 60) + " min ago" : Math.round(s / 3600) + " h ago"; }
function time(ts) { return ts ? new Date(ts).toLocaleTimeString("en-GB") : ""; }
async function api(path, opts) {
  const r = await fetch(CFG.root + path, { credentials: "same-origin", ...opts });
  const body = await r.json().catch(() => ({}));
  if (r.status === 401) throw new Error("Your login has expired. Refresh the page to sign in again.");
  if (!r.ok && r.status !== 409) throw new Error(body.error || r.statusText);
  return body;
}
async function copyText(text, button) {
  try {
    if (navigator.clipboard && window.isSecureContext) await navigator.clipboard.writeText(text);
    else { const t = document.createElement("textarea"); t.value = text; t.style.position = "fixed"; t.style.opacity = "0"; document.body.appendChild(t); t.select(); const ok = document.execCommand("copy"); t.remove(); if (!ok) throw new Error(); }
    button.textContent = "Copied ✓";
  } catch { window.prompt("Copy this:", text); }
}
async function loadGames() {
  const { items } = await api("/api/games" + ($("#showEnded").checked ? "?all=1" : ""));
  $("#games").innerHTML = items.length ? items.map(g => {
    const offline = g.status === "running" ? g.playerCount - g.onlineCount : 0;
    return \`<div class="g \${g.id === selected ? "sel" : ""}" data-id="\${esc(g.id)}">
      <div><code>\${esc(g.id.slice(-8))}</code><span class="pill \${esc(g.status)}">\${STATUS[g.status] || esc(g.status)}</span>\${g.testMode ? '<span class="pill test">Test</span>' : ""}\${offline > 0 ? \`<span class="pill alert">\${offline} offline</span>\` : ""}</div>
      <div class="muted">\${esc(g.treatment || "")} \${esc(g.sequenceId || "")} · \${esc(g.round || "-")} · \${esc(g.stage || "-")}</div>
      <div class="muted">Online \${g.onlineCount}/\${g.playerCount}</div></div>\`; }).join("") : '<p class="muted">No sessions in progress</p>';
  document.querySelectorAll("#games .g").forEach(el => el.onclick = () => { selected = el.dataset.id; location.hash = "game=" + encodeURIComponent(selected); stickChat = true; lastKey = ""; statusHtml = ""; refresh(); });
}
async function loadGame() {
  if (!selected) return;
  try {
    snapshot = await api("/api/games/" + encodeURIComponent(selected));
    const { serverTime, ...rest } = snapshot;
    const key = JSON.stringify(rest);
    const selecting = String(window.getSelection() || "").length > 0;
    // Re-render on change, or every 15 s for relative times, but never while the user is selecting text.
    if (!selecting && (key !== lastKey || Date.now() - lastRenderAt > 15000)) { lastKey = key; renderGame(); }
    else tickTimers();
  } catch (e) { $("#detail").innerHTML = '<div class="card err">' + esc(e.message) + "</div>"; lastKey = ""; }
}
function rejoinCell(p) {
  if (!ADMIN || !p.rejoin) return "";
  if (p.rejoin.query) {
    const link = (CFG.participantUrl || "") + "/" + p.rejoin.query;
    return \`<button class="btn small" data-copy="\${esc(link)}">Copy rejoin link</button>\${CFG.participantUrl ? "" : '<div class="muted">MONITOR_PARTICIPANT_URL is not set, so only the link parameters are copied.</div>'}\`;
  }
  if (p.rejoin.identifier) return \`<div class="muted">Ask them to reopen \${CFG.participantUrl ? esc(CFG.participantUrl) : "the study link"} in the same browser. On a different device, they enter this identifier:</div>
    <code>\${esc(p.rejoin.identifier)}</code> <button class="btn small" data-copy="\${esc(p.rejoin.identifier)}">Copy identifier</button>\`;
  return '<span class="muted">No rejoin details available</span>';
}
function pagesCell(p) {
  if (!p.personal || !p.personal.pages.length) return '<span class="muted">Whole group moves together in this stage</span>';
  const total = p.personal.pages.length;
  const chips = p.personal.pages.map((pg, i) => {
    const cls = "page " + (i < p.personal.index ? "done" : i === p.personal.index ? "cur" : "");
    return ADMIN && snapshot.live && i !== p.personal.index
      ? \`<button class="\${cls}" data-goto="\${i}" data-player="\${esc(p.id)}" title="\${i < p.personal.index ? "Send back to this page" : "Skip ahead to this page"}">\${esc(pg.label)}</button>\`
      : \`<span class="\${cls}">\${esc(pg.label)}</span>\`;
  });
  const end = p.personal.index >= total;
  chips.push(ADMIN && snapshot.live && !end
    ? \`<button class="page" data-goto="\${total}" data-player="\${esc(p.id)}" title="Skip the remaining individual pages">✓ Done</button>\`
    : \`<span class="page \${end ? "cur" : ""}">✓ Done</span>\`);
  const onPage = p.personal.pageStartedAt && !end ? Date.now() - p.personal.pageStartedAt : null;
  const slow = onPage != null && onPage > 8 * 60000;
  return '<div class="pages">' + chips.join("") + "</div>" + (onPage != null ? \`<div class="muted \${slow ? "warntext" : ""}">On this page for <span class="timer" data-since="\${p.personal.pageStartedAt}">\${dur(onPage)}</span>\${slow ? " · may be stuck" : ""}</div>\` : "");
}
function stageTimer(g) {
  const s = g.stageInfo; if (!s) return "";
  const parts = [];
  if (s.startedAt) parts.push(\`running for <span class="timer" data-since="\${s.startedAt}">\${dur(g.serverTime - s.startedAt)}</span>\${s.startedAtExact ? "" : " (approx.)"}\`);
  if (s.durationSeconds && s.startedAt) parts.push(\`about <span class="timer" data-until="\${s.startedAt + s.durationSeconds * 1000}">\${dur(s.startedAt + s.durationSeconds * 1000 - g.serverTime)}</span> left\`);
  if (s.decisionDeadline) parts.push(\`decision closes in <span class="timer" data-until="\${s.decisionDeadline}">\${dur(s.decisionDeadline - g.serverTime)}</span>\`);
  return parts.length ? '<span class="muted">' + parts.join(" · ") + "</span>" : "";
}
function endStageWarning(s) {
  const base = \`End "\${stageLabel(s)}" and move the whole group to "\${s.nextStage}"?\\nThis affects every participant in this session and is handled as if the stage timer had run out.\`;
  if (s.name === "FinalDecision") return base + "\\n\\nNote: if the group has not confirmed a decision, it will be recorded as a timeout (timeout_fail). Exports will show that a researcher ended it early.";
  if (s.name === "Task" || s.name === "Discussion") return base + "\\n\\nThe discussion ends immediately and the AI facilitator will not post again.";
  if (s.name === "Preparation" || s.name === "Followup") return base + "\\n\\nAny unfinished individual pages are skipped and their answers recorded as missing.";
  return base;
}
function renderGame() {
  lastRenderAt = Date.now();
  const g = snapshot, s = g.stageInfo;
  const names = Object.fromEntries(g.players.map(p => [p.id, p.name || p.id.slice(-6)]));
  const offline = g.players.filter(p => !p.online).length;
  const header = \`<div class="card"><div><strong>Session <code>\${esc(g.id)}</code></strong><span class="pill \${esc(g.status)}">\${STATUS[g.status]}</span>\${g.testMode ? '<span class="pill test">Test</span>' : ""}
      <a class="muted" style="margin-left:8px" target="_blank" href="\${esc((CFG.exportsRoot || "") + "/games/" + encodeURIComponent(g.id) + "/transcript")}">Full transcript ↗</a></div>
    <div class="muted">Treatment \${esc(g.treatment || "-")} · Sequence \${esc(g.sequenceId || "-")} · Batch \${esc(g.batchId || "-")} · Facilitation \${esc(g.facilitation || "-")}</div>
    <div style="margin-top:6px">Now: <strong>\${esc(g.round || "-")} · \${esc(stageLabel(s))}</strong> \${stageTimer(g)}
      \${s && s.adminEndedAt ? '<span class="pill">Stage ended by admin</span>' : ""}</div>
    \${g.breakInfo ? \`<div class="muted">Shared break: \${g.breakInfo.arrivalCount}/\${g.breakInfo.requiredCount} arrived\${g.breakInfo.completedAt ? " · finished" : g.breakInfo.deadline ? " · <span class='timer' data-until='" + g.breakInfo.deadline + "'>" + dur(g.breakInfo.deadline - g.serverTime) + "</span> left" : ""}</div>\` : ""}
    \${offline && g.status === "running" ? \`<div class="badtext" style="margin-top:4px">⚠ \${offline} offline: \${g.players.filter(p => !p.online).map(p => esc(names[p.id])).join(", ")}</div>\` : ""}
    \${ADMIN ? \`<div style="margin-top:8px;display:flex;gap:8px;flex-wrap:wrap">
      <button class="btn danger" id="endStage" \${g.live ? "" : "disabled"}>End current stage (as if time ran out) → \${esc(s ? s.nextStage : "")}</button>
      <button class="btn" id="skipBreak" \${g.live && g.breakInfo && g.breakInfo.allArrived && !g.breakInfo.completedAt ? "" : "disabled"} title="Available once all three have reached the break">Skip shared break (whole group)</button></div>\` : ""}
    <div id="status">\${statusHtml}</div></div>\`;
  const players = \`<div class="card"><table><thead><tr><th>Participant</th><th>Connection</th><th>Individual progress\${ADMIN && g.live ? " (click a page to move them there)" : ""}</th>\${ADMIN ? "<th>Rejoin</th>" : ""}</tr></thead><tbody>
    \${g.players.map(p => \`<tr class="\${p.online ? "" : "offline"}"><td><span style="color:#\${esc(p.hexCode || "111")}">●</span> <strong>\${esc(names[p.id])}</strong>
        <div class="muted"><code>\${esc(p.id.slice(-8))}</code>\${p.submitted ? " · submitted" : ""}\${p.ended ? " · " + esc(p.ended) : ""}</div></td>
      <td><span class="dot \${p.online ? "on" : ""}"></span>\${p.online ? "Online" : '<span class="badtext">Offline</span>'}
        <div class="muted">\${p.online ? (p.connectedAt ? "connected " + ago(p.connectedAt) : "") : (p.disconnectedAt ? "disconnected " + ago(p.disconnectedAt) : "not seen since the monitor started")}</div></td>
      <td>\${pagesCell(p)}</td>\${ADMIN ? "<td>" + rejoinCell(p) + "</td>" : ""}</tr>\`).join("")}</tbody></table></div>\`;
  const chat = \`<div class="card" id="chat"><strong>Chat</strong> <span class="muted">\${g.round === "Practice" ? "practice chat" : esc(g.round || "")} (\${g.chat.total || 0} messages\${ADMIN ? "" : ", redacted"})</span>
    \${g.chat.messages.map(m => \`<div class="m \${m.senderId === "ai" ? "ai" : String(m.senderId || "").startsWith("system") ? "sys" : ""}">
      <span class="who" style="\${m.hexCode ? "color:#" + esc(m.hexCode) : ""}">\${esc(m.sender)}</span> <span class="muted">\${time(m.timestamp)}</span><div>\${esc(m.text)}</div></div>\`).join("") || '<p class="muted">No messages in this round yet</p>'}</div>\`;
  const log = ADMIN ? \`<div class="card"><strong>Admin actions</strong>\${(g.controls || []).slice().reverse().map(c => \`<div class="muted">\${time(c.timestamp)} · \${esc(c.actor)} · \${ACTIONS[c.action] || esc(c.action)}\${c.playerId ? " · " + esc(names[c.playerId] || c.playerId.slice(-6)) : ""}\${c.destination ? " → " + esc(c.destination) : ""} · \${c.status === "accepted" ? '<span class="okmsg">done</span>' : '<span class="err">not done: ' + esc(REASONS[c.reason] || c.reason) + "</span>"}</div>\`).join("") || '<p class="muted">None yet</p>'}</div>\` : "<div></div>";
  const prevChat = $("#chat");
  if (prevChat) stickChat = prevChat.scrollTop + prevChat.clientHeight >= prevChat.scrollHeight - 30;
  const prevScroll = prevChat ? prevChat.scrollTop : 0;
  $("#detail").innerHTML = header + players + '<div id="bottom">' + chat + log + "</div>";
  $("#chat").scrollTop = stickChat ? $("#chat").scrollHeight : prevScroll;
  bind();
}
function tickTimers() {
  const offset = snapshot ? snapshot.serverTime - Date.now() : 0;
  document.querySelectorAll("[data-since]").forEach(el => el.textContent = dur(Date.now() + offset - Number(el.dataset.since)));
  document.querySelectorAll("[data-until]").forEach(el => el.textContent = dur(Number(el.dataset.until) - Date.now() - offset));
}
function bind() {
  document.querySelectorAll("[data-copy]").forEach(b => b.onclick = () => copyText(b.dataset.copy, b));
  if (!ADMIN) return;
  const s = snapshot.stageInfo;
  document.querySelectorAll("[data-goto]").forEach(b => b.onclick = () => {
    const p = snapshot.players.find(x => x.id === b.dataset.player), target = Number(b.dataset.goto);
    const label = target >= p.personal.pages.length ? "Done (waiting for others)" : p.personal.pages[target].label;
    const back = target < p.personal.index;
    const who = p.name || p.id;
    if (!confirm(\`Move \${who} to "\${label}"?\${back ? "\\n\\nGoing back clears the completion markers from that page onwards. Saved answers are kept and the page timer restarts." : "\\n\\nSkipped pages are not answered; they are recorded as missing."}\${p.online ? "" : "\\n\\nNote: they are offline at the moment and will see the new page when they return."}\`)) return;
    send({ action: "goto_page", playerId: p.id, index: p.personal.index, version: p.personal.version, targetIndex: target });
  });
  const end = $("#endStage");
  if (end) end.onclick = () => confirm(endStageWarning(s)) && send({ action: "end_stage" });
  const brk = $("#skipBreak");
  if (brk) brk.onclick = () => confirm("End the shared break now and move the whole group to the next round?") && send({ action: "skip_break" });
}
async function send(body) {
  if (busy) return; busy = true;
  statusHtml = '<span class="muted">Sending…</span>'; if ($("#status")) $("#status").innerHTML = statusHtml;
  try {
    const s = snapshot.stageInfo;
    const r = await api("/api/games/" + encodeURIComponent(snapshot.id) + "/control", { method: "POST",
      headers: { "content-type": "application/json", "x-monitor-request": "1" },
      body: JSON.stringify({ requestId: crypto.randomUUID ? crypto.randomUUID() : String(Date.now()) + Math.random(), stageId: s.id, stageVersion: s.version, ...body }) });
    statusHtml = r.status === "accepted" ? \`<span class="okmsg">\${time(Date.now())} Done\${r.destination ? ": → " + esc(r.destination) : ""}</span>\` : \`<span class="err">\${time(Date.now())} Not done: \${esc(REASONS[r.reason] || r.reason)}</span>\`;
  } catch (e) { statusHtml = '<span class="err">' + esc(e.message) + "</span>"; }
  busy = false; lastKey = ""; refresh();
}
async function refresh() {
  $("#clock").textContent = new Date().toLocaleTimeString("en-GB");
  try { await loadGames(); $("#conn").textContent = ""; } catch (e) { $("#conn").textContent = "⚠ " + e.message; }
  await loadGame();
}
$("#showEnded").onchange = refresh;
refresh();
setInterval(() => { if (!busy && !document.hidden) refresh(); }, 3000);
setInterval(tickTimers, 1000);
document.addEventListener("visibilitychange", () => { if (!document.hidden) refresh(); });
</script></body></html>`;
}
