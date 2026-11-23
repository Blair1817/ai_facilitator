/**
 * AdminMonitor.mjs
 *
 * Live researcher monitor for running games, hosted inside the callbacks
 * process so it reads the same in-memory scopes the experiment logic uses
 * and can apply interventions through the same mutation helpers as the
 * participant test controls.
 *
 *   - snapshot*(): read-only views (game list, one game with players,
 *     personal-page progress, presence and the live chat).
 *   - control(): researcher interventions. Authorisation (admin role) is
 *     enforced by AdminMonitorServer; this module enforces staleness,
 *     idempotency and records every attempt on the game
 *     (`adminControlEvents`) so interventions are visible in research data.
 *
 * Unlike test controls, ending a stage here behaves like the stage timer
 * running out (the normal onStageEnded timeout paths run); the stage is
 * additionally marked with `adminEndedAt`.
 */

import { testPersonalState, testControlDestinations, testPageLabel } from "../../shared/testMode.mjs";
import { PRACTICE_CHAT } from "../../shared/practice.mjs";
import { sharedBreakState, synchroniseSharedBreak } from "./PersonalFlow.mjs";
import { movePersonalPage, skipSharedBreak, endStageNow } from "./TestControls.mjs";
import { appendToAttribute, readAppendOnlyAttribute } from "./AppendOnlyAttribute.mjs";
import { redactTranscriptMessage } from "./ExportService.mjs";

const MAX_CHAT_MESSAGES = 400;
const MAX_RECEIPTS = 500;

export const ADMIN_ACTIONS = ["goto_page", "end_stage", "skip_break"];

export function createAdminMonitor({ now = () => Date.now() } = {}) {
  const games = new Map();
  const presence = new Map(); // participantID -> { online, connectedAt, disconnectedAt }
  const stageSeen = new Map(); // stageId -> first time the monitor saw it current
  const receipts = new Map();
  let empirica = null;
  let ready = false;

  function trackGame(game) {
    if (game?.id) games.set(game.id, game);
  }

  function register(Empirica) {
    empirica = Empirica;
    Empirica.on("game", (_ctx, { game }) => trackGame(game));
    Empirica.on("stage", (_ctx, { stage }) => trackGame(stage.currentGame));
    Empirica.on("ready", (ctx) => {
      for (const game of ctx?.scopesByKind?.("game")?.values() || []) trackGame(game);
    });
    // Classic sets game.stageID when a stage starts; after a callbacks
    // restart the replay time is used instead (flagged as approximate).
    Empirica.on("game", "stageID", (_ctx, { game, stageID }) => {
      trackGame(game);
      if (typeof stageID === "string" && !stageSeen.has(stageID)) stageSeen.set(stageID, { at: now(), exact: ready });
    });
    Empirica.on("ready", () => { ready = true; });
    Empirica.on("PARTICIPANT_CONNECT", (_ctx, { participant }) => {
      const prior = presence.get(participant.id) || {};
      presence.set(participant.id, { ...prior, online: true, connectedAt: now() });
    });
    Empirica.on("PARTICIPANT_DISCONNECT", (_ctx, { participant }) => {
      const prior = presence.get(participant.id) || {};
      presence.set(participant.id, { ...prior, online: false, disconnectedAt: now() });
    });
  }

  function stageStart(stage) {
    if (!stage?.id) return { at: null, exact: false };
    if (!stageSeen.has(stage.id)) stageSeen.set(stage.id, { at: now(), exact: false });
    return stageSeen.get(stage.id);
  }

  function gameStatus(game) {
    if (game.get("ended") || game.get("endedAt")) return "ended";
    if (game.currentStage) return "running";
    return "lobby";
  }

  function summarise(game) {
    const round = game.currentRound, stage = game.currentStage;
    const players = game.players || [];
    return {
      id: game.id,
      batchId: game.get("batchID") ?? null,
      treatment: game.get("treatmentName") ?? null,
      sequenceId: game.get("sequenceId") ?? null,
      testMode: game.get("testControlsEnabled") === true,
      status: gameStatus(game),
      round: round ? roundLabel(round) : null,
      stage: stage ? testPageLabel(stage.get("name")) : null,
      playerCount: players.length,
      onlineCount: players.filter(p => presenceOf(p).online).length,
    };
  }

  function presenceOf(player) {
    const id = player.get("participantID") || player.participantID;
    return presence.get(id) || { online: false };
  }

  function listGames({ includeEnded = false } = {}) {
    return [...games.values()]
      .filter(game => includeEnded || gameStatus(game) !== "ended")
      .map(summarise)
      .sort((a, b) => order(a.status) - order(b.status) || String(a.id).localeCompare(String(b.id)));
  }

  function snapshotGame(gameId, { role = "viewer" } = {}) {
    const game = games.get(gameId);
    if (!game) return null;
    const round = game.currentRound, stage = game.currentStage;
    const isAdmin = role === "admin";
    const live = Boolean(round && stage && !stage.get("ended") && gameStatus(game) === "running");
    const stageInfo = stage ? {
      id: stage.id,
      name: stage.get("name"),
      label: testPageLabel(stage.get("name")),
      // Stages without a real time limit use a placeholder of ~31 years.
      durationSeconds: stage.get("duration") > 0 && stage.get("duration") < 86400 ? stage.get("duration") : null,
      startedAt: stageStart(stage).at,
      startedAtExact: stageStart(stage).exact,
      decisionDeadline: stage.get("name") === "FinalDecision" ? round.get("finalDecisionDeadline") ?? null : null,
      version: stage.get("testControlVersion") || 0,
      adminEndedAt: stage.get("adminEndedAt") ?? null,
      nextStage: round ? testControlDestinations(round, stage, { pages: [], index: 0 }).next_stage : null,
    } : null;
    const breakInfo = round && stage && stage.get("name") === "Followup" && round.get("taskIndex") === 0 ? {
      ...sharedBreakState(game.players, "Followup", 0),
      deadline: round.get("sharedBreakDeadline") ?? null,
      completedAt: round.get("sharedBreakCompletedAt") ?? null,
    } : null;
    const players = (game.players || []).map(player => {
      const p = presenceOf(player);
      const state = round && stage && player.round ? testPersonalState(player, round, stage) : null;
      return {
        id: player.id,
        name: player.get("name") ?? null,
        hexCode: player.get("hexCode") ?? null,
        participantNumber: player.get("participantNumber") ?? null,
        online: Boolean(p.online),
        connectedAt: p.connectedAt ?? null,
        disconnectedAt: p.disconnectedAt ?? null,
        ended: player.get("ended") ?? null,
        submitted: Boolean(player.stage?.get("submit")),
        personal: state ? {
          pages: state.pages.map(page => ({ id: page, label: testPageLabel(page) })),
          index: state.index,
          version: state.version,
          current: state.pages[state.index] ? testPageLabel(state.pages[state.index]) : (state.pages.length ? "Finished (waiting for others)" : null),
          currentId: state.pages[state.index] ?? (state.pages.length ? "__done" : null),
          pageStartedAt: (state.practice ? player.round.get("practicePageStartedAt")
            : player.round.get(`personalProgress_${stage.get("name")}`)?.startedAt) ?? null,
        } : null,
        ...(isAdmin ? { rejoin: rejoinInfo(player) } : {}),
      };
    });
    return {
      ...summarise(game),
      live,
      facilitation: round?.get("facilitation") ?? null,
      stageInfo,
      breakInfo,
      players,
      chat: chatFor(game, round, isAdmin),
      controls: isAdmin ? readAppendOnlyAttribute({ get: key => game.get(key) }, "adminControlEvents").slice(-20) : undefined,
      serverTime: now(),
    };
  }

  function control(gameId, request, { actor = "admin" } = {}) {
    const respond = (status, reason, extra = {}) => ({ requestId: request?.requestId, status, reason, ...extra });
    if (!request || typeof request.requestId !== "string" || !request.requestId || request.requestId.length > 128)
      return respond("rejected", "invalid_request");
    if (receipts.has(request.requestId)) return receipts.get(request.requestId);
    const game = games.get(gameId);
    if (!game) return respond("rejected", "game_not_found");
    const round = game.currentRound, stage = game.currentStage, at = now();
    const finish = (status, reason, extra) => {
      const response = respond(status, reason, extra);
      receipts.set(request.requestId, response);
      if (receipts.size > MAX_RECEIPTS) receipts.delete(receipts.keys().next().value);
      appendToAttribute({ get: key => game.get(key), set: (key, value) => game.set(key, value, { protected: true }) },
        "adminControlEvents", {
          id: `admin:${request.requestId}`, ...response, action: request.action, actor,
          playerId: request.playerId ?? null, targetIndex: request.targetIndex ?? null,
          timestamp: at, roundId: round?.id ?? null, stageId: stage?.id ?? null, stageName: stage?.get("name") ?? null,
        });
      empirica?.flush?.();
      return response;
    };
    if (!ADMIN_ACTIONS.includes(request.action)) return finish("rejected", "unknown_action");
    if (!round || !stage || gameStatus(game) !== "running" || stage.get("ended") || request.stageId !== stage.id)
      return finish("rejected", "stale_stage");
    if (request.stageVersion !== (stage.get("testControlVersion") || 0)) return finish("rejected", "stale_progress");

    let reason = null, destination = null;
    if (request.action === "goto_page") {
      const player = (game.players || []).find(p => p.id === request.playerId);
      if (!player?.round) return finish("rejected", "player_not_found");
      const state = testPersonalState(player, round, stage);
      if (request.index !== state.index || request.version !== state.version) return finish("rejected", "stale_progress");
      reason = movePersonalPage({ game, round, stage, player, state, targetIndex: request.targetIndex, now: at });
      destination = state.pages[request.targetIndex] ? testPageLabel(state.pages[request.targetIndex]) : "Finished (waiting for others)";
    } else if (request.action === "skip_break") {
      reason = skipSharedBreak({ game, round, stage, now: at });
      destination = "Round 2 · Task information";
    } else if (request.action === "end_stage") {
      destination = testControlDestinations(round, stage, { pages: [], index: 0 }).next_stage;
      stage.set("adminEndedAt", at, { protected: true });
      endStageNow({ game, round, stage });
    }
    if (reason) return finish("rejected", reason);
    stage.set("testControlVersion", (stage.get("testControlVersion") || 0) + 1, { protected: true });
    if (!stage.get("ended") && empirica) synchroniseSharedBreak(stage, () => {}, empirica);
    return finish("accepted", request.action, destination ? { destination } : {});
  }

  return { register, trackGame, listGames, snapshotGame, control, _games: games, _presence: presence };
}

function order(status) {
  return { running: 0, lobby: 1, ended: 2 }[status] ?? 3;
}

function roundLabel(round) {
  if (round.get("isPractice")) return "Practice";
  return round.get("name") || `Round ${(round.get("taskIndex") ?? 0) + 1}`;
}

function chatFor(game, round, isAdmin) {
  if (!round) return { key: null, messages: [] };
  const key = round.get("isPractice") ? PRACTICE_CHAT : `chat_round_${round.get("taskIndex") ?? 0}`;
  const raw = game.get(key);
  const list = Array.isArray(raw) ? raw.slice(-MAX_CHAT_MESSAGES) : [];
  const messages = list.map(message => {
    const m = isAdmin ? message : redactTranscriptMessage(message);
    return {
      id: m?.messageId ?? m?.id ?? null,
      sender: m?.sender?.name ?? m?.speakerType ?? "unknown",
      senderId: m?.sender?.id ?? m?.participantId ?? null,
      hexCode: m?.sender?.hexCode ?? null,
      speakerType: m?.speakerType ?? null,
      text: m?.text ?? m?.content ?? "",
      timestamp: m?.timestamp ?? null,
    };
  });
  return { key, messages, total: Array.isArray(raw) ? raw.length : 0 };
}

function rejoinInfo(player) {
  const pid = player.get("prolificPID"), study = player.get("prolificStudyID"), session = player.get("prolificSessionID");
  const identifier = player.get("participantIdentifier") ?? null;
  if (pid && study && session) {
    const query = new URLSearchParams({ PROLIFIC_PID: pid, STUDY_ID: study, SESSION_ID: session }).toString();
    return { identifier, mode: "prolific", query: `?${query}` };
  }
  return { identifier, mode: identifier ? "identifier" : "unknown", query: null };
}

export const adminMonitor = createAdminMonitor();
