import React, { useState } from "react";
import { usePlayer, useGame } from "@empirica/core/player/classic/react";
import Slider from "@mui/material/Slider";
import { Button } from "@mui/material";

export function SubmitAnswer({ next }) {
  const player = usePlayer();
  const game = useGame();
  const decisionOptions = game.get("taskDecisionOptions") || [];
  const [selectedOption, setSelectedOption] = useState("");
  const [agreement, setAgreement] = useState(null);
  const [submitting, setSubmitting] = useState(false);

  const buttonClassName = (option) =>
    `px-4 py-2 border rounded-md mx-2 ${selectedOption === option
      ? "bg-blue-500 text-white border-blue-500"
      : "bg-gray-200 text-blue-500 border-gray-300"
    }`;

  const handleOptionClick = (option) => {
    setSelectedOption(option);
  };

  const handleSliderChange = (event, newValue) => {
    setAgreement(newValue);
  };

  const handleSubmit = (event) => {
    event.preventDefault();
    if (submitting || !selectedOption || agreement === null) {
      return;
    }
    setSubmitting(true);
    player.set("selectedOption", selectedOption);
    player.set("agreement", agreement);
    next();
  };

  return (
    <div className="flex flex-col items-center justify-center min-h-screen">
      <h1 className="text-2xl font-bold mb-4">
        Which option did your group choose?
      </h1>
      <div className="flex space-x-4 mb-4">
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
        <h2 className="text-xl font-semibold mb-2 mt-8">
          Use the slider below to rate how much you <strong>personally</strong> agree with the group's choice:
        </h2>
        <div className="flex items-center w-full mt-10">
          <span className="text-sm font-bold">Completely disagree (0%)</span>
          <div className="w-full">
            <Slider
              value={agreement !== null ? agreement : 50}
              onChange={handleSliderChange}
              aria-labelledby="agreement-slider"
              min={0}
              max={100}
              step={1}
              className="mx-4"
              valueLabelDisplay={agreement === null ? "off" : "on"}
            />
          </div>
          <span className="text-sm font-bold pl-12">Completely agree (100%)</span>
        </div>
      </div>

      <div className="text-right">
        <button
          onClick={handleSubmit}
          disabled={submitting || !selectedOption || agreement === null}
          className={`px-4 py-2 rounded-md ${submitting || !selectedOption || agreement === null
              ? "bg-gray-300 text-gray-700 cursor-not-allowed"
              : "bg-blue-500 text-white"
            }`}
        >
          {!selectedOption || agreement === null ? "Please answer the above to proceed" : submitting ? "Submitting…" : "Submit"}
        </button>
      </div>
    </div>
  );
}
