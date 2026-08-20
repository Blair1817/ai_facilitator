/**
 * ExportService.mjs
 *
 * Read-only view of the Tajriba store, formatted for the researcher
 * download pipeline. Two goals:
 *
 *   1. Pull only what a researcher needs (questionnaire data, chat
 *      transcripts, LLM audit log) without re-implementing the full
 *      Empirica CSV export. Filters by batch, treatment, time range,
 *      and game state at the Tajriba query layer so we never load the
 *      whole event log into memory.
 *
 *   2. Apply the same `redactPII` pipeline as the Supabase research
 *      mirror, by default, with an explicit opt-out flag. The data
 *      contract — "research data, redacted unless `--raw`" — is the
 *      same one used by every other research-data path in this repo.
 *
 * Source of truth:
 *
 *   - Tajriba JSONL attributes:
 *       game     sequenceId, treatment, taskOrder, taskVersionOrder,
 *                facilitationOrder, startedAt, endedAt, systemInfo,
 *                chat_round_0, chat_round_1,
 *                llmLog.<auditRequestId>, llmLogIndex,
 *                operationalEvents.<id>, operationalEventsIndex
 *       player   name, introDone, ended, finalQuestions, expFeedback
 *       round    tlxSurvey (per player), subjectiveSurvey (per player),
 *                initialDecision, finalDecision, finalDecisionConfirmed,
 *                finalDecisionOutcome, reviewQuizPassed
 *       batch    treatment, status
 *
 *   - The Tajriba admin connection is established in `connect()` using
 *     `Tajriba.createAndAwait` + `registerService` (the same path
 *     `exportCSV` in `@empirica/core/admin/classic` uses). Tests inject
 *     a mock connection object instead.
 *
 * Privacy contract:
 *
 *   - The service does not return raw transcripts to callers that did
 *     not explicitly opt in to `--raw`. The CLI and the HTTP server
 *     both expose the opt-in; the audit log records the choice.
 *   - Question text and answer text in the rendered CSV / Markdown
 *     pass through `redactPII` by default. LLM prompts / responses in
 *     `llmLog.<id>` pass through the same filter.
 *   - IDs (game / batch / player / scope) are *not* redacted; they are
 *     Tajriba ULIDs, not PII.
 */

import archiver from "archiver";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { Writable } from "node:stream";

import { redactDeep } from "./SupabasePersistence.mjs";

/**
 * @typedef {Object} AdminConnection
 * @property {(filter: {kinds?: string[], kvs?: Array<{key: string, val: string}>, ids?: string[]}, first?: number) => Promise<{edges: Array<{node: any}>, pageInfo: {hasNextPage: boolean, endCursor: string|null}}>} scopes
 * @property {() => void} [stop]
 *
 * @typedef {Object} ExportServiceOptions
 * @property {AdminConnection} admin
 * @property {string} [auditFile]            JSONL path; if absent, audit calls are no-ops
 * @property {Object<string, any>} [clock]   for tests; defaults to global Date
 *
 * Per-scope attribute accessor: an admin connection in production
 * returns Attributes via `attributes(scopeID)`. Tests inject either a
 * mock admin that produces the same shape, or pre-built scope maps.
 */

const SCOPES_PAGE_SIZE = 100;

export class ExportService {
  constructor({ admin, auditFile, clock = Date, defaultRedact = true } = {}) {
    if (!admin) throw new Error("ExportService: admin connection is required");
    this.admin = admin;
    this.auditFile = auditFile || null;
    this.now = clock.now ? clock.now.bind(clock) : () => new Date().toISOString();
    this.defaultRedact = defaultRedact !== false;
  }

  // ── Listing ───────────────────────────────────────────────────────────

  /**
   * List all batches in the store, optionally filtered by time range.
   * The filter is applied at the Tajriba `kvs` level where possible to
   * avoid a full store scan.
   *
   * @param {Object} [filter]
   * @param {string} [filter.fromISO]  inclusive lower bound (createdAt)
   * @param {string} [filter.toISO]    inclusive upper bound (createdAt)
   * @param {string} [filter.status]   "created" | "running" | "ended"
   * @returns {Promise<Array<{id: string, createdAt: string, status: string, treatment: string|null, gameCount: number, playerCount: number}>>}
   */
  async listBatches(filter = {}) {
    const scopes = await this.allScopes({ kinds: ["batch"] });
    // Pull every game scope once and group by `attrs.batchID` in memory.
    // Tajriba v1.12's admin `scopes(filter: {kvs})` does not match the
    // store's JSON-encoded attribute values (D-014 deploy 2026-08-18
    // empirical inspection of the live NAS store), so the kvs form was
    // returning all game scopes regardless of batchID. Filtering
    // in-memory against the same `parseValue` semantics used by the
    // renderer keeps the two paths consistent.
    const allGames = await this.allScopes({ kinds: ["game"] });
    const gamesByBatch = new Map();
    for (const g of allGames) {
      const bid = (await this.scopeAttributesOf(g)).batchID;
      if (bid == null) continue;
      if (!gamesByBatch.has(bid)) gamesByBatch.set(bid, []);
      gamesByBatch.get(bid).push(g);
    }
    const result = [];
    for (const scope of scopes) {
      const attrs = await this.scopeAttributesOf(scope);
      const createdAt = attrs.createdAt || scope.createdAt || null;
      if (filter.fromISO && createdAt && createdAt < filter.fromISO) continue;
      if (filter.toISO && createdAt && createdAt > filter.toISO) continue;
      const status = attrs.status || "unknown";
      if (filter.status && status !== filter.status) continue;
      const treatment = attrs.treatment || null;
      // Players are not directly linked to batches; we walk through
      // `game -> player` to count the unique participants. This is the
      // same shape Tajriba exposes in the admin UI.
      const games = gamesByBatch.get(scope.id) || [];
      const playerSet = new Set();
      for (const g of games) {
        const players = await this.gamePlayerIDs(g.id);
        for (const pid of players) playerSet.add(pid);
      }
      result.push({
        id: scope.id,
        createdAt,
        status,
        treatment,
        gameCount: games.length,
        playerCount: playerSet.size,
      });
    }
    result.sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
    return result;
  }

  /**
   * List games in a batch, with optional filter on treatment, sequence,
   * and start time.
   *
   * @param {string} batchId
   * @param {Object} [filter]
   * @param {string} [filter.fromISO]
   * @param {string} [filter.toISO]
   * @param {string} [filter.treatment]   "static" | "adaptive"
   * @param {string} [filter.sequenceId]  "S1" | "S2" | "S3" | "S4"
   * @param {string} [filter.status]      "created" | "running" | "ended"
   * @param {number} [filter.limit=100]
   * @param {number} [filter.offset=0]
   * @returns {Promise<{items: Array<Object>, total: number}>}
   */
  async listGames(batchId, filter = {}) {
    if (!batchId) throw new Error("listGames: batchId is required");
    // Pull all game scopes once and filter by `attrs.batchID` in memory.
    // See listBatches for why the admin `kvs` filter is unreliable.
    const allGames = await this.allScopes({ kinds: ["game"] });
    const all = [];
    for (const g of allGames) {
      if ((await this.scopeAttributesOf(g)).batchID === batchId) all.push(g);
    }
    const items = [];
    for (const scope of all) {
      const attrs = await this.scopeAttributesOf(scope);
      const startedAt = attrs.startedAt || scope.createdAt || null;
      const endedAt = attrs.endedAt || null;
      const treatment = attrs.treatment || null;
      const sequenceId = attrs.sequenceId || null;
      const status = attrs.status || "unknown";
      if (filter.fromISO && startedAt && startedAt < filter.fromISO) continue;
      if (filter.toISO && startedAt && startedAt > filter.toISO) continue;
      if (filter.treatment && treatment !== filter.treatment) continue;
      if (filter.sequenceId && sequenceId !== filter.sequenceId) continue;
      if (filter.status && status !== filter.status) continue;
      const playerIDs = await this.gamePlayerIDs(scope.id);
      items.push({
        id: scope.id,
        batchId,
        startedAt,
        endedAt,
        treatment,
        sequenceId,
        status,
        playerCount: playerIDs.length,
      });
    }
    items.sort((a, b) => (a.startedAt < b.startedAt ? 1 : -1));
    return paginate(items, filter);
  }

  // ── Game data extraction ──────────────────────────────────────────────

  /**
   * Read everything ExportService needs to render a single game bundle:
   * the game attributes, the players with their submitted forms, the
   * rounds with their TLX / subjective / review-quiz data, and the
   * per-entry LLM audit log reconstructed from the bounded pattern.
   *
   * @param {string} gameId
   * @returns {Promise<{game: Object, players: Array<Object>, rounds: Array<Object>, llmLog: Array<Object>}>}
   */
  async getGameBundle(gameId) {
    if (!gameId) throw new Error("getGameBundle: gameId is required");
    // Tajriba v1.12's admin `scopes(filter: {ids})` does not match the
    // same way the kvs filter didn't (D-014 deploy 2026-08-18
    // empirical inspection of the live store). Pull all game scopes
    // and filter by id in memory; the kvs path mirrors the renderer
    // so a single code path covers both.
    const allGames = await this.allScopes({ kinds: ["game"] });
    const gameScopes = allGames.filter((s) => s.id === gameId);
    if (gameScopes.length === 0) {
      throw new ExportNotFoundError(`game not found: ${gameId}`);
    }
    const game = await this.readGame(gameScopes[0]);

    const playerIDs = await this.gamePlayerIDs(gameId);
    const players = [];
    for (const pid of playerIDs) {
      const allPlayers = await this.allScopes({ kinds: ["player"] });
      const pScopes = allPlayers.filter((s) => s.id === pid);
      if (pScopes.length === 0) continue;
      players.push(await this.readPlayer(pScopes[0], gameId));
    }
    players.sort((a, b) => (a.name || "").localeCompare(b.name || ""));

    const rounds = [];
    for (let idx = 0; idx < (game.rounds || []).length; idx += 1) {
      const roundId = game.rounds[idx];
      const allRounds = await this.allScopes({ kinds: ["round"] });
      const rScopes = allRounds.filter((s) => s.id === roundId);
      if (rScopes.length === 0) continue;
      rounds.push(await this.readRound(rScopes[0], players));
    }

    const llmLog = await this.readLlmLog(gameId);

    return { game, players, rounds, llmLog };
  }

  async readGame(scope) {
    const attrs = await this.scopeAttributesOf(scope);
    const roundIDs = await this.gameRoundIDs(scope.id);
    // Include chat_round_<i> so renderTranscriptMd can render the
    // participant + facilitator transcript without re-querying.
    //
    // chat_round_<i> is a Tajriba *vector* attribute (written via
    // `game.append`), so scopeAttributes returns each appended message
    // as an indexed key `chat_round_<i>:<j>` — NOT as a single
    // `chat_round_<i>` array. Reassemble the ordered list here. The
    // non-indexed single-array shape is still accepted for the
    // test fixture and any pre-vector store.
    const chat = {};
    for (const [key, value] of Object.entries(attrs)) {
      const match = /^(chat_round_\d+)(?::(\d+))?$/.exec(key);
      if (!match) continue;
      const base = match[1];
      if (match[2] === undefined) {
        if (Array.isArray(value)) chat[base] = value;
        continue;
      }
      const index = Number(match[2]);
      if (!Array.isArray(chat[base])) chat[base] = [];
      chat[base][index] = value;
    }
    for (const base of Object.keys(chat)) {
      if (Array.isArray(chat[base])) {
        chat[base] = chat[base].filter((entry) => entry !== undefined);
      }
    }
    return {
      id: scope.id,
      status: attrs.status || "unknown",
      // Prefer the human-readable treatment name; the raw `treatment`
      // attribute is the full factor object and stringifies to
      // "[object Object]" in the transcript/CSV.
      treatment: attrs.treatmentName || (typeof attrs.treatment === "string" ? attrs.treatment : null),
      sequenceId: attrs.sequenceId || null,
      taskOrder: attrs.taskOrder || null,
      taskVersionOrder: attrs.taskVersionOrder || null,
      facilitationOrder: attrs.facilitationOrder || null,
      startedAt: attrs.startedAt || scope.createdAt || null,
      endedAt: attrs.endedAt || null,
      totalInterventions: numberOrZero(attrs.totalInterventions),
      totalFallbackMessages: numberOrZero(attrs.totalFallbackMessages),
      systemInfo: attrs.systemInfo || null,
      rounds: roundIDs,
      chat,
    };
  }

  async readPlayer(scope, gameId) {
    const attrs = await this.scopeAttributesOf(scope);
    return {
      id: scope.id,
      gameId,
      name: attrs.name || null,
      introDone: Boolean(attrs.introDone),
      ended: attrs.ended || null,
      finalQuestions: attrs.finalQuestions || null,
      expFeedback: attrs.expFeedback || null,
    };
  }

  async readRound(scope, players) {
    const attrs = await this.scopeAttributesOf(scope);
    const index = numberOrZero(attrs.index);
    const taskIndex = numberOrZero(attrs.taskIndex);
    const taskVersion = attrs.taskVersion || null;
    const facilitation = attrs.facilitation || null;
    const perPlayer = {};
    for (const p of players) {
      perPlayer[p.id] = {
        tlxSurvey: attrs[`tlxSurvey:${p.id}`] || attrs.tlxSurvey || null,
        subjectiveSurvey: attrs[`subjectiveSurvey:${p.id}`] || attrs.subjectiveSurvey || null,
        initialChoice: attrs[`initialChoice:${p.id}`] || null,
        initialConfidence: attrs[`initialConfidence:${p.id}`] || null,
        initialDecision: attrs[`initialDecision:${p.id}`] || attrs.initialDecision || null,
        finalDecision: attrs[`finalDecision:${p.id}`] || attrs.finalDecision || null,
        finalDecisionDraft: attrs[`finalDecisionDraft:${p.id}`] || null,
        reviewQuizPassed: pickBool(attrs[`reviewQuizPassed:${p.id}`] ?? attrs.reviewQuizPassed),
      };
    }
    return {
      id: scope.id,
      index,
      taskIndex,
      taskVersion,
      facilitation,
      perPlayer,
    };
  }

  async readLlmLog(gameId) {
    // Same in-memory filter pattern as the rest of the service: pull
    // all game scopes and find the one whose id matches, because the
    // admin `ids` filter is unreliable on Tajriba v1.12.
    const allGames = await this.allScopes({ kinds: ["game"] });
    const indexScopes = allGames.filter((s) => s.id === gameId);
    if (indexScopes.length === 0) return [];
    const gameAttrs = await this.scopeAttributesOf(indexScopes[0]);
    const index = gameAttrs.llmLogIndex;
    if (!Array.isArray(index) || index.length === 0) return [];
    const entries = [];
    for (const id of index) {
      if (typeof id !== "string") continue;
      const entry = gameAttrs[`llmLog.${id}`];
      if (entry && typeof entry === "object") entries.push(entry);
    }
    return entries;
  }

  /**
   * Resolve a scope's attributes to a flat map.
   *
   * The admin `scopes` query used to nest `attributes(first: 100)`, which
   * silently truncated any scope with more than 100 attributes (a game with
   * chat + llmLog + operational events) and made scalar reads flaky. That
   * page size is raised at the query source (patched `@empirica/tajriba`
   * ScopesDocument `first: 100` -> `2000`), so the nested connection now
   * carries the full attribute set. The Tajriba `Query.attributes` resolver
   * is unimplemented (`panic("not implemented")`) and must not be used.
   *
   * @param {Object} scope
   * @returns {Object<string, any>}
   */
  scopeAttributesOf(scope) {
    return scopeAttributes(scope);
  }

  // ── Format rendering ──────────────────────────────────────────────────

  /**
   * Render the questionnaire data for `gameId` as a wide CSV: one row
   * per player, columns per round + final + per-game metadata.
   * @param {string} gameId
   * @param {{redact?: boolean}} [opts]
   * @returns {Promise<{csv: string, columns: string[], rowCount: number}>}
   */
  async renderQuestionnaireCsv(gameId, opts = {}) {
    const redact = opts.redact !== false;
    const bundle = await this.getGameBundle(gameId);
    const redacted = redact ? redactGameBundle(bundle) : bundle;
    return renderQuestionnaireCsv(redacted);
  }

  /**
   * Render the chat transcript for `gameId` as Markdown, one section
   * per round, with human messages and facilitator interventions
   * interleaved in timestamp order. LLM audit entries are appended in
   * a final "LLM audit log" section.
   * @param {string} gameId
   * @param {{redact?: boolean}} [opts]
   * @returns {Promise<{markdown: string}>}
   */
  async renderTranscriptMd(gameId, opts = {}) {
    const redact = opts.redact !== false;
    const bundle = await this.getGameBundle(gameId);
    const redacted = redact ? redactGameBundle(bundle) : bundle;
    return { markdown: renderTranscriptMd(redacted) };
  }

  /**
   * Build a ZIP bundle of questionnaire.csv + transcript.md + meta.json
   * for `gameId`. Streams the result to `output`.
   *
   * @param {string} gameId
   * @param {{redact?: boolean, output: fs.WriteStream}} opts
   * @returns {Promise<{bytes: number, sha256: string, files: string[]}>}
   */
  async writeGameBundle(gameId, { redact, output }) {
    const useRedact = redact !== false;
    const bundle = await this.getGameBundle(gameId);
    const redacted = useRedact ? redactGameBundle(bundle) : bundle;
    const csv = renderQuestionnaireCsv(redacted).csv;
    const md = renderTranscriptMd(redacted);
    const meta = {
      schemaVersion: 1,
      generatedAt: this.now(),
      gameId,
      redact: useRedact,
      players: redacted.players.map((p) => ({ id: p.id, name: p.name })),
      rounds: redacted.rounds.map((r) => ({
        id: r.id,
        index: r.index,
        taskIndex: r.taskIndex,
        taskVersion: r.taskVersion,
        facilitation: r.facilitation,
      })),
      llmLogEntryCount: redacted.llmLog.length,
    };
    return new Promise((resolve, reject) => {
      const archive = archiver("zip", { zlib: { level: 9 } });
      const sha = createHash("sha256");
      let bytes = 0;
      const tee = new Writable({
        write(chunk, _enc, cb) {
          bytes += chunk.length;
          sha.update(chunk);
          if (!output.write(chunk)) {
            output.once("drain", cb);
            return;
          }
          cb();
        },
        final(cb) {
          output.end(cb);
        },
      });
      tee.on("finish", () => resolve({ bytes, sha256: sha.digest("hex"), files: ["questionnaire.csv", "transcript.md", "meta.json", "llm-audit.jsonl"] }));
      tee.on("error", reject);
      archive.on("warning", (err) => reject(err));
      archive.on("error", (err) => reject(err));
      archive.pipe(tee);
      // archiver in this version of @empirica/core does not accept raw
      // strings; pass Buffers to keep the call portable across its
      // vendored copies.
      archive.append(Buffer.from(csv, "utf8"), { name: "questionnaire.csv" });
      archive.append(Buffer.from(md, "utf8"), { name: "transcript.md" });
      archive.append(Buffer.from(JSON.stringify(meta, null, 2), "utf8"), { name: "meta.json" });
      const llmJsonl = redacted.llmLog.length > 0
        ? redacted.llmLog.map((e) => JSON.stringify(e)).join("\n") + "\n"
        : "";
      archive.append(Buffer.from(llmJsonl, "utf8"), { name: "llm-audit.jsonl" });
      archive.finalize();
    });
  }

  // ── Tajriba admin plumbing ───────────────────────────────────────────

  async allScopes(filters) {
    // Tajriba v1.12 expects `filter` as `[ScopedAttributesInput!]` — a list
    // of single-axis filter objects AND-ed together. Each object may only
    // use ONE of {kinds, kvs, ids, names, keys}. Accept either:
    //   - a single ScopedAttributesInput object  (auto-wrapped to length 1)
    //   - undefined/null                         (no filter)
    //   - an array of ScopedAttributesInput     (multi-axis AND)
    const out = [];
    const first = SCOPES_PAGE_SIZE;
    let cursor = null;
    const filterArg =
      filters == null
        ? undefined
        : Array.isArray(filters)
          ? filters
          : [filters];
    // eslint-disable-next-line no-constant-condition
    while (true) {
      const args = { first };
      if (filterArg !== undefined) args.filter = filterArg;
      if (cursor) args.after = cursor;
      const page = await this.admin.scopes(args);
      for (const edge of page?.edges || []) {
        out.push(edge.node);
      }
      if (!page?.pageInfo?.hasNextPage) break;
      cursor = page.pageInfo.endCursor;
      if (!cursor) break;
    }
    return out;
  }

  async countScopesByKvs(filter) {
    let total = 0;
    const first = SCOPES_PAGE_SIZE;
    let cursor = null;
    // eslint-disable-next-line no-constant-condition
    while (true) {
      const args = { filter, first };
      if (cursor) args.after = cursor;
      const page = await this.admin.scopes(args);
      total += (page?.edges || []).length;
      if (!page?.pageInfo?.hasNextPage) break;
      cursor = page.pageInfo.endCursor;
      if (!cursor) break;
    }
    return total;
  }

  async gamePlayerIDs(gameId) {
    // The Tajriba store attributes a player scope with `gameID` (a bare
    // string), not `currentGameID`. The admin `scopes({kvs})` filter
    // also does not match the store's JSON-encoded attribute values
    // (see listBatches), so we pull all player scopes and filter by
    // `attrs.gameID` in memory.
    const all = await this.allScopes({ kinds: ["player"] });
    return all
      .filter((s) => scopeAttributes(s).gameID === gameId)
      .map((s) => s.id);
  }

  async gameRoundIDs(gameId) {
    // Pull all round scopes once and filter by `attrs.gameID` in memory.
    // See listBatches for why the admin `kvs` filter is unreliable.
    const roundScopes = (
      await this.allScopes({ kinds: ["round"] })
    ).filter((s) => scopeAttributes(s).gameID === gameId);
    roundScopes.sort((a, b) => {
      const ai = numberOrZero(scopeAttributes(a).index);
      const bi = numberOrZero(scopeAttributes(b).index);
      return ai - bi;
    });
    return roundScopes.map((s) => s.id);
  }
}

// ── Pure helpers (exported for unit tests) ─────────────────────────────

/**
 * Walk a game bundle and apply `redactDeep` to every text field that
 * could contain participant-supplied content. Leaves IDs, timestamps,
 * and Tajriba structural data untouched. This is the same contract
 * `SupabasePersistence.mirrorNonBlocking` follows.
 */
export function redactGameBundle(bundle) {
  if (!bundle || typeof bundle !== "object") return bundle;
  const game = { ...bundle.game };
  const players = (bundle.players || []).map((p) => ({
    ...p,
    finalQuestions: p.finalQuestions ? redactDeep(p.finalQuestions) : null,
    expFeedback: p.expFeedback ? redactDeep(p.expFeedback) : null,
  }));
  const rounds = (bundle.rounds || []).map((r) => {
    const perPlayer = {};
    for (const [pid, data] of Object.entries(r.perPlayer || {})) {
      perPlayer[pid] = {
        tlxSurvey: data.tlxSurvey ? redactDeep(data.tlxSurvey) : null,
        subjectiveSurvey: data.subjectiveSurvey ? redactDeep(data.subjectiveSurvey) : null,
        initialDecision: data.initialDecision ? redactDeep(data.initialDecision) : null,
        finalDecision: data.finalDecision ? redactDeep(data.finalDecision) : null,
        finalDecisionDraft: data.finalDecisionDraft ? redactDeep(data.finalDecisionDraft) : null,
        initialChoice: data.initialChoice,
        initialConfidence: data.initialConfidence,
        reviewQuizPassed: data.reviewQuizPassed,
      };
    }
    return { ...r, perPlayer };
  });
  const llmLog = (bundle.llmLog || []).map((e) => redactDeep(e));
  return { game, players, rounds, llmLog };
}

export function renderQuestionnaireCsv(bundle) {
  const { game, players, rounds } = bundle;
  const perPlayerRow = (player, round, slot) => {
    const data = round.perPlayer[player.id] || {};
    return {
      round_index: round.index,
      task_index: round.taskIndex,
      task_version: round.taskVersion,
      facilitation: round.facilitation,
      initial_choice: data.initialChoice ?? "",
      initial_confidence: data.initialConfidence ?? "",
      initial_decision_submitted_at: data.initialDecision?.submittedAt ?? "",
      review_quiz_passed: data.reviewQuizPassed === null ? "" : data.reviewQuizPassed ? "true" : "false",
      tlx_mental: data.tlxSurvey?.tlxMentalDemand ?? "",
      tlx_physical: data.tlxSurvey?.tlxPhysicalDemand ?? "",
      tlx_temporal: data.tlxSurvey?.tlxTemporalDemand ?? "",
      tlx_performance: data.tlxSurvey?.tlxPerformance ?? "",
      tlx_effort: data.tlxSurvey?.tlxEffort ?? "",
      tlx_frustration: data.tlxSurvey?.tlxFrustration ?? "",
      subjective_group_free_text: data.subjectiveSurvey?.groupFreeText ?? "",
      subjective_group_contribution: data.subjectiveSurvey?.groupContribution ?? "",
      subjective_group_influence: data.subjectiveSurvey?.groupInfluence ?? "",
      subjective_group_productive: data.subjectiveSurvey?.groupProductive ?? "",
      subjective_group_structured: data.subjectiveSurvey?.groupStructured ?? "",
      subjective_group_cohesion: data.subjectiveSurvey?.groupCohesion ?? "",
      subjective_facilitator_freetext: data.subjectiveSurvey?.facilitatorGroupFreetext ?? "",
      subjective_facilitator_sharing: data.subjectiveSurvey?.facilitatorSharing ?? "",
      subjective_facilitator_distracting: data.subjectiveSurvey?.facilitatorDistracting ?? "",
      subjective_facilitator_synthesis: data.subjectiveSurvey?.facilitatorSynthesis ?? "",
      subjective_facilitator_focus: data.subjectiveSurvey?.facilitatorFocus ?? "",
      subjective_facilitator_need_fit: data.subjectiveSurvey?.facilitatorNeedFit ?? "",
      subjective_facilitator_timing: data.subjectiveSurvey?.facilitatorTimingAppropriateness ?? "",
      subjective_facilitator_option_push: data.subjectiveSurvey?.facilitatorOptionPush ?? "",
      final_decision_choice: data.finalDecision?.choice ?? "",
      final_decision_confidence: data.finalDecision?.confidence ?? "",
      final_decision_outcome: data.finalDecision?.outcome ?? "",
      final_decision_submitted_at: data.finalDecision?.submittedAt ?? "",
      slot,
    };
  };
  const rows = [];
  for (const player of players) {
    for (const round of rounds) {
      rows.push({
        game_id: game.id,
        batch_id: null,
        treatment: game.treatment ?? "",
        sequence_id: game.sequenceId ?? "",
        started_at: game.startedAt ?? "",
        ended_at: game.endedAt ?? "",
        player_id: player.id,
        player_name: player.name ?? "",
        player_ended: player.ended ?? "",
        ...perPlayerRow(player, round, "per_round"),
      });
    }
    rows.push({
      game_id: game.id,
      batch_id: null,
      treatment: game.treatment ?? "",
      sequence_id: game.sequenceId ?? "",
      started_at: game.startedAt ?? "",
      ended_at: game.endedAt ?? "",
      player_id: player.id,
      player_name: player.name ?? "",
      player_ended: player.ended ?? "",
      round_index: "",
      task_index: "",
      task_version: "",
      facilitation: "",
      initial_choice: "",
      initial_confidence: "",
      initial_decision_submitted_at: "",
      review_quiz_passed: "",
      tlx_mental: "",
      tlx_physical: "",
      tlx_temporal: "",
      tlx_performance: "",
      tlx_effort: "",
      tlx_frustration: "",
      subjective_group_free_text: "",
      subjective_group_contribution: "",
      subjective_group_influence: "",
      subjective_group_productive: "",
      subjective_group_structured: "",
      subjective_group_cohesion: "",
      subjective_facilitator_freetext: "",
      subjective_facilitator_sharing: "",
      subjective_facilitator_distracting: "",
      subjective_facilitator_synthesis: "",
      subjective_facilitator_focus: "",
      subjective_facilitator_need_fit: "",
      subjective_facilitator_timing: "",
      subjective_facilitator_option_push: "",
      final_decision_choice: player.finalQuestions?.firstTaskCarryover ?? "",
      final_decision_confidence: player.finalQuestions?.preferredFacilitator ?? "",
      final_decision_outcome: player.finalQuestions?.facilitatorDifference ?? "",
      final_decision_submitted_at: player.finalQuestions?.submittedAt ?? "",
      first_task_carryover: player.finalQuestions?.firstTaskCarryover ?? "",
      first_task_carryover_description: player.finalQuestions?.firstTaskCarryoverDescription ?? "",
      facilitator_difference: player.finalQuestions?.facilitatorDifference ?? "",
      preferred_facilitator: player.finalQuestions?.preferredFacilitator ?? "",
      final_questions_submitted_at: player.finalQuestions?.submittedAt ?? "",
      exp_feedback: player.expFeedback?.expFeedback ?? "",
      exp_feedback_submitted_at: player.expFeedback?.submittedAt ?? "",
      slot: "end_of_game",
    });
  }
  // Stable, documented column order. New columns go at the end.
  const columns = [
    "game_id", "batch_id", "treatment", "sequence_id", "started_at", "ended_at",
    "player_id", "player_name", "player_ended", "slot",
    "round_index", "task_index", "task_version", "facilitation",
    "initial_choice", "initial_confidence", "initial_decision_submitted_at",
    "review_quiz_passed",
    "tlx_mental", "tlx_physical", "tlx_temporal", "tlx_performance", "tlx_effort", "tlx_frustration",
    "subjective_group_free_text", "subjective_group_contribution", "subjective_group_influence",
    "subjective_group_productive", "subjective_group_structured", "subjective_group_cohesion",
    "subjective_facilitator_freetext", "subjective_facilitator_sharing", "subjective_facilitator_distracting",
    "subjective_facilitator_synthesis", "subjective_facilitator_focus", "subjective_facilitator_need_fit",
    "subjective_facilitator_timing", "subjective_facilitator_option_push",
    "final_decision_choice", "final_decision_confidence", "final_decision_outcome", "final_decision_submitted_at",
    "first_task_carryover", "first_task_carryover_description", "facilitator_difference", "preferred_facilitator",
    "final_questions_submitted_at", "exp_feedback", "exp_feedback_submitted_at",
  ];
  const csv = toCsv(rows, columns);
  return { csv, columns, rowCount: rows.length };
}

export function renderTranscriptMd(bundle) {
  const { game, players, rounds, llmLog } = bundle;
  const lines = [];
  lines.push(`# Game ${game.id}`);
  lines.push("");
  lines.push(`- Treatment: ${game.treatment || "unknown"}`);
  lines.push(`- Sequence: ${game.sequenceId || "unknown"}`);
  lines.push(`- Started: ${game.startedAt || "unknown"}`);
  lines.push(`- Ended: ${game.endedAt || "(in progress)"}`);
  lines.push(`- Players: ${players.map((p) => p.name || p.id).join(", ")}`);
  lines.push(`- Total interventions: ${game.totalInterventions || 0}`);
  lines.push(`- Total fallbacks: ${game.totalFallbackMessages || 0}`);
  lines.push("");

  for (const round of rounds) {
    lines.push(`## Round ${round.index + 1} · Task ${round.taskIndex + 1} (version ${round.taskVersion || "?"}) · ${round.facilitation || "?"}`);
    lines.push("");
    const messages = collectRoundMessages(round, bundle, game);
    if (messages.length === 0) {
      lines.push("_No messages recorded for this round._");
      lines.push("");
      continue;
    }
    for (const m of messages) {
      lines.push(m);
      lines.push("");
    }
  }

  lines.push("---");
  lines.push("");
  lines.push(`## LLM audit log (${llmLog.length} entries)`);
  lines.push("");
  if (llmLog.length === 0) {
    lines.push("_No LLM audit entries._");
    lines.push("");
  } else {
    for (const e of llmLog) {
      lines.push(`### Entry ${e.auditRequestId || "(no id)"}`);
      lines.push("");
      lines.push(`- Outcome: \`${e.outcome || "unknown"}\``);
      if (e.role) lines.push(`- Role: \`${e.role}\``);
      if (e.reason) lines.push(`- Reason: ${e.reason}`);
      if (e.totalLatencyMs != null) lines.push(`- Latency: ${e.totalLatencyMs} ms`);
      if (e.auditCompletedAt) lines.push(`- Completed: ${e.auditCompletedAt}`);
      if (e.messageAdded != null) lines.push(`- Message added: ${e.messageAdded}`);
      if (e.requestSuccess != null) lines.push(`- Request success: ${e.requestSuccess}`);
      lines.push("");
    }
  }

  return lines.join("\n");
}

function collectRoundMessages(round, bundle, game) {
  const key = `chat_round_${round.index}`;
  const chat = game?.chat?.[key];
  if (!Array.isArray(chat)) return [];
  return chat.map((m) => {
    const senderId = m?.sender?.id || m?.senderId || m?.sender_id;
    const senderName = m?.sender?.name || m?.senderName || m?.sender_name || senderId || "unknown";
    const ts = formatTs(m?.ts || m?.timestamp);
    if (senderId === "ai" || senderName === "Facilitator") {
      return [
        `**[${ts}] Facilitator** (${m?.role || "auto"})`,
        m?.text ? `> ${m.text.replace(/\n+/g, "\n> ")}` : "_no message text_",
      ].join("\n");
    }
    return `**[${ts}] ${senderName}**: ${m?.text || ""}`;
  });
}

function scopeAttributes(scope) {
  // In production, an admin scope is
  //   {id, kind, attributes: {totalCount, pageInfo, edges: [{node: {key, val, ...}}]}}
  // — a Relay-style connection, NOT a flat array. Each attribute's
  // GraphQL field is named `val` (not `value`); the consumer parses
  // JSON-looking values. In tests the scope is pre-shaped with a flat
  // array of {key, val} so the same code path needs to handle both.
  // We accept both `val` and `value` for the in-test path so a
  // fixture with `{key, value}` continues to work.
  if (scope && scope.__attrs && typeof scope.__attrs === "object") return scope.__attrs;

  let attrEdges = null;
  if (scope && Array.isArray(scope.attributes)) {
    attrEdges = scope.attributes.map((n) => ({ node: n }));
  } else if (scope && scope.attributes && Array.isArray(scope.attributes.edges)) {
    attrEdges = scope.attributes.edges;
  }
  if (attrEdges) {
    const out = {};
    const scalarBest = {}; // key -> { version, current, value }
    for (const e of attrEdges) {
      const a = e && e.node;
      if (!a || typeof a.key !== "string") continue;
      const raw = a.val !== undefined ? a.val : a.value;
      if (a.index === undefined || a.index === null) {
        // Scalar. Tajriba returns every historical version of a key that
        // was set more than once, marking superseded records with
        // `deleted`/`deletedAt` and the live one with `current: true` /
        // the highest `version`. Resolve to that live value instead of
        // relying on edge order ("last wins"), which could keep a stale
        // version (e.g. totalInterventions reading "0" instead of "2").
        if (a.deleted === true || a.deletedAt != null) continue;
        const version = Number.isFinite(a.version) ? a.version : 0;
        const current = a.current === true;
        const best = scalarBest[a.key];
        if (!best || current || version >= best.version) {
          scalarBest[a.key] = { version, current, value: parseValue(raw) };
        }
      } else {
        out[`${a.key}:${a.index}`] = parseValue(raw);
      }
    }
    for (const [key, s] of Object.entries(scalarBest)) out[key] = s.value;
    return out;
  }
  return {};
}

function parseValue(value) {
  if (typeof value !== "string") return value;
  const trimmed = value.trim();
  if (trimmed.length === 0) return value;
  // Only attempt parse on things that look like JSON objects/arrays; leave
  // scalars (numbers, booleans, quoted strings) alone so the service does
  // not accidentally turn "1.05" into the number 1.05 and lose precision.
  const first = trimmed[0];
  if (first !== "{" && first !== "[" && first !== "\"") return value;
  try {
    return JSON.parse(trimmed);
  } catch {
    return value;
  }
}

function numberOrZero(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

function pickBool(value) {
  if (value === true || value === "true") return true;
  if (value === false || value === "false") return false;
  return null;
}

function formatTs(value) {
  if (!value) return "?";
  const ms = typeof value === "number" ? value : Date.parse(value);
  if (!Number.isFinite(ms)) return String(value);
  const d = new Date(ms);
  // ISO without the milliseconds and with the local time zone offset, so
  // the transcript is readable in the same time zone the researcher
  // recorded it in.
  return d.toISOString().replace(/\.\d{3}Z$/, "Z");
}

function paginate(items, { limit = 100, offset = 0 } = {}) {
  const safeLimit = Math.max(1, Math.min(1000, Number(limit) || 100));
  const safeOffset = Math.max(0, Number(offset) || 0);
  return {
    items: items.slice(safeOffset, safeOffset + safeLimit),
    total: items.length,
    limit: safeLimit,
    offset: safeOffset,
  };
}

function toCsv(rows, columns) {
  const header = columns.map(csvCell).join(",");
  const body = rows.map((row) => columns.map((c) => csvCell(row[c])).join(",")).join("\n");
  return body ? `${header}\n${body}\n` : `${header}\n`;
}

function csvCell(value) {
  if (value == null) return "";
  const s = typeof value === "string" ? value : JSON.stringify(value);
  if (/[",\r\n]/.test(s)) {
    return `"${s.replace(/"/g, '""')}"`;
  }
  return s;
}

export class ExportNotFoundError extends Error {
  constructor(message) {
    super(message);
    this.name = "ExportNotFoundError";
  }
}
