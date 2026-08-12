import React, { useEffect, useRef, useState } from "react";
import { usePlayer, usePlayers, useRound } from "@empirica/core/player/classic/react";
import { Loading } from "@empirica/core/player/react";
import { Button } from "../components/Button";
import { ConfidenceSlider, OptionChoice } from "../components/DecisionControls";

export function IndividualAssessment() {
  const player = usePlayer();
  const players = usePlayers();
  const round = useRound();
  const options = round?.get("decisionOptions") ?? [];
  const officialGroupChoice = round?.get("officialGroupFinalChoice");
  const finalDecisionOutcome = round?.get("finalDecisionOutcome");
  const groupReachedDecision = finalDecisionOutcome === "consensus_choice"
    && options.some((option) => option.id === officialGroupChoice);
  const groupFailedToDecide = finalDecisionOutcome === "declared_fail" || finalDecisionOutcome === "timeout_fail";
  const [choice, setChoice] = useState(() => player.round.get("finalPersonalChoice") ?? "");
  const [confidence, setConfidence] = useState(() => player.round.get("finalPersonalChoiceConfidence") ?? null);
  const [rationale, setRationale] = useState(() => player.round.get("finalPersonalChoiceRationale") ?? "");
  const submitting = useRef(false);

  const persist = (key, value, setter) => { setter(value); player.round.set(key, value); };
  const complete = Boolean(choice && rationale.trim()) && confidence !== null;

  useEffect(() => {
    if (groupReachedDecision && !player.stage.get("submit")) {
      player.stage.set("submit", true);
    }
  }, [groupReachedDecision, player]);

  const submit = (event) => {
    event.preventDefault();
    if (!complete || submitting.current) return;
    submitting.current = true;
    player.round.set("agreesWithGroupChoice", null);
    player.round.set("finalPersonalChoice", choice);
    player.round.set("finalPersonalChoiceConfidence", confidence);
    player.round.set("finalPersonalChoiceRationale", rationale.trim());
    player.stage.set("submit", true);
  };

  if (groupReachedDecision || player.stage.get("submit")) return players.length === 1 ? <Loading /> : <div className="flex h-full items-center justify-center text-gray-500">Your private assessment has been submitted. Please wait for the other participant(s).</div>;
  return (
    <div className="h-full w-full overflow-y-auto bg-gray-50 px-4 py-8 sm:px-8">
      <form onSubmit={submit} className="mx-auto block min-w-0 w-full max-w-3xl rounded-lg border border-gray-200 bg-white p-6 shadow-sm">
        <h1 className="text-2xl font-bold text-gray-900">Individual Assessment</h1>
        <p className="mt-3 rounded-md bg-gray-100 p-4 font-semibold text-gray-800">{groupFailedToDecide ? "Your group did not reach a final decision." : "No group decision was recorded."}</p>
        <p className="mt-2 text-sm text-gray-600">Your answers on this page are private and are not shown to your teammates.</p>
        <p className="mt-3 text-sm font-bold text-gray-700">Scroll down to complete all questions.</p>
        <div className="mt-7"><OptionChoice legend="After the group discussion, which option do you personally consider most suitable?" options={options} value={choice} onChange={(value)=>persist("finalPersonalChoice",value,setChoice)} name="finalPersonalChoice" /></div>
        <ConfidenceSlider name="finalPersonalChoiceConfidence" label="How confident are you in your final personal choice?" value={confidence} onChange={(value)=>persist("finalPersonalChoiceConfidence",value,setConfidence)} />
        <label className="mt-7 block font-semibold text-gray-900" htmlFor="finalPersonalChoiceRationale">Briefly explain the main reasons for your final personal choice.</label>
        <textarea id="finalPersonalChoiceRationale" rows={5} value={rationale} onChange={(event)=>persist("finalPersonalChoiceRationale",event.target.value,setRationale)} className="mt-3 w-full resize-y rounded-md border border-gray-300 p-3" required />
        <div className="mt-8 text-right"><Button className="ml-0" type="submit" disabled={!complete || submitting.current}>Submit Private Assessment</Button></div>
      </form>
    </div>
  );
}
