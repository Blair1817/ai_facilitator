import React, { useEffect, useRef, useState } from "react";
import { useGame, usePlayer, useRound, useStage } from "@empirica/core/player/classic/react";
import { ChatHistory } from "../components/CustomChat";
import { PRACTICE_CHAT } from "../../../shared/practice.mjs";
import { changeDecisionResponse, validateDecisionResponse } from "../../../shared/decisionSubmission.mjs";
import { Button } from "../components/Button";
import { PlayerSpecificInfo } from "../components/PlayerSpecificInfo";
import { Profile } from "../Profile";
import { ConfidenceSlider, OptionChoice } from "../components/DecisionControls";
import { draftKey, usePersistentDraft } from "../hooks/usePersistentDraft.js";
import { Timer } from "../components/Timer";
import { LegacyFinalDecision } from "./LegacyFinalDecision";

export function FinalDecision() {
  const round = useRound();
  return round?.get("decisionFlowVersion") === 2 ? <IndependentFinalDecision /> : <LegacyFinalDecision />;
}

export function IndependentFinalDecision() {
  const game = useGame(), player = usePlayer(), round = useRound(), stage = useStage();
  const practice = round.get("isPractice") === true;
  const [referenceTab, setReferenceTab] = useState("chat");
  const taskIndex = round.get("taskIndex");
  const chatAttribute = practice ? PRACTICE_CHAT : Number.isInteger(taskIndex) ? `chat_round_${taskIndex}` : null;
  const options = round.get("decisionOptions") ?? [];
  const stored = player.round.get("finalDecisionSubmission");
  const result = player.round.get("finalDecisionSubmissionResult");
  const finalized = round.get("finalDecisionConfirmed") === true;
  const key = (field) => draftKey({ playerId: player.id, roundId: round.id, form: "independentFinalDecision", field });
  const [draft, setDraft] = usePersistentDraft(key("response"), {
    choice: "", confidence: null, agreesWithGroupChoice: null,
    finalPersonalChoice: "", finalPersonalChoiceRationale: "",
  });
  const [pending, setPending] = usePersistentDraft(key("pending"), null);
  const pendingRef = useRef(pending);
  const [error, setError] = useState("");
  const change = (field, value) => setDraft((current) => changeDecisionResponse(current, field, value));
  const complete = validateDecisionResponse(draft, options).valid;

  useEffect(() => {
    if (!pending) return undefined;
    if (stored || finalized || (result?.requestId === pending.requestId && result.status === "rejected")) {
      if (!stored && !finalized) setError(result?.reason === "closed"
        ? "The decision period has ended." : "Please check your answers and submit again.");
      pendingRef.current = null;
      setPending(null);
      return undefined;
    }
    const send = () => player.set("finalDecisionSubmitRequest", { ...pending, attempt: Date.now() });
    send();
    const retry = setInterval(send, 2000);
    return () => clearInterval(retry);
  }, [pending, stored, finalized, result, player, setPending]);

  const submit = (event) => {
    event.preventDefault();
    if (!complete || pendingRef.current || stored || finalized) return;
    const request = { ...draft, requestId: crypto.randomUUID(), roundId: round.id, stageId: stage.id };
    pendingRef.current = request;
    setError("");
    setPending(request);
  };

  return (
    <div className="flex h-full w-full flex-col overflow-hidden bg-gray-50 p-4 sm:p-6">
      <div className="mb-4 flex-none">
        {practice ? <p className="rounded-lg border bg-white p-4 font-semibold">You are <span style={{ color: "#" + player.get("hexCode") }}>{player.get("name")}</span></p> : <Profile />}
      </div>
      <div className="mb-3 flex flex-none gap-2 xl:!hidden" aria-label="Reference panels">
        {[["chat", "Chat history"], ["report", "Personal Report"]].map(([tab, label]) => (
          <button key={tab} type="button" aria-pressed={referenceTab === tab} onClick={() => setReferenceTab(tab)} className={`rounded-md border px-4 py-2 text-sm font-semibold ${referenceTab === tab ? "bg-blue-700 text-white" : "bg-white text-gray-700"}`}>{label}</button>
        ))}
      </div>
      <div className="grid min-h-0 flex-1 gap-4 overflow-y-auto xl:grid-cols-3 xl:overflow-hidden">
        <div className={`${referenceTab === "report" ? "flex" : "hidden"} h-[45vh] min-h-0 min-w-0 xl:!flex xl:h-full`}><PlayerSpecificInfo className="h-full" /></div>
        <section className={`${referenceTab === "chat" ? "flex" : "hidden"} h-[45vh] min-h-0 min-w-0 flex-col rounded-lg border border-gray-200 bg-white xl:!flex xl:h-full`} aria-labelledby="decision-chat-title">
          <header className="flex-none border-b p-4">
            <h2 id="decision-chat-title" className="font-bold text-gray-900">Chat history</h2>
            <p className="mt-1 text-sm text-gray-600">Discussion has ended. You can review your group’s messages here.</p>
          </header>
          {chatAttribute && <ChatHistory key={`${round.id}:${chatAttribute}:${referenceTab}`} scope={game} attribute={chatAttribute} />}
        </section>
        <div className="min-h-0 min-w-0 xl:overflow-y-auto">
          <form onSubmit={submit} className="block min-w-0 w-full rounded-lg border border-gray-200 bg-white p-5 shadow-sm sm:p-6">
            <h1 className="text-2xl font-bold text-gray-900">Group Final Decision</h1>
            <p className="mt-2 text-sm text-gray-600">Report your group’s final choice, then tell us whether you personally agree with it. Submit your response independently.</p>
            <div className="mt-4 flex items-center justify-between gap-3 rounded-md bg-gray-100 px-3 py-2 text-gray-700" role="status"><span className="font-semibold">Time remaining:</span><Timer deadline={round.get("finalDecisionDeadline")} /></div>
            {stored ? <p role="status" className="mt-6 rounded-md bg-green-50 p-4 font-semibold text-green-800">Your response has been submitted. Please wait for the other participants.</p>
              : finalized ? <p role="status" className="mt-6 rounded-md bg-gray-100 p-4">The decision period has ended. Please continue to the next part.</p>
              : <>
                <fieldset disabled={Boolean(pending)} className="mt-6 min-w-0 space-y-6">
                  <OptionChoice legend="After the discussion, which option did your group agree on?" options={options} value={draft.choice} onChange={(value) => change("choice", value)} name="groupFinalChoice" />
                  <ConfidenceSlider name="groupChoiceConfidence" label="How confident are you that your group’s final outcome is appropriate based on the information discussed?" value={draft.confidence} onChange={(value) => change("confidence", value)} />
                  <OptionChoice legend="Do you personally agree with the group choice you reported above?" options={[{ id: "yes", label: "Yes" }, { id: "no", label: "No" }]} value={draft.agreesWithGroupChoice === true ? "yes" : draft.agreesWithGroupChoice === false ? "no" : ""} onChange={(value) => change("agreesWithGroupChoice", value === "yes")} name="agreesWithGroupChoice" />
                  {draft.agreesWithGroupChoice === false && <div className="space-y-5">
                    <OptionChoice legend="Which option do you personally consider most suitable?" options={options} value={draft.finalPersonalChoice} onChange={(value) => change("finalPersonalChoice", value)} name="finalPersonalChoice" />
                    <div><label htmlFor="finalPersonalChoiceRationale" className="block font-semibold text-gray-900">Please explain why you prefer this option.</label><textarea id="finalPersonalChoiceRationale" rows={4} required value={draft.finalPersonalChoiceRationale} onChange={(event) => change("finalPersonalChoiceRationale", event.target.value)} className="mt-3 w-full resize-y rounded-md border border-gray-300 p-3" /></div>
                  </div>}
                </fieldset>
                {error && <p role="alert" className="mt-4 text-red-800">{error}</p>}
                <div className="mt-8 text-right"><Button className="ml-0" type="submit" disabled={!complete || Boolean(pending)}>Submit</Button></div>
                {pending && <p role="status" className="mt-3 text-sm text-gray-600">Saving your response…</p>}
              </>}
          </form>
        </div>
      </div>
    </div>
  );
}
