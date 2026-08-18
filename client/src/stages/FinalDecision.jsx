import React, { useEffect, useRef, useState } from "react";
import { usePlayer, useRound, useStage } from "@empirica/core/player/classic/react";
import { Button } from "../components/Button";
import { PlayerSpecificInfo } from "../components/PlayerSpecificInfo";
import { Profile } from "../Profile";
import { ConfidenceSlider, NO_GROUP_FINAL_DECISION_OPTION, OptionChoice } from "../components/DecisionControls";
import { draftKey, usePersistentDraft } from "../hooks/usePersistentDraft.js";

export function FinalDecision() {
  const player = usePlayer();
  const round = useRound();
  const stage = useStage();
  const options = round?.get("decisionOptions") ?? [];
  const groupDecisionOptions = [...options, NO_GROUP_FINAL_DECISION_OPTION];
  const choiceDraftKey = draftKey({ playerId: player.id, roundId: round?.id, form: "finalDecision", field: "choice" });
  const confidenceDraftKey = draftKey({ playerId: player.id, roundId: round?.id, form: "finalDecision", field: "confidence" });
  const [choice, setChoice] = usePersistentDraft(choiceDraftKey, player.round.get("groupFinalChoice") ?? "");
  const [confidence, setConfidence] = usePersistentDraft(confidenceDraftKey, player.round.get("groupChoiceConfidence") ?? null);
  const lastDraftRequest = useRef("");
  const requestClock = useRef(0);
  const [confirming, setConfirming] = useState(false);

  const agreementStatus = round?.get("finalDecisionAgreementStatus") ?? "not_agreed";
  const agreementRevision = round?.get("finalDecisionAgreementRevision") ?? 0;
  const savedChoice = player.round.get("groupFinalChoice") ?? "";
  const savedConfidence = player.round.get("groupChoiceConfidence") ?? null;
  const confirmedChoice = player.round.get("groupFinalConfirmedChoice") ?? null;
  const ownDraftSynced = Boolean(choice) && savedChoice === choice && savedConfidence === confidence;
  const agreed = agreementStatus === "agreed" && ownDraftSynced;
  const ownConfirmationCurrent = agreed && confirmedChoice === choice;
  const canConfirm = agreed && confidence !== null && !ownConfirmationCurrent;

  // Persist this participant's current private draft promptly. The server
  // publishes only aggregate agreement status and invalidates confirmations
  // whenever any participant changes their selected outcome.
  useEffect(() => {
    if (!choice) return;
    const requestKey = `${choice}:${confidence ?? "unset"}`;
    if (lastDraftRequest.current === requestKey) return;
    lastDraftRequest.current = requestKey;
    const requestedAt = Math.max(Date.now(), requestClock.current + 1);
    requestClock.current = requestedAt;
    player.set("finalDecisionDraftRequest", {
      requestId: globalThis.crypto?.randomUUID?.() ?? `${player.id}-${requestedAt}`,
      roundId: round?.id,
      stageId: stage.id,
      choice,
      confidence,
      requestedAt,
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
      agreementRevision,
      requestedAt: Date.now(),
    });
  };

  return (
    <div className="h-full w-full overflow-y-auto bg-gray-50 p-4 sm:p-6">
      <div className="mx-auto grid min-h-full w-full max-w-7xl gap-6 lg:grid-cols-[minmax(0,3fr)_minmax(20rem,2fr)]">
        <PlayerSpecificInfo className="h-[55vh] lg:sticky lg:top-6 lg:h-[calc(100vh-3rem)]" />
        <div className="min-w-0 self-start space-y-4">
          <Profile />
          <form onSubmit={confirm} className="block min-w-0 w-full rounded-lg border border-gray-200 bg-white p-5 shadow-sm sm:p-6">
            <h1 className="text-2xl font-bold text-gray-900">Group Final Decision</h1>
            <p className="mt-2 text-sm text-gray-600">Select your group’s current outcome and record your own confidence in that group outcome.</p>
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
              <div className="mt-8 text-right"><Button className="ml-0" type="submit" disabled={!canConfirm || confirming}>Confirm group decision</Button></div>
            )}
          </form>
        </div>
      </div>
    </div>
  );
}
