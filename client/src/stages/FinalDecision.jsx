import React, { useState } from "react";
import { usePlayer, usePlayers, useGame, useRound } from "@empirica/core/player/classic/react";
import { Loading } from "@empirica/core/player/react";
import Slider from "@mui/material/Slider";
import { Button } from "../components/Button";
import { PlayerSpecificInfo } from "../components/PlayerSpecificInfo.jsx";
import { RenderMarkdown } from "../components/RenderMarkdown.jsx";

// Mirrors InitialDecision.jsx's structure and code style. Intentionally does
// NOT read or default from the initial decision anywhere -- selectedOption/
// confidence always start blank so the final answer is genuinely independent.
export function FinalDecision() {
  const player = usePlayer();
  const players = usePlayers();
  const game = useGame();
  const round = useRound();
  // Round-first with game-level fallback: the current (unmodified) backend
  // only ever sets these at the game level, so the fallback is required for
  // compatibility today. Once callbacks.js sets them per-round, the round
  // value takes over automatically.
  const decisionOptions = round?.get("taskDecisionOptions") ?? game.get("taskDecisionOptions");
  const generalInfo = round?.get("generalInfo") ?? game.get("generalInfo");
  // taskVersion is intentionally round-only, no game-level fallback -- see
  // InitialDecision.jsx for the full rationale. Resolves to null until the
  // backend sets it per round -- see final report as a required backend field.
  const taskVersion = round?.get("taskVersion") ?? null;
  const roundName = round?.get("name");
  const totalRounds = game.get("totalRounds") ?? 2;
  // round.get("index") is the single source of truth for round ordering:
  // proven framework-set (Empirica's own addRound(), see
  // chunk-CA6WWEPS.js, sets an immutable 0-based "index" on every round it
  // creates -- independent of callbacks.js), 0-based. roundNumber is the
  // 1-based value derived from it for "Round X of N" display and for the
  // decision record.
  const roundIndex = round?.get("index") ?? null;
  const roundNumber = typeof roundIndex === "number" ? roundIndex + 1 : null;
  const [selectedOption, setSelectedOption] = useState("");
  const [confidence, setConfidence] = useState(null);

  const buttonClassName = (option) =>
    `px-4 py-2 border rounded-md mx-2 ${selectedOption === option
      ? "bg-blue-500 text-white border-blue-500"
      : "bg-gray-200 text-blue-500 border-gray-300"
    }`;

  const handleOptionClick = (option) => {
    setSelectedOption(option);
  };

  const handleSliderChange = (event, newValue) => {
    setConfidence(newValue);
  };

  const canSubmit = Boolean(selectedOption) && confidence !== null;

  const handleSubmit = (event) => {
    event.preventDefault();
    if (!canSubmit) {
      return;
    }
    // Same round-scoped attribute mechanism as InitialDecision.jsx, under a
    // different key ("finalDecision") -- so this round's initial and final
    // answers, and the other round's initial/final answers, all live in
    // four independent locations that can never overwrite each other.
    // roundIndex/roundNumber are the same values derived above from
    // round.get("index").
    player.round.set("finalDecision", {
      roundId: round?.id ?? null,
      roundIndex,
      roundNumber,
      taskVersion,
      decision: selectedOption,
      decisionStage: "final",
      confidence,
      submittedAt: Date.now(),
    });
    player.stage.set("submit", true);
  };

  if (player.stage.get("submit")) {
    if (players.length === 1) {
      return <Loading />;
    }

    return (
      <div className="h-full w-full flex items-center justify-center">
        <div className="text-center text-gray-400 pointer-events-none">
          Your final decision has been submitted.
          <br />
          Please wait for other player(s).
        </div>
      </div>
    );
  }

  if (!decisionOptions || decisionOptions.length === 0) {
    return (
      <div className="h-full w-full flex items-center justify-center">
        <div className="text-center text-gray-500">
          This session is not yet available. Please contact the research team.
        </div>
      </div>
    );
  }

  return (
    <div className="h-full w-full flex overflow-y-auto">
      <div className="flex flex-col mx-auto w-full max-w-4xl px-8 py-8">
        {roundNumber ? (
          <p className="text-xs uppercase tracking-wide text-gray-400 text-center mb-2">
            Round {roundNumber} of {totalRounds}
          </p>
        ) : (
          roundName && (
            <p className="text-xs uppercase tracking-wide text-gray-400 text-center mb-2">
              {roundName}
            </p>
          )
        )}

        {generalInfo && (
          <div className="mb-6">
            <RenderMarkdown markdownText={generalInfo} />
          </div>
        )}

        <div className="mb-8">
          <PlayerSpecificInfo />
        </div>

        <h1 className="text-2xl font-bold mb-4 text-center">
          Based on your group discussion, submit your final individual decision.
        </h1>
        <p className="text-sm text-gray-500 text-center mb-4">
          This is your own independent answer -- it is not shared with the group
          until after everyone has submitted, and it is not pre-filled from your
          earlier initial decision.
        </p>
        <div className="flex justify-center space-x-4 mb-4">
          {decisionOptions.map((option) => (
            <button
              key={option}
              className={buttonClassName(option)}
              onClick={() => handleOptionClick(option)}
            >
              {option}
            </button>
          ))}
        </div>

        <div className="mb-4">
          <h2 className="text-xl font-semibold mb-2 mt-8 text-center">
            Use the slider below to rate how confident you are in this decision:
          </h2>
          <div className="flex items-center w-full mt-10">
            <span className="text-sm font-bold">Not at all confident (0%)</span>
            <div className="w-full">
              <Slider
                value={confidence !== null ? confidence : 50}
                onChange={handleSliderChange}
                aria-labelledby="confidence-slider"
                min={0}
                max={100}
                step={1}
                className="mx-4"
                valueLabelDisplay={confidence === null ? "off" : "on"}
              />
            </div>
            <span className="text-sm font-bold pl-12">Completely confident (100%)</span>
          </div>
        </div>

        <div className="text-center mt-6">
          <p className="text-sm text-gray-500 mb-2">
            You will not be able to change your answer once you submit.
          </p>
          <Button
            handleClick={handleSubmit}
            disabled={!canSubmit}
          >
            <p>
              {!canSubmit
                ? "Please answer above to proceed"
                : "Submit final decision (cannot be changed after submitting)"}
            </p>
          </Button>
        </div>
      </div>
    </div>
  );
}
