import React, { useEffect, useRef, useState } from "react";
import { useGame, usePlayer, usePlayers, useRound, useStage } from "@empirica/core/player/classic/react";
import { Button as SharedButton } from "../components/Button";
import { PlayerSpecificInfo } from "../components/PlayerSpecificInfo";
import { ConfidenceSlider, OptionChoice } from "../components/DecisionControls";
import { Chat } from "../components/CustomChat";
import { PlayerList } from "../components/PlayerList";
import { draftKey, usePersistentDraft } from "../hooks/usePersistentDraft";
import { PRACTICE, PRACTICE_CHAT, PRACTICE_PERSONAL_PAGES, practiceReadiness } from "../../../shared/practice.mjs";

function Button(props) {
  return <SharedButton {...props} className="ml-0 bg-blue-700 text-white hover:bg-blue-800" />;
}

function Identity({ player }) {
  return <p className="rounded-lg border border-gray-200 bg-white px-4 py-3 font-semibold text-gray-600">You are <span style={{ color: "#" + player.get("hexCode") }}>{player.get("name")}</span></p>;
}
function Callout({ title, children }) {
  return <aside className="mb-4 rounded-lg border border-blue-200 bg-blue-50 p-4 text-sm leading-6 text-blue-950"><strong className="block">{title}</strong>{children}</aside>;
}
function GroupProgress({ players, progress, pending = "Reading…" }) {
  return <ul className="my-4 flex flex-wrap gap-4 text-sm" aria-live="polite">
    {players.map((p) => <li key={p.id}><strong style={{ color: "#" + p.get("hexCode") }}>{p.get("name")}</strong> · {progress[p.id] ? "Ready ✓" : pending}</li>)}
  </ul>;
}

export function PracticeOnboarding() {
  const game = useGame(), player = usePlayer(), players = usePlayers(), round = useRound(), stage = useStage();
  const pageIndex = player.round.get("practicePageIndex") || 0;
  const name = stage.get("name") === "PracticeWelcome"
    ? PRACTICE_PERSONAL_PAGES[Math.min(pageIndex, PRACTICE_PERSONAL_PAGES.length - 1)] : stage.get("name");
  const config = round.get("practiceConfig") || PRACTICE;
  const [now, setNow] = useState(Date.now());
  const [pending, setPending] = useState(false);
  const done = Boolean(player.stage.get("practiceDone"));
  const request = (action, fields = {}) => player.set("practiceRequest", {
    action, page: name, roundId: round.id, stageId: stage.id, requestId: crypto.randomUUID(), ...fields,
  });
  useEffect(() => {
    setPending(false);
    document.getElementById("participant-scroll-root")?.scrollTo(0, 0);
  }, [name]);
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 500);
    return () => clearInterval(timer);
  }, []);
  // Release the click guard after acknowledgement, or permit a retry after a dropped connection.
  useEffect(() => {
    if (!pending) return;
    const timer = setTimeout(() => setPending(false), 2000);
    return () => clearTimeout(timer);
  }, [pending, done]);
  const next = (fields = {}) => {
    if (pending || done) return;
    setPending(true);
    request("continue", fields);
  };
  const choiceKey = draftKey({ playerId: player.id, roundId: round.id, form: "practiceInitial", field: "choice" });
  const confidenceKey = draftKey({ playerId: player.id, roundId: round.id, form: "practiceInitial", field: "confidence" });
  const saved = player.round.get("initialDecision");
  const [choice, setChoice] = usePersistentDraft(choiceKey, saved?.choice ?? "");
  const [confidence, setConfidence] = usePersistentDraft(confidenceKey, saved?.confidence ?? null);
  const progress = stage.get("practiceProgress") || {};

  if (name === "PracticeDiscussion" || name === "PracticeDiscussionTutorial") {
    return <PracticeDiscussion {...{ game, player, players, round, stage, now, config, request, next, done, pending, progress }} tutorial={name === "PracticeDiscussionTutorial"} />;
  }
  if (name === "PracticeReading" || name === "PracticeInitialChoice") {
    const reading = name === "PracticeReading";
    return <div className="h-full w-full overflow-y-auto bg-gray-50 p-4 sm:p-6">
      <div className="mx-auto grid min-h-full w-full max-w-7xl gap-6 lg:grid-cols-[minmax(0,3fr)_minmax(20rem,2fr)]">
        <div>
          {reading && <Callout title="Your task information appears here.">Some information may be different from what other group members see.</Callout>}
          <PlayerSpecificInfo className="h-[65vh] lg:h-[calc(100vh-10rem)]" />
        </div>
        <div className="min-w-0 self-start space-y-4">
          <Identity player={player} />
          <section className="rounded-lg border border-gray-200 bg-white p-6 shadow-sm">
            {reading ? <>
              <h1 className="text-2xl font-bold">Read your task information</h1>
              <p className="mt-4">Read the information above. Click <strong>Ready</strong> when you are ready to continue.</p>
              {!done && now - (player.round.get("practicePageStartedAt") || stage.get("practiceStartedAt")) >= config.readingReminderSeconds * 1000 && <p className="mt-4 text-sm text-gray-600">Take your time. Click Ready when you have finished reading.</p>}
              {done ? <p role="status">Waiting for the other group members…</p> : <Button disabled={pending} handleClick={() => next()}>Ready</Button>}
            </> : <>
              <Callout title="Make your initial choice">Choose the option that currently looks best based only on the information available to you.</Callout>
              {done ? <p role="status">Choice submitted. Waiting for the other group members.</p> : <form onSubmit={(e) => { e.preventDefault(); if (choice && confidence !== null) next({ choice, confidence }); }}>
                <OptionChoice legend="Which room would you currently choose?" options={round.get("decisionOptions") || []} value={choice} onChange={setChoice} name="practiceInitialChoice" />
                <ConfidenceSlider label="How confident are you in your current choice?" value={confidence} onChange={setConfidence} name="practiceInitialConfidence" />
                <p className="my-4 text-sm text-gray-600">Your initial choice and confidence are private.</p>
                <Button type="submit" disabled={pending || !choice || confidence === null}>Submit initial choice</Button>
              </form>}
            </>}
          </section>
        </div>
      </div>
    </div>;
  }
  const complete = name === "PracticeComplete";
  // Welcome page doubles as the icebreaker: while waiting for everyone to
  // start, participants greet each other in the chat (facilitator opens
  // with a fixed message). Chat is read-only once this participant moves on.
  const welcomeIcebreaker = name === "PracticeWelcome";
  if (welcomeIcebreaker) {
    return <div className="flex h-full w-full overflow-hidden bg-gray-50">
      <div className="flex min-w-0 flex-1 items-center justify-center overflow-y-auto px-4 py-8">
        <main className="w-full max-w-xl space-y-6 rounded-lg border border-gray-200 bg-white p-8 shadow-sm">
          <p className="text-sm font-semibold uppercase tracking-wide text-blue-700">Before the main tasks</p>
          <h1 className="text-3xl font-bold text-gray-900">Practice Round</h1>
          <p>Before the main tasks, you will complete a short practice activity with your group. This will show you how to use the task information, group chat, and decision interface.</p>
          <Identity player={player} />
          <p>Other group members will appear using colour nicknames.</p>
          <p className="rounded-lg bg-blue-50 p-4 text-sm text-blue-950">The facilitator has started a conversation in the chat — say hello to your group while everyone gets ready.</p>
          {done ? <p role="status">Waiting for the other group members…</p> : <Button disabled={pending} handleClick={() => next()}>Start practice</Button>}
        </main>
      </div>
      <div className="flex h-full min-w-0 w-2/5 flex-col border-l border-gray-200">
        <div className="w-full flex-none px-4 pt-3"><PlayerList /></div>
        <div className="min-h-0 w-full flex-1 overflow-hidden px-2">
          <Chat scope={game} attribute={PRACTICE_CHAT} disabled={done} />
        </div>
      </div>
    </div>;
  }
  return <div className="flex min-h-full items-center justify-center bg-gray-50 px-4 py-8">
    <main className="w-full max-w-2xl space-y-6 rounded-lg border border-gray-200 bg-white p-8 shadow-sm">
      <p className="text-sm font-semibold uppercase tracking-wide text-blue-700">Before the main tasks</p>
      <h1 className="text-3xl font-bold text-gray-900">{complete ? "Practice complete" : "Practice Round"}</h1>
      {complete ? <>
        <p>You have now practised reading your task information, making an initial choice, chatting with your group, and reaching a group decision.</p>
        <p>The main tasks follow the same general process, but contain more information and allow more time for discussion.</p>
      </> : null}
      {done ? <p role="status">Waiting for the other group members…</p> : <Button disabled={pending} handleClick={() => next()}>{complete ? "Continue" : "Start practice"}</Button>}
    </main>
  </div>;
}

function PracticeDiscussion({ game, player, players, round, stage, now, config, request, next, done, pending, progress, tutorial }) {
  const deadline = round.get("practiceDeadline");
  const startedAt = round.get("practiceDiscussionStartedAt");
  const remaining = Number.isFinite(deadline) ? Math.max(0, Math.ceil((deadline - now) / 1000)) : null;
  const forced = !tutorial && remaining !== null && remaining <= config.forceTimerSeconds;
  const visible = forced || player.round.get("practiceTimerVisible") === true;
  const ready = round.get("practiceReady") || {};
  const eligible = !tutorial && remaining > 0 && practiceReadiness({
    startedAt, now, counts: round.get("practiceMessageCounts") || {},
    participantIds: players.map((p) => p.id), config,
  });
  const forcedSent = useRef(false);
  useEffect(() => {
    if (forced && !forcedSent.current && !player.round.get("practiceTimerForced")) {
      forcedSent.current = true;
      request("timer_forced_visible");
    }
  }, [forced]);
  useEffect(() => {
    if (tutorial || remaining !== 0) return;
    // Retries recover a deadline missed during a callbacks restart, without moving the client itself.
    request("deadline");
    const timer = setInterval(() => request("deadline"), 2000);
    return () => clearInterval(timer);
  }, [tutorial, remaining === 0]);
  const clock = remaining === null ? "--:--" : `${String(Math.floor(remaining / 60)).padStart(2, "0")}:${String(remaining % 60).padStart(2, "0")}`;
  return <div className="relative h-full w-full overflow-x-auto">
    <div className="flex h-full min-h-0 min-w-[960px]">
      <div className="flex h-full min-h-0 min-w-0 w-3/5 flex-col border-r border-gray-200 px-4 py-3">
        <div className="mb-3 flex-none space-y-3">
          <Identity player={player} />
          {!tutorial && <div className="rounded-lg border border-gray-200 bg-white p-4">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <strong>{remaining === 0 ? "Discussion time has ended. Please submit your group’s choice." : "Discussion in progress"}</strong>
              {visible && <span className="text-2xl font-semibold tabular-nums">{clock} remaining</span>}
              {!forced && <button className="rounded border border-gray-300 px-3 py-2 text-sm" onClick={() => request(visible ? "timer_hidden" : "timer_opened")}>{visible ? "Hide timer" : "Show timer"}</button>}
            </div>
            {forced && remaining > 0 && <p className="mt-2 text-sm text-gray-600">Please start bringing your discussion to a conclusion.</p>}
          </div>}
          <h1 className="text-center text-lg font-bold">Compare the rooms with your group.</h1>
        </div>
        <PlayerSpecificInfo mode="compact" className="min-h-0 flex-1" />
        {eligible && <section className="mt-4 flex-none border-t border-gray-200 pt-4">
          <h2 className="font-semibold">Ready to decide?</h2>
          <p className="text-sm text-gray-600">If your group has finished discussing the options, indicate that you are ready to make a decision.</p>
          <GroupProgress players={players} progress={ready} pending="Discussing…" />
          <Button handleClick={() => request("ready", { ready: !ready[player.id] })}>{ready[player.id] ? "Not ready yet" : "I'm ready"}</Button>
        </section>}
      </div>
      <div className="flex h-full min-h-0 min-w-0 w-2/5 flex-col">
        <div className="w-full flex-none px-4 pt-3"><PlayerList /></div>
        <div className="min-h-0 w-full flex-1 overflow-hidden px-2">
          {tutorial ? <div className="flex h-full flex-col justify-end p-4">
            <Callout title="Type your messages here.">Use the message box below the conversation.</Callout>
            <div className="rounded-md border border-gray-300 p-4 text-gray-400">Write a message…</div>
          </div> : <Chat scope={game} attribute={PRACTICE_CHAT} disabled={remaining === 0} />}
        </div>
        {!player.round.get("practiceMentionUsed") && <p className="flex-none px-4 py-2 text-sm text-gray-500">Tip: Type <strong>@</strong> to tag another group member.</p>}
      </div>
    </div>
    {tutorial && <div className="absolute inset-0 z-20 flex items-center justify-center bg-gray-900/40 p-6">
      <section role="dialog" aria-modal="true" aria-labelledby="practice-chat-title" className="w-full max-w-lg rounded-xl bg-white p-8 shadow-xl">
        <h1 id="practice-chat-title" className="text-2xl font-bold">Group Discussion</h1>
        <p className="my-4">Use the chat to compare the options and reach a group decision.</p>
        <Callout title="Type your messages here.">The message box is at the bottom of the chat panel on the right.</Callout>
        <Callout title="Type @ to tag another group member.">Select their colour nickname from the suggestions.</Callout>
        <p className="mb-4 text-sm text-gray-600">The discussion starts when everyone is ready. You can show or hide the timer; it will appear automatically for the final 30 seconds.</p>
        <GroupProgress players={players} progress={progress} pending="Viewing guide…" />
        {done ? <p role="status">Waiting for the other group members…</p> : <Button disabled={pending} handleClick={() => next()}>Got it</Button>}
      </section>
    </div>}
  </div>;
}
