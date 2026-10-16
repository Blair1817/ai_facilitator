import React, { useCallback, useEffect, useRef, useState } from "react";
import { usePlayer, useRound, useStage } from "@empirica/core/player/classic/react";
import {
  beginPersonalPageRequest,
  FORMAL_INITIAL_DECISION_SECONDS,
  nextPersonalPageRequestAttempt,
  personalPages,
  personalProgressKey,
} from "../../shared/personalFlow.mjs";
import { Introduction } from "./intro-exit/Introduction";
import { ReviewQuiz } from "./stages/ReviewQuiz";
import { InitialDecision } from "./stages/InitialDecision";
import { IndividualAssessment } from "./stages/IndividualAssessment";
import { TLX } from "./intro-exit/TLX";
import { SubjectiveSurvey } from "./intro-exit/SubjectiveSurvey";
import { FinalQuestions } from "./intro-exit/FinalQuestions";
import { ExpFeedback } from "./intro-exit/ExpFeedback";
import { Debriefing } from "./intro-exit/Debriefing";
import { Break } from "./stages/Break";

const components = { TaskInformation: Introduction, ReviewQuiz, InitialDecision,
  IndividualAssessment, TLX, SubjectiveSurvey, FinalQuestions, ExpFeedback, Debriefing };

function personalPageRequestStorageKey(playerId, roundId, stageId, index, testVersion = 0) {
  return `personalPageRequest:${playerId}:${roundId}:${stageId}:${index}`
    + (testVersion > 0 ? `:test-version-${testVersion}` : "");
}

export function StudyComplete() {
  return <main className="flex h-full items-center justify-center p-8 text-center"><div>
    <h1 className="text-2xl font-bold">Your participation is complete</h1>
    <p className="mt-4">Thank you for taking part. You may now close this page.</p>
  </div></main>;
}

export function PersonalFlow() {
  const player = usePlayer(), round = useRound(), stage = useStage();
  const stageName = stage.get("name");
  const progress = player.round.get(personalProgressKey(stageName));
  const pages = personalPages(stageName, round.get("taskIndex"));
  // Server-owned cursor survives refresh and advances only after saving responses.
  return progress ? <PersonalPage key={`${stage.id}:${progress.index}:${player.round.get("testProgressVersion") || 0}`}
    {...{ player, round, stage, stageName, progress, pages }} /> : <p role="status">Loading your page…</p>;
}

function PersonalPage({ player, round, stage, stageName, progress, pages }) {
  const page = pages[progress.index];
  const pendingStorageKey = personalPageRequestStorageKey(
    player.id, round.id, stage.id, progress.index, player.round.get("testProgressVersion") || 0,
  );
  const [pending, setPending] = useState(() => {
    if (page !== "InitialDecision") return false;
    try {
      const stored = JSON.parse(globalThis.sessionStorage?.getItem(pendingStorageKey) || "null");
      return stored && typeof stored.requestId === "string" ? stored : false;
    } catch {
      return false;
    }
  });
  const pendingRef = useRef(pending || null);
  const [now, setNow] = useState(Date.now());
  const onNext = useCallback((details = {}) => {
    const { request, created } = beginPersonalPageRequest(
      pendingRef.current,
      details,
      () => globalThis.crypto?.randomUUID?.() ?? `${player.id}-${Date.now()}`,
    );
    if (!created) return;
    pendingRef.current = request;
    if (request.initialDecision) {
      try {
        globalThis.sessionStorage?.setItem(pendingStorageKey, JSON.stringify(request));
      } catch {
        // In-memory retries still protect the currently mounted page.
      }
    }
    setPending(request);
  }, [pendingStorageKey, player.id]);
  const deadline = page === "InitialDecision"
    ? progress.startedAt + FORMAL_INITIAL_DECISION_SECONDS * 1000
    : undefined;
  useEffect(() => {
    document.getElementById("participant-scroll-root")?.scrollTo(0, 0);
    window.scrollTo(0, 0);
  }, []);
  useEffect(() => {
    if (page !== "InitialDecision") return;
    const timer = setInterval(() => setNow(Date.now()), 250);
    return () => clearInterval(timer);
  }, [page]);
  useEffect(() => {
    if (page === "InitialDecision" && now >= deadline) onNext();
  }, [page, now, deadline, onNext]);
  useEffect(() => {
    const previousIndex = progress.index - 1;
    if (previousIndex < 0 || pages[previousIndex] !== "InitialDecision") return;
    const completedStorageKey = personalPageRequestStorageKey(
      player.id, round.id, stage.id, previousIndex, player.round.get("testProgressVersion") || 0,
    );
    try {
      globalThis.sessionStorage?.removeItem(completedStorageKey);
    } catch {
      // The authoritative cursor has advanced; stale storage is harmless.
    }
  }, [pages, player.id, progress.index, round.id, stage.id]);
  useEffect(() => {
    if (!pending || !page) return;
    const send = () => {
      const attempt = nextPersonalPageRequestAttempt(pendingRef.current, {
        roundId: round.id,
        stageId: stage.id,
        index: progress.index,
      });
      pendingRef.current = attempt.pending;
      if (attempt.pending.initialDecision) {
        try {
          globalThis.sessionStorage?.setItem(
            pendingStorageKey, JSON.stringify(attempt.pending),
          );
        } catch {
          // In-memory retries still protect the currently mounted page.
        }
      }
      player.set("personalPageRequest", { ...attempt.transmission, version: player.round.get("testProgressVersion") || 0 });
    };
    send();
    // A dropped request or response write arriving later must not strand the page.
    const retry = setInterval(send, 2000);
    return () => clearInterval(retry);
  }, [pending, pendingStorageKey, player, round.id, stage.id, progress.index, page]);

  if (!page) {
    if (stageName === "Followup" && round.get("taskIndex") === 1) return <StudyComplete />;
    return <main className="flex h-full items-center justify-center p-8 text-center"><div>
      <h1 className="text-xl font-bold">You are ready</h1>
      <p className="mt-4">{stageName === "Preparation"
        ? "The group discussion will start when all three participants are ready."
        : "The next task will start when all three participants are ready."}</p>
    </div></main>;
  }
  if (page === "Break") return <Break progress={progress} />;
  const Component = components[page];
  const outcome = round.get("finalDecisionOutcome");
  const showDecisionNotice = stageName === "Followup"
    && ((outcome === "consensus_choice" && page === "TLX")
      || (["declared_fail", "timeout_fail"].includes(outcome) && page === "IndividualAssessment"));
  return <div className="relative h-full">
    {showDecisionNotice && <p role="status" className={`mx-auto mt-4 max-w-3xl rounded-md p-4 text-sm font-semibold ${outcome === "timeout_fail" ? "bg-amber-50 text-amber-900" : "bg-green-50 text-green-800"}`}>
      {outcome === "timeout_fail"
        ? "Time is up. Your group did not confirm a final decision."
        : "Your group decision has been submitted."}
    </p>}
    <Component onNext={onNext} next={onNext} deadline={deadline} />
    {pending && <div role="status" className="absolute inset-0 flex items-center justify-center bg-white/90">Saving your responses…</div>}
  </div>;
}
