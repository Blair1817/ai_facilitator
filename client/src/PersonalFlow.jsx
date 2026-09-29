import React, { useCallback, useEffect, useState } from "react";
import { usePlayer, useRound, useStage } from "@empirica/core/player/classic/react";
import { personalPages, personalProgressKey } from "../../shared/personalFlow.mjs";
import { Introduction } from "./intro-exit/Introduction";
import { ReviewQuiz } from "./stages/ReviewQuiz";
import { InitialDecision } from "./stages/InitialDecision";
import { IndividualAssessment } from "./stages/IndividualAssessment";
import { TLX } from "./intro-exit/TLX";
import { SubjectiveSurvey } from "./intro-exit/SubjectiveSurvey";
import { FinalQuestions } from "./intro-exit/FinalQuestions";
import { ExpFeedback } from "./intro-exit/ExpFeedback";
import { Debriefing } from "./intro-exit/Debriefing";
import { Timer } from "./components/Timer";

const components = { TaskInformation: Introduction, ReviewQuiz, InitialDecision,
  IndividualAssessment, TLX, SubjectiveSurvey, FinalQuestions, ExpFeedback, Debriefing };

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
  return progress ? <PersonalPage key={`${stage.id}:${progress.index}`}
    {...{ player, round, stage, stageName, progress, pages }} /> : <p role="status">Loading your page…</p>;
}

function PersonalPage({ player, round, stage, stageName, progress, pages }) {
  const [pending, setPending] = useState(false);
  const [skipBreak, setSkipBreak] = useState(false);
  const [now, setNow] = useState(Date.now());
  const onNext = useCallback(() => setPending(true), []);
  const onSkip = useCallback(() => { setSkipBreak(true); setPending(true); }, []);
  const page = pages[progress.index];
  const deadline = progress.startedAt + (page === "InitialDecision" ? 180000 : 300000);
  useEffect(() => {
    document.getElementById("participant-scroll-root")?.scrollTo(0, 0);
    window.scrollTo(0, 0);
  }, []);
  useEffect(() => {
    if (!["InitialDecision", "Break"].includes(page)) return;
    const timer = setInterval(() => setNow(Date.now()), 250);
    return () => clearInterval(timer);
  }, [page]);
  useEffect(() => {
    if (page === "InitialDecision" && now >= deadline) onNext();
  }, [page, now, deadline, onNext]);
  useEffect(() => {
    if (!pending || !page) return;
    const send = () => player.set("personalPageRequest", {
      requestId: crypto.randomUUID(), roundId: round.id, stageId: stage.id, index: progress.index,
      skipBreak: page === "Break" && skipBreak,
    });
    send();
    // A dropped request or response write arriving later must not strand the page.
    const retry = setInterval(send, 2000);
    return () => clearInterval(retry);
  }, [pending, player, round.id, stage.id, progress.index, page, skipBreak]);

  if (!page) {
    if (stageName === "Followup" && round.get("taskIndex") === 1) return <StudyComplete />;
    return <main className="flex h-full items-center justify-center p-8 text-center"><div>
      <h1 className="text-xl font-bold">You are ready</h1>
      <p className="mt-4">{stageName === "Preparation"
        ? "The group discussion will start when all three participants are ready."
        : "The next task will start when all three participants are ready."}</p>
    </div></main>;
  }
  if (page === "Break") return <main className="relative flex h-full items-center justify-center p-8 text-center"><div>
    <h1 className="text-2xl font-bold">Break</h1>
    <p className="my-4">Take a five-minute break, then confirm you are ready for the next task.</p>
    <Timer deadline={deadline} />
    <button className="mt-6 rounded bg-blue-700 px-5 py-3 text-white disabled:opacity-50"
      disabled={now < deadline || pending} onClick={onNext}>I’m back and ready to continue</button>
    {/* Deliberately discreet early-skip: a small faint chevron in the corner.
        Clicking it ends this participant's own break early (server records
        breakSkippedAt). Other participants and the group gate are unaffected. */}
    <button type="button" onClick={onSkip} disabled={pending}
      aria-label="Skip the rest of the break" title="Skip"
      className="absolute bottom-3 right-4 select-none text-gray-400 hover:text-gray-600 focus-visible:text-gray-600"
      style={{ fontSize: "13px", lineHeight: 1, opacity: 0.45 }}>&rsaquo;</button>
  </div></main>;
  const Component = components[page];
  return <div className="relative h-full">
    <Component onNext={onNext} next={onNext} deadline={deadline} />
    {pending && <div role="status" className="absolute inset-0 flex items-center justify-center bg-white/90">Saving your responses…</div>}
  </div>;
}
