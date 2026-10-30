import { randomUUID } from "node:crypto";
import { appendToAttribute } from "./AppendOnlyAttribute.mjs";
import { CHECKPOINT_DEFAULTS, containsFacilitatorMention } from "./CheckpointManager.mjs";

export const STATIC_OPPORTUNITY_KEY = "staticInterventionOpportunity";
export const STATIC_REQUEST_RESUMPTION_KEY = "staticRequestResumption";
export const STATIC_MAX_ATTEMPTS = 3;
const terminal = state => !state || ["PUBLISHED", "CANCELLED"].includes(state.status);
const human = m => m?.sender?.id !== "ai" && (m.stage ?? "Discussion") === "Discussion"
  && (m.messageType ?? "human") === "human" && (m.speakerType ?? "human") === "human";

// Durable state lives on the existing Round; only the one-shot wake-up lives
// in memory. The deployment must have one callbacks writer per Tajriba store.
// This is deliberately not a distributed lease/CAS implementation.
export function createStaticInterventionScheduler({ run, instanceId, flush = () => {}, onError = () => {},
  onPublicationRecovered = () => {},
  hasRequestedResponse = () => false, now = () => Date.now(),
  setTimer = (...args) => setTimeout(...args), clearTimer = timer => clearTimeout(timer) }) {
  const entries = new Map();
  const chat = game => game.get(`chat_round_${game.currentRound?.get("taskIndex")}`) || [];
  const current = e => e.game.currentRound?.id === e.round.id && e.game.currentStage?.id === e.stage.id
    && e.round.get("facilitation") === "static" && !e.round.get("isPractice") && !e.round.get("ended")
    && e.stage.get("name") === "Task" && !e.stage.get("ended") && !e.game.get("ended") && !e.game.get("endedAt")
    && Number.isFinite(e.game.get("deadline")) && now() < e.game.get("deadline");
  const read = e => e.round.get(STATIC_OPPORTUNITY_KEY);
  function save(e, state, reasonCode, extra = {}) {
    const next = { ...state, ...extra, reasonCode, updatedAt: now(), eventSequence: (state.eventSequence || 0) + 1 };
    if (terminal(next)) next.failureFeedback = [];
    e.round.set(STATIC_OPPORTUNITY_KEY, next);
    appendToAttribute(e.round, "staticInterventionEvents", {
      id: `${next.opportunityId}:${next.eventSequence}`, sessionId: e.game.id, phaseId: e.stage.id,
      roundId: e.round.id, opportunityId: next.opportunityId, attemptId: next.attemptId ?? null,
      trigger: next.trigger, status: next.status, reasonCode, timestamp: now(),
      messageCount: e.game.get("humanMessageCount") || 0, retryCount: Math.max(0, next.attemptCount - 1),
      notBefore: next.notBefore ?? null, waitingAfterHumanCount: next.waitingAfterHumanCount ?? null,
      publishedMessageId: next.publishedMessageId ?? null,
      lastAttemptReason: next.lastAttemptReason ?? null,
    });
    return next;
  }
  function cancel(game, reasonCode = "PHASE_ENDED") {
    const e = entries.get(game.id);
    if (reasonCode === "PHASE_ENDED") {
      const round = e?.round ?? game.currentRound;
      if (round?.get(STATIC_REQUEST_RESUMPTION_KEY)) round.set(STATIC_REQUEST_RESUMPTION_KEY, null);
    }
    if (!e) return;
    clearTimer(e.timer); e.timer = null;
    const state = read(e);
    if (!terminal(state)) save(e, state, reasonCode, { status: "CANCELLED", closedAtHumanCount: game.get("humanMessageCount") || 0 });
    // Opportunity cancellation must not erase a round-level request barrier.
    // Keep its phase registration so a later phase/round change can clear it.
    if (reasonCode === "PHASE_ENDED" || !e.round.get(STATIC_REQUEST_RESUMPTION_KEY)) entries.delete(game.id);
    Promise.resolve(flush()).catch(onError);
  }
  function register(game) {
    const old = entries.get(game.id), round = game.currentRound, stage = game.currentStage;
    if (old && (old.round.id !== round?.id || old.stage.id !== stage?.id)) cancel(game);
    if (!round || !stage || round.get("facilitation") !== "static" || round.get("isPractice") || stage.get("name") !== "Task") {
      if (round?.get(STATIC_REQUEST_RESUMPTION_KEY)) round.set(STATIC_REQUEST_RESUMPTION_KEY, null);
      return null;
    }
    let e = entries.get(game.id);
    if (!e) { e = { game, round, stage, timer: null, busy: false }; entries.set(game.id, e); }
    if (!current(e)) { cancel(game); return null; }
    let state = read(e);
    // Reconcile the authoritative transcript before retrying after a crash
    // between append and the terminal opportunity write.
    const committed = state && chat(game).find(m => m.opportunityId === state.opportunityId
      || m.messageId === `facilitator-${state.opportunityId}`);
    if (committed) onPublicationRecovered(game, committed);
    if (committed && state.status !== "PUBLISHED") state = save(e, state, "PUBLISHED", {
      status: "PUBLISHED", publishedMessageId: committed.messageId,
    });
    // Recover even when the old opportunity is terminal or absent. The latest
    // published reply, not a delayed callback for an older reply, owns the wait.
    if (syncRequestResumption(e) && !terminal(state)) state = save(e, state, "REQUEST_SUPERSEDED");
    discussionResumed(e); // Satisfaction is round-scoped, even before a new opportunity is eligible.
    if (!terminal(state) && state.ownerInstanceId && state.ownerInstanceId !== instanceId) {
      state = save(e, state, "RETRY_SCHEDULED", { status: "PENDING", ownerInstanceId: instanceId });
    }
    return e;
  }
  function syncRequestResumption(e) {
    let barrier = e.round.get(STATIC_REQUEST_RESUMPTION_KEY);
    if (barrier && barrier.stageId !== e.stage.id) {
      e.round.set(STATIC_REQUEST_RESUMPTION_KEY, null); barrier = null;
    }
    const transcript = chat(e.game);
    const startedAt = e.round.get("TaskStartedAt") ?? e.game.get("taskStartTime");
    const index = transcript.findLastIndex(m => m.facilitatorTrigger === "PARTICIPANT_REQUEST"
      && m.sender?.id === "ai" && (m.stage ?? "Discussion") === "Discussion"
      && !(Number.isFinite(startedAt) && Number.isFinite(m.timestamp ?? m.ts) && (m.timestamp ?? m.ts) < startedAt));
    if (index < 0 || barrier?.messageId === transcript[index].messageId) return false;
    e.round.set(STATIC_REQUEST_RESUMPTION_KEY, {
      stageId: e.stage.id, publicBoundary: index + 1,
      messageId: transcript[index].messageId, satisfied: false,
    });
    return true;
  }
  function discussionResumed(e) {
    const barrier = e.round.get(STATIC_REQUEST_RESUMPTION_KEY);
    if (!barrier || barrier.satisfied) return true;
    const messages = chat(e.game).slice(barrier.publicBoundary).filter(m => human(m)
      && typeof m.sender?.id === "string" && m.sender.id.length > 0
      && String(m.text ?? m.content ?? "").trim()
      && !containsFacilitatorMention(m.text ?? m.content));
    if (new Set(messages.map(m => m.sender.id)).size < 2) return false;
    // Retain the reply cursor after satisfaction so replay/recovery cannot
    // reinstate an old wait. A newer published reply replaces it; phase end
    // clears it. This record never contains an opportunity's failure feedback.
    e.round.set(STATIC_REQUEST_RESUMPTION_KEY, { ...barrier, satisfied: true, satisfiedAt: now() });
    return true;
  }
  function requestBlocksAutomatic(e) {
    return hasRequestedResponse(e.game) || !discussionResumed(e);
  }
  function eligibility(e, state) {
    if (!current(e)) return "PHASE_ENDED";
    if (terminal(state)) return "DUPLICATE_SUPPRESSED";
    if (state.attemptCount >= STATIC_MAX_ATTEMPTS) return "RETRY_EXHAUSTED";
    if (requestBlocksAutomatic(e)) return "REQUEST_SUPERSEDED";
    if (state.waitingAfterHumanCount != null && (e.game.get("humanMessageCount") || 0) <= state.waitingAfterHumanCount) return "VALIDATION_REJECTED";
    if ((e.game.get("messagesSinceLastPublish") || 0) < CHECKPOINT_DEFAULTS.messagesBetweenInterventions) return "DUPLICATE_SUPPRESSED";
    if (e.game.get("deadline") - now() <= CHECKPOINT_DEFAULTS.minTimeForInterventionMs) return "TIME_FLOOR";
    if (now() < cooldownUntil(e.game, state)) return "COOLDOWN_ACTIVE";
    if (Object.values(e.game.get("llmInFlight") || {}).some(x => x.exclusiveGroup === "AUTOMATIC_INTERVENTION")) return "LOCK_BUSY";
    return null;
  }
  function cooldownUntil(game, state) {
    const attemptedAt = game.get("lastAttemptTimestamp") || 0;
    return Math.max(state.notBefore || 0, attemptedAt > 0 ? attemptedAt + CHECKPOINT_DEFAULTS.cooldownMs : 0);
  }
  function schedule(e, due) {
    clearTimer(e.timer);
    e.timer = setTimer(() => { e.timer = null; void tick(e).catch(onError); }, Math.max(0, due - now()));
    e.timer?.unref?.();
  }
  function wake(game) {
    const e = register(game);
    if (!e) return;
    const state = read(e);
    clearTimer(e.timer); e.timer = null;
    if (terminal(state)) return;
    // In-flight work and context/request waits are awakened by completion
    // or participant events, not lock polling. Retain one expiry timer.
    if (e.busy || ["GENERATING", "VALIDATING", "READY_TO_PUBLISH"].includes(state.status)) {
      schedule(e, game.get("deadline")); return;
    }
    const reason = eligibility(e, state);
    if (["PHASE_ENDED", "TIME_FLOOR", "RETRY_EXHAUSTED", "DUPLICATE_SUPPRESSED"].includes(reason)) { cancel(game, reason); return; }
    const due = reason === "COOLDOWN_ACTIVE"
      ? cooldownUntil(game, state)
      : reason ? game.get("deadline") : now();
    schedule(e, Math.min(due, game.get("deadline")));
  }
  async function tick(e) {
    if (entries.get(e.game.id) !== e) return;
    if (!current(e)) { cancel(e.game); return; }
    const state = read(e), reason = eligibility(e, state);
    if (e.busy || reason) { wake(e.game); return; }
    e.busy = true;
    try { await run(e.game, { opportunityId: state.opportunityId }); }
    catch (error) { onError(error); complete(e.game, { opportunityId: state.opportunityId, attemptId: read(e)?.attemptId, reasonCode: "API_ERROR" }); }
    finally { e.busy = false; wake(e.game); await flush(); }
  }
  function observe(game, { schedule: shouldSchedule = false } = {}) {
    const e = register(game);
    if (!e) return null;
    let state = read(e);
    const count = game.get("humanMessageCount") || 0;
    if (terminal(state)) {
      // A new human checkpoint can replace an exhausted opportunity, but a
      // timer/replayed callback cannot restart its request budget.
      if ((game.get("messagesSinceLastPublish") || 0) < CHECKPOINT_DEFAULTS.messagesBetweenInterventions
        || (state && count <= (state.closedAtHumanCount ?? state.latestHumanMessageCount))) return state;
      state = save(e, { opportunityId: `static:${randomUUID()}`, trigger: "message", status: "PENDING",
        createdAt: now(), createdPublicBoundary: chat(game).length,
        attemptCount: 0, latestHumanMessageCount: count, ownerInstanceId: instanceId, failureFeedback: [] }, "PENDING");
    } else if (state.latestHumanMessageCount !== count) {
      state = { ...state, latestHumanMessageCount: count };
      e.round.set(STATIC_OPPORTUNITY_KEY, state);
    }
    if (shouldSchedule) wake(game);
    return state;
  }
  function ready(game, opportunityId) {
    const e = register(game), state = e && read(e);
    return !!e && state?.opportunityId === opportunityId && state.status === "PENDING" && !eligibility(e, state);
  }
  function decorate(game, entry) {
    const e = register(game), state = e && read(e);
    if (terminal(state)) return false;
    Object.assign(entry, { opportunityId: state.opportunityId, attemptId: `${state.opportunityId}:${state.attemptCount + 1}`,
      retryCount: state.attemptCount, sessionId: game.id, phaseId: e.stage.id });
    return true;
  }
  function started(game, entry) {
    const e = register(game), state = e && read(e);
    if (!e || terminal(state) || state.opportunityId !== entry.opportunityId || state.status !== "PENDING") return false;
    if (requestBlocksAutomatic(e)) return false;
    save(e, state, "GENERATING", { status: "GENERATING", attemptCount: state.attemptCount + 1,
      attemptId: entry.attemptId, ownerInstanceId: instanceId, waitingAfterHumanCount: null,
      notBefore: now() + CHECKPOINT_DEFAULTS.cooldownMs });
    wake(game); return true;
  }
  function progress(game, entry, status) {
    const e = register(game), state = e && read(e);
    if (terminal(state) || state.opportunityId !== entry.opportunityId || state.attemptId !== entry.attemptId) return;
    save(e, state, status, { status });
  }
  function canCommit(game, entry) {
    const e = register(game), state = e && read(e);
    return !!e && !terminal(state) && state.opportunityId === entry.opportunityId && state.attemptId === entry.attemptId
      && !requestBlocksAutomatic(e);
  }
  function published(game, entry) {
    const e = register(game), state = e && read(e);
    if (!e || !state || state.opportunityId !== entry.opportunityId) return;
    if (state.status !== "PUBLISHED") save(e, state, "PUBLISHED", { status: "PUBLISHED", publishedMessageId: entry.publishedMessageId });
    clearTimer(e.timer); e.timer = null;
  }
  function requestedPublished(game) {
    // register synchronizes the latest canonical reply even if there is no
    // pending opportunity. Requested replies themselves never use this gate.
    register(game);
  }
  function failureFeedback(game, entry) {
    const e = register(game), state = e && read(e);
    return !terminal(state) && state.opportunityId === entry.opportunityId
      ? structuredClone(state.failureFeedback || []) : [];
  }
  function complete(game, entry) {
    const e = register(game), state = e && read(e);
    if (terminal(state) || state.opportunityId !== entry.opportunityId || state.attemptId !== entry.attemptId) return;
    if (entry.messageAdded) { published(game, entry); return; }
    const reason = entry.reasonCode || (entry.failureStage === "generator_api" || entry.failureStage === "validator_unavailable" ? "API_ERROR" : "VALIDATION_REJECTED");
    entry.reasonCode = reason;
    if (reason === "PHASE_ENDED" || state.attemptCount >= STATIC_MAX_ATTEMPTS) {
      save(e, state, reason === "PHASE_ENDED" ? reason : "RETRY_EXHAUSTED", { status: "CANCELLED", closedAtHumanCount: game.get("humanMessageCount") || 0 });
    } else {
      // Keep real content failures (including a failure before a later API
      // error), but never label an interrupted/cancelled draft as invalid.
      // At most two Generator outputs per pipeline and three pipelines per
      // opportunity; retaining six records therefore preserves the full budget.
      const failures = ["PHASE_ENDED", "REQUEST_SUPERSEDED", "STALE_CONTEXT"].includes(reason)
        ? [] : entry.staticContentFailures || [];
      const history = new Map([...(state.failureFeedback || []), ...failures].map(failure =>
        [`${failure.attemptId}:${failure.generationAttempt}:${failure.stage}`, failure]));
      save(e, state, "RETRY_SCHEDULED", { status: "PENDING", lastAttemptReason: reason,
        failureFeedback: [...history.values()].slice(-STATIC_MAX_ATTEMPTS * 2),
        waitingAfterHumanCount: reason === "VALIDATION_REJECTED" ? game.get("humanMessageCount") || 0 : null });
    }
    wake(game);
    entry.opportunityStatus = read(e).status;
    entry.retryScheduled = entry.opportunityStatus === "PENDING";
  }
  function defer(game, reasonCode) {
    const e = register(game), state = e && read(e);
    if (!terminal(state) && state.status === "PENDING" && state.reasonCode !== reasonCode) save(e, state, reasonCode);
    wake(game);
  }
  function blockReason(game) {
    const e = register(game);
    return e ? eligibility(e, read(e)) : "PHASE_ENDED";
  }
  return { register, observe, ready, decorate, started, progress, canCommit, published, requestedPublished, failureFeedback, complete, defer, wake, cancel, blockReason };
}
