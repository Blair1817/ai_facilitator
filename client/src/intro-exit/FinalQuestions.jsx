import { usePlayer } from "@empirica/core/player/classic/react";
import Slider from "@mui/material/Slider";
import React, { useRef, useState } from "react";
import { Button } from "../components/Button";

const CHANGE_OPTIONS = [
  { value: "yes", label: "Yes" },
  { value: "no", label: "No" },
  { value: "not_sure", label: "Not sure" },
];

const PREFERENCE_OPTIONS = [
  { value: "first_task", label: "The facilitator in the first task" },
  { value: "second_task", label: "The facilitator in the second task" },
  { value: "no_preference", label: "No preference" },
  { value: "not_sure", label: "Not sure" },
];

const NEEDS_OPTIONS = [
  { value: "first_task", label: "The facilitator in the first task" },
  { value: "second_task", label: "The facilitator in the second task" },
  { value: "equally_suitable", label: "They were about equally suitable" },
  { value: "not_sure", label: "Not sure" },
];

const cardClassName =
  "w-full min-w-0 rounded-lg border border-gray-200 bg-white p-5 shadow-sm sm:p-6";
const questionClassName =
  "max-w-full whitespace-normal text-base font-semibold leading-6 text-gray-800";

function descriptionApplies(value) {
  return value === "yes" || value === "not_sure";
}

function RadioOptions({ name, options, selected, onChange }) {
  return (
    <div className="mt-4 flex w-full min-w-0 flex-col gap-3">
      {options.map((option) => (
        <label
          key={option.value}
          className="flex w-full min-w-0 items-start gap-3 text-sm leading-5 text-gray-700"
        >
          <input
            className="mt-1 h-4 w-4 flex-none shrink-0 p-0 rounded-full"
            type="radio"
            name={name}
            value={option.value}
            checked={selected === option.value}
            onChange={onChange}
            required
          />
          <span className="min-w-0 flex-1 whitespace-normal">{option.label}</span>
        </label>
      ))}
    </div>
  );
}

function OptionalDescription({ id, prompt, value, onChange }) {
  return (
    <div className="mt-5 w-full min-w-0 border-t border-gray-100 pt-4">
      <label htmlFor={id} className="block whitespace-normal text-sm leading-5 text-gray-600">
        {prompt}
      </label>
      <textarea
        id={id}
        name={id}
        rows={4}
        value={value}
        onChange={onChange}
        className="mt-2 block min-h-28 w-full min-w-0 resize-y rounded-md border border-gray-300 px-3 py-2 text-sm leading-5 text-gray-800 shadow-sm focus:border-empirica-500 focus:outline-none focus:ring-1 focus:ring-empirica-500"
      />
    </div>
  );
}

export function FinalQuestions({ next }) {
  const player = usePlayer();
  const [discussionApproachChanged, setDiscussionApproachChanged] = useState("");
  const [discussionApproachChangeDescription, setDiscussionApproachChangeDescription] = useState("");
  const [firstTaskCarryover, setFirstTaskCarryover] = useState("");
  const [firstTaskCarryoverDescription, setFirstTaskCarryoverDescription] = useState("");
  const [facilitatorDifference, setFacilitatorDifference] = useState(null);
  const [preferredFacilitator, setPreferredFacilitator] = useState("");
  const [betterNeedsFacilitator, setBetterNeedsFacilitator] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const submittingRef = useRef(false);

  const isComplete = Boolean(
    discussionApproachChanged &&
      firstTaskCarryover &&
      facilitatorDifference !== null &&
      preferredFacilitator &&
      betterNeedsFacilitator,
  );

  function handleSubmit(event) {
    event.preventDefault();
    if (!isComplete || submittingRef.current) {
      return;
    }

    submittingRef.current = true;
    setSubmitting(true);

    player.set("finalQuestions", {
      discussionApproachChanged,
      discussionApproachChangeDescription: descriptionApplies(discussionApproachChanged)
        ? discussionApproachChangeDescription
        : "",
      firstTaskCarryover,
      firstTaskCarryoverDescription: descriptionApplies(firstTaskCarryover)
        ? firstTaskCarryoverDescription
        : "",
      facilitatorDifference: Number(facilitatorDifference),
      preferredFacilitator,
      betterNeedsFacilitator,
    });
    next();
  }

  return (
    <div className="h-full w-full overflow-y-auto overflow-x-hidden bg-gray-50">
      <form
        className="mx-auto flex min-h-full w-full max-w-4xl flex-col px-4 py-8 sm:px-8"
        onSubmit={handleSubmit}
      >
        <header className="mb-8 w-full min-w-0 text-center">
          <h1 className="text-2xl font-bold leading-8 text-gray-900">Final Questions</h1>
          <p className="mt-2 whitespace-normal text-sm leading-6 text-gray-600">
            Please answer the following questions about your experience across the two discussion tasks.
          </p>
        </header>

        <div className="flex w-full min-w-0 flex-col gap-6">
          <fieldset className={cardClassName}>
            <legend className={questionClassName}>
              Compared with the first task, did your group change how it approached the discussion in the second task?
            </legend>
            <RadioOptions
              name="discussionApproachChanged"
              options={CHANGE_OPTIONS}
              selected={discussionApproachChanged}
              onChange={(event) => setDiscussionApproachChanged(event.target.value)}
            />
            {descriptionApplies(discussionApproachChanged) && (
              <OptionalDescription
                id="discussionApproachChangeDescription"
                prompt="If yes or not sure, please briefly describe what changed (optional)."
                value={discussionApproachChangeDescription}
                onChange={(event) => setDiscussionApproachChangeDescription(event.target.value)}
              />
            )}
          </fieldset>

          <fieldset className={cardClassName}>
            <legend className={questionClassName}>
              Did anything you experienced during the first task influence how you approached the second task?
            </legend>
            <RadioOptions
              name="firstTaskCarryover"
              options={CHANGE_OPTIONS}
              selected={firstTaskCarryover}
              onChange={(event) => setFirstTaskCarryover(event.target.value)}
            />
            {descriptionApplies(firstTaskCarryover) && (
              <OptionalDescription
                id="firstTaskCarryoverDescription"
                prompt="If yes or not sure, please briefly explain what carried over from the first task (optional)."
                value={firstTaskCarryoverDescription}
                onChange={(event) => setFirstTaskCarryoverDescription(event.target.value)}
              />
            )}
          </fieldset>

          <section className={cardClassName} aria-labelledby="facilitator-difference-question">
            <h2 id="facilitator-difference-question" className={questionClassName}>
              How different did the automated facilitators appear across the two tasks?
            </h2>
            <div className="mt-5 w-full min-w-0">
              <div className="flex w-full min-w-0 justify-between gap-4 text-sm font-semibold leading-5 text-gray-700">
                <span className="min-w-0 flex-1 whitespace-normal text-left">
                  1 = Not at all different
                </span>
                <span className="min-w-0 flex-1 whitespace-normal text-right">
                  7 = Very different
                </span>
              </div>
              <div className="w-full min-w-0 px-2 pt-6 sm:px-4">
                <Slider
                  value={facilitatorDifference !== null ? facilitatorDifference : 4}
                  onChange={(event, newValue) => setFacilitatorDifference(Number(newValue))}
                  aria-label="Difference between automated facilitators"
                  min={1}
                  max={7}
                  step={1}
                  valueLabelDisplay={facilitatorDifference === null ? "off" : "on"}
                  className="w-full"
                  sx={{
                    "& input": {
                      flex: "none",
                      padding: 0,
                      border: 0,
                      borderRadius: 0,
                    },
                  }}
                />
              </div>
              <p className="mt-3 text-center text-sm font-medium text-gray-700" aria-live="polite">
                Selected value: {facilitatorDifference === null ? "Not selected" : facilitatorDifference}
              </p>
            </div>
          </section>

          <fieldset className={cardClassName}>
            <legend className={questionClassName}>
              Which automated facilitator did you prefer overall?
            </legend>
            <RadioOptions
              name="preferredFacilitator"
              options={PREFERENCE_OPTIONS}
              selected={preferredFacilitator}
              onChange={(event) => setPreferredFacilitator(event.target.value)}
            />
          </fieldset>

          <fieldset className={cardClassName}>
            <legend className={questionClassName}>
              Which facilitator better addressed what your group needed during the discussion?
            </legend>
            <RadioOptions
              name="betterNeedsFacilitator"
              options={NEEDS_OPTIONS}
              selected={betterNeedsFacilitator}
              onChange={(event) => setBetterNeedsFacilitator(event.target.value)}
            />
          </fieldset>
        </div>

        <div className="flex w-full justify-end pt-8 pb-4">
          <Button className="ml-0" type="submit" primary disabled={!isComplete || submitting}>
            Submit Final Questions
          </Button>
        </div>
      </form>
    </div>
  );
}
