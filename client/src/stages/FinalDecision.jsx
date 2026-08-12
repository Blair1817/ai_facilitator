import React, { useRef } from "react";
import { usePlayer, usePlayers, useRound } from "@empirica/core/player/classic/react";
import { Loading } from "@empirica/core/player/react";
import { Button } from "../components/Button";
import { PlayerSpecificInfo } from "../components/PlayerSpecificInfo";
import { ConfidenceSlider, NO_GROUP_FINAL_DECISION_OPTION, OptionChoice } from "../components/DecisionControls";
import { clearDraftKeys, draftKey, usePersistentDraft } from "../hooks/usePersistentDraft.js";

export function FinalDecision() {
  const player = usePlayer();
  const players = usePlayers();
  const round = useRound();
  const options = round?.get("decisionOptions") ?? [];
  const groupDecisionOptions = [...options, NO_GROUP_FINAL_DECISION_OPTION];
  const choiceDraftKey = draftKey({ playerId: player.id, roundId: round?.id, form: "finalDecision", field: "choice" });
  const confidenceDraftKey = draftKey({ playerId: player.id, roundId: round?.id, form: "finalDecision", field: "confidence" });
  const [choice, setChoice] = usePersistentDraft(choiceDraftKey, player.round.get("groupFinalChoice") ?? "");
  const [confidence, setConfidence] = usePersistentDraft(confidenceDraftKey, player.round.get("groupChoiceConfidence") ?? null);
  const submitting = useRef(false);
  const updateChoice = (value) => {
    setChoice(value);
    if (value === NO_GROUP_FINAL_DECISION_OPTION.id) {
      setConfidence(null);
    }
  };
  const updateConfidence = setConfidence;
  const noGroupDecision = choice === NO_GROUP_FINAL_DECISION_OPTION.id;
  const canSubmit = Boolean(choice) && (noGroupDecision || confidence !== null);

  const submit = (event) => {
    event.preventDefault();
    if (!canSubmit || submitting.current) return;
    submitting.current = true;
    player.round.set("groupFinalChoice", choice);
    player.round.set("groupChoiceConfidence", noGroupDecision ? null : confidence);
    player.round.set("finalDecision", {
      choice,
      confidence: noGroupDecision ? null : confidence,
      submittedAt: Date.now(),
    });
    clearDraftKeys([choiceDraftKey, confidenceDraftKey]);
    player.stage.set("submit", true);
  };

  if (player.stage.get("submit")) return players.length === 1 ? <Loading /> : <Waiting />;
  return (
    <div className="h-full w-full overflow-y-auto bg-gray-50 p-4 sm:p-6">
      <div className="mx-auto grid min-h-full w-full max-w-7xl gap-6 lg:grid-cols-[minmax(0,3fr)_minmax(20rem,2fr)]">
        <PlayerSpecificInfo className="h-[55vh] lg:sticky lg:top-6 lg:h-[calc(100vh-3rem)]" />
        <form onSubmit={submit} className="block min-w-0 w-full self-start rounded-lg border border-gray-200 bg-white p-5 shadow-sm sm:p-6">
          <h1 className="text-2xl font-bold text-gray-900">Group Final Decision</h1>
          <div className="mt-6"><OptionChoice legend="Which option did your group choose?" options={groupDecisionOptions} value={choice} onChange={updateChoice} name="groupFinalChoice" /></div>
          <p className="mt-2 text-sm text-gray-600">Select the option your group chose, or indicate that the group did not reach a final decision.</p>
          {!noGroupDecision && <ConfidenceSlider name="groupChoiceConfidence" label="How confident are you that your group’s final choice is the most suitable option based on the information discussed?" value={confidence} onChange={updateConfidence} />}
          <div className="mt-8 text-right"><Button className="ml-0" type="submit" disabled={!canSubmit || submitting.current}>Submit Group Final Decision</Button></div>
        </form>
      </div>
    </div>
  );
}

function Waiting() {
  return <div className="flex h-full w-full items-center justify-center px-6 text-center text-gray-500">Your group decision report has been submitted.<br />Please wait for the other participant(s).</div>;
}
