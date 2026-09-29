import React, { useEffect, useRef, useState } from "react";
import { useGame, usePlayer, useRound, useStage } from "@empirica/core/player/classic/react";
import { ChatHistory } from "../components/CustomChat";
import { PRACTICE_CHAT } from "../../../shared/practice.mjs";
import { Button } from "../components/Button";
import { PlayerSpecificInfo } from "../components/PlayerSpecificInfo";
import { Profile } from "../Profile";
import { ConfidenceSlider, NO_GROUP_FINAL_DECISION_OPTION, OptionChoice } from "../components/DecisionControls";
import { draftKey, usePersistentDraft } from "../hooks/usePersistentDraft.js";

export function FinalDecision() {
  const game = useGame();
  const player = usePlayer();
  const round = useRound();
  const stage = useStage();
  const practice = round?.get("isPractice") === true;
  const [referenceTab, setReferenceTab] = useState("chat");
  const taskIndex = round?.get("taskIndex");
  const chatAttribute = practice ? PRACTICE_CHAT : Number.isInteger(taskIndex) ? `chat_round_${taskIndex}` : null;
  const options = round?.get("decisionOptions") ?? [];
  const groupDecisionOptions = [...options, NO_GROUP_FINAL_DECISION_OPTION];
  const choiceDraftKey = draftKey({ playerId: player.id, roundId: round?.id, form: "finalDecision", field: "choice" });
  const confidenceDraftKey = draftKey({ playerId: player.id, roundId: round?.id, form: "finalDecision", field: "confidence" });
  const [choice, setChoice] = usePersistentDraft(choiceDraftKey, player.round.get("groupFinalChoice") ?? "");
  const [confidence, setConfidence] = usePersistentDraft(confidenceDraftKey, player.round.get("groupChoiceConfidence") ?? null);
  const lastDraftRequest = useRef("");
  const [confirming, setConfirming] = useState(false);

  const agreementStatus = round?.get("finalDecisionAgreementStatus") ?? "not_agreed";
  const matchedChoice = round?.get("finalDecisionMatchedChoice") ?? null;
  const confirmedChoice = player.round.get("groupFinalConfirmedChoice") ?? null;
  const agreed = agreementStatus === "agreed" && Boolean(choice) && matchedChoice === choice;
  const ownConfirmationCurrent = agreed && confirmedChoice === matchedChoice;
  const canConfirm = agreed && confidence !== null && !ownConfirmationCurrent;

  // Persist this participant's current private draft promptly. The server
  // publishes only aggregate agreement status and invalidates confirmations
  // whenever any participant changes their selected outcome.
  useEffect(() => {
    if (!choice) return;
    const requestKey = `${choice}:${confidence ?? "unset"}`;
    if (lastDraftRequest.current === requestKey) return;
    lastDraftRequest.current = requestKey;
    player.set("finalDecisionDraftRequest", {
      requestId: globalThis.crypto?.randomUUID?.() ?? `${player.id}-${Date.now()}`,
      roundId: round?.id,
      stageId: stage.id,
      choice,
      confidence,
      requestedAt: Date.now(),
    });
  }, [choice, confidence, player, round?.id, stage.id]);

  useEffect(() => {
    if (!confirming || ownConfirmationCurrent) return undefined;
    const timeout = setTimeout(() => setConfirming(false), 1500);
    return () => clearTimeout(timeout);
  }, [confirming, ownConfirmationCurrent]);

  const confirm = (event) => {
    event.preventDefault();
    if (!canConfirm || confirming) return;
    setConfirming(true);
    player.set("finalDecisionConfirmRequest", {
      requestId: globalThis.crypto?.randomUUID?.() ?? `${player.id}-${Date.now()}`,
      roundId: round?.id,
      stageId: stage.id,
      choice,
      requestedAt: Date.now(),
    });
  };

  return (
    <div className="flex h-full w-full flex-col overflow-hidden bg-gray-50 p-4 sm:p-6">
      <div className="mb-4 flex-none">
        {practice ? <p className="rounded-lg border bg-white p-4 font-semibold">You are <span style={{ color: "#" + player.get("hexCode") }}>{player.get("name")}</span></p> : <Profile />}
      </div>
      <div className="mb-3 flex flex-none gap-2 xl:hidden" aria-label="Reference panels">
        {[['chat', 'Chat history'], ['report', 'Personal Report']].map(([tab, label]) => (
          <button key={tab} type="button" aria-pressed={referenceTab === tab} onClick={() => setReferenceTab(tab)} className={`rounded-md border px-4 py-2 text-sm font-semibold ${referenceTab === tab ? 'bg-blue-700 text-white' : 'bg-white text-gray-700'}`}>{label}</button>
        ))}
      </div>
      <div className="grid min-h-0 flex-1 gap-4 overflow-y-auto xl:grid-cols-3 xl:overflow-hidden">
        <div className={`${referenceTab === 'report' ? 'flex' : 'hidden'} h-[45vh] min-h-0 min-w-0 xl:flex xl:h-full`}>
          <PlayerSpecificInfo className="h-full" />
        </div>
        <section className={`${referenceTab === 'chat' ? 'flex' : 'hidden'} h-[45vh] min-h-0 min-w-0 flex-col rounded-lg border border-gray-200 bg-white xl:flex xl:h-full`} aria-labelledby="decision-chat-title">
          <header className="flex-none border-b p-4">
            <h2 id="decision-chat-title" className="font-bold text-gray-900">Chat history</h2>
            <p className="mt-1 text-sm text-gray-600">Discussion has ended. You can review your group’s messages here.</p>
          </header>
          {chatAttribute && <ChatHistory key={`${round.id}:${chatAttribute}:${referenceTab}`} scope={game} attribute={chatAttribute} />}
        </section>
        <div className="min-h-0 min-w-0 space-y-4 xl:overflow-y-auto">
          {practice && round.get("practiceDiscussionEnded") === "timeout" && <p role="status" className="rounded-lg bg-blue-50 p-4">Discussion time has ended. Please submit your group’s choice.</p>}
          <form onSubmit={confirm} className="block min-w-0 w-full rounded-lg border border-gray-200 bg-white p-5 shadow-sm sm:p-6">
            <h1 className="text-2xl font-bold text-gray-900">{practice ? "Make your group decision" : "Group Final Decision"}</h1>
            <p className="mt-2 text-sm text-gray-600">{practice ? "Select the room your group agreed on. As in the main tasks, everyone selects the same outcome, records their confidence, and confirms." : "Select your group’s current outcome and record your own confidence in that group outcome."}</p>
            <div className="mt-6"><OptionChoice legend="Which outcome did your group select?" options={groupDecisionOptions} value={choice} onChange={setChoice} name="groupFinalChoice" /></div>
            <ConfidenceSlider name="groupChoiceConfidence" label="How confident are you that your group’s final outcome is appropriate based on the information discussed?" value={confidence} onChange={setConfidence} />

            <div className={`mt-6 rounded-md p-4 text-sm font-semibold ${agreed ? "bg-green-50 text-green-800" : "bg-amber-50 text-amber-800"}`} aria-live="polite">
              {agreed
                ? "Your group has selected the same outcome. You may now confirm your group decision."
                : "Your group has not yet selected the same outcome."}
            </div>
            <p className="mt-3 text-sm font-semibold text-gray-700">If your group cannot agree on one option, each member should select “Fail to reach a final decision”.</p>

            {ownConfirmationCurrent ? (
              <p className="mt-7 rounded-md bg-gray-100 p-4 text-center text-sm text-gray-700">Your confirmation has been recorded. Waiting for the group decision to be confirmed.</p>
            ) : (
              <div className="mt-8 text-right"><Button className={practice ? "ml-0 bg-blue-700 text-white hover:bg-blue-800" : "ml-0"} type="submit" disabled={!canConfirm || confirming}>{practice ? "Confirm group choice" : "Confirm group decision"}</Button></div>
            )}
          </form>
        </div>
      </div>
    </div>
  );
}
