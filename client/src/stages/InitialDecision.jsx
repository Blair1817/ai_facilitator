import React, { useRef, useState } from "react";
import { usePlayer, usePlayers, useRound } from "@empirica/core/player/classic/react";
import { Loading } from "@empirica/core/player/react";
import { Button } from "../components/Button";
import { PlayerSpecificInfo } from "../components/PlayerSpecificInfo";
import { ConfidenceSlider, OptionChoice } from "../components/DecisionControls";

export function InitialDecision() {
  const player = usePlayer();
  const players = usePlayers();
  const round = useRound();
  const options = round?.get("decisionOptions") ?? [];
  const [choice, setChoice] = useState(() => player.round.get("initialChoice") ?? "");
  const [confidence, setConfidence] = useState(() => player.round.get("initialConfidence") ?? null);
  const submitting = useRef(false);

  const updateChoice = (value) => { setChoice(value); player.round.set("initialChoice", value); };
  const updateConfidence = (value) => { setConfidence(value); player.round.set("initialConfidence", value); };
  const canSubmit = Boolean(choice) && confidence !== null;

  const submit = (event) => {
    event.preventDefault();
    if (!canSubmit || submitting.current) return;
    submitting.current = true;
    player.round.set("initialChoice", choice);
    player.round.set("initialConfidence", confidence);
    player.stage.set("submit", true);
  };

  if (player.stage.get("submit")) return players.length === 1 ? <Loading /> : <Waiting text="Your initial decision has been submitted." />;
  if (!options.length) return <Waiting text="This session is not yet available. Please contact the research team." />;

  return (
    <div className="h-full w-full overflow-y-auto bg-gray-50 p-4 sm:p-6">
      <div className="mx-auto grid min-h-full w-full max-w-7xl gap-6 lg:grid-cols-[minmax(0,3fr)_minmax(20rem,2fr)]">
        <PlayerSpecificInfo className="h-[55vh] lg:sticky lg:top-6 lg:h-[calc(100vh-3rem)]" />
        <form onSubmit={submit} className="block min-w-0 w-full self-start rounded-lg border border-gray-200 bg-white p-5 shadow-sm sm:p-6">
          <h1 className="text-2xl font-bold text-gray-900">Initial Decision</h1>
          <p className="mt-2 text-sm text-gray-600">Review the Task Report independently. This answer is private.</p>
          <div className="mt-6"><OptionChoice legend="Which option do you initially consider most suitable?" options={options} value={choice} onChange={updateChoice} name="initialChoice" /></div>
          <ConfidenceSlider name="initialConfidence" label="How confident are you in your initial choice?" value={confidence} onChange={updateConfidence} />
          <div className="mt-8 text-right"><Button className="ml-0" type="submit" disabled={!canSubmit || submitting.current}>Submit Initial Decision</Button></div>
        </form>
      </div>
    </div>
  );
}

function Waiting({ text }) {
  return <div className="flex h-full w-full items-center justify-center px-6 text-center text-gray-500">{text}<br />Please wait for the other participant(s).</div>;
}
