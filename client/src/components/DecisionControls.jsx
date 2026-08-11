import React from "react";
import Slider from "@mui/material/Slider";

export const NO_GROUP_FINAL_DECISION_OPTION = Object.freeze({
  id: "NO_GROUP_FINAL_DECISION",
  label: "The group did not reach a final decision",
});

export function OptionChoice({ legend, options, value, onChange, name }) {
  const gridColumns = options.length === 4 ? "sm:grid-cols-2" : "sm:grid-cols-3";
  return (
    <fieldset className="min-w-0 w-full">
      <legend className="text-base font-semibold text-gray-900">{legend}</legend>
      <div className={`mt-3 grid min-w-0 gap-3 ${gridColumns}`}>
        {options.map((option) => (
          <label key={option.id} className={`flex min-w-0 cursor-pointer items-center gap-2 rounded-md border p-3 text-sm font-medium focus-within:ring-2 focus-within:ring-blue-500 ${value === option.id ? "border-blue-600 bg-blue-50 text-blue-900" : "border-gray-300 bg-white text-gray-700"}`}>
            <input type="radio" name={name} value={option.id} checked={value === option.id} onChange={() => onChange(option.id)} className="h-4 w-4 flex-none p-0" />
            <span className="min-w-0 break-words">{option.label}</span>
          </label>
        ))}
      </div>
    </fieldset>
  );
}

export function ConfidenceSlider({ label, value, onChange, name }) {
  return (
    <div className="mt-6 min-w-0 w-full">
      <label id={`${name}-label`} className="block text-base font-semibold text-gray-900">{label}</label>
      <div className="mt-4 px-3">
        <Slider value={value ?? 50} onChange={(_event, next) => onChange(Number(next))} aria-labelledby={`${name}-label`} min={0} max={100} step={1} valueLabelDisplay={value === null || value === undefined ? "off" : "on"} sx={{ "& input": { padding: 0, flex: "none" } }} />
      </div>
      <div className="flex justify-between gap-4 text-xs font-semibold text-gray-600">
        <span>0 = Not at all confident</span><span>100 = Completely confident</span>
      </div>
      <p className="mt-2 text-center text-sm text-gray-600" aria-live="polite">Selected value: {value ?? "Not selected"}</p>
    </div>
  );
}
