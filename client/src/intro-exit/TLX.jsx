import { usePlayer, useGame } from "@empirica/core/player/classic/react";
import React, { useState } from "react";
import { Alert } from "../components/Alert";
import { Button } from "../components/Button";

export function TLX({ next }) {
    const labelClassName = "block text-md font-bold text-gray-700 my-2";
    const listClassName = "block text-md font-medium text-gray-700 my-2";
    const inputClassName =
        "appearance-none block w-full px-3 py-2 border border-gray-300 rounded-md shadow-sm placeholder-gray-400 focus:outline-none focus:ring-empirica-500 focus:border-empirica-500 sm:text-sm";
    const player = usePlayer();
    const game = useGame();
    const { facilitation } = game.get("treatment");

    // Define state variables for each question
    const [question1, setQuestion1] = useState("");
    const [question2, setQuestion2] = useState("");
    const [question3, setQuestion3] = useState("");
    const [question4, setQuestion4] = useState("");
    const [question5, setQuestion5] = useState("");
    const [question6, setQuestion6] = useState("");
    const [submitting, setSubmitting] = useState(false);

    const isComplete = Boolean(
        question1 && question2 && question3 && question4 && question5 && question6
    );

    function handleSubmit(event) {
        event.preventDefault();
        if (submitting || !isComplete) {
            return;
        }
        setSubmitting(true);
        player.set("tlxSurvey", {
            tlxMentalDemand: question1,
            tlxPhysicalDemand: question2,
            tlxTemporalDemand: question3,
            tlxPerformance: question4,
            tlxEffort: question5,
            tlxFrustration:question6,
        });
        next();
    }

    // Based on Hart and Staveland’s NASA Task Load Index (TLX): https://humansystems.arc.nasa.gov/groups/tlx/downloads/TLXScale.pdf
    return (
        <div className="flex justify-center items-center min-h-screen bg-gray-100">
            <div className="w-full max-w-4xl mx-auto p-8 bg-white rounded-lg shadow-lg mt-10">
                <form
                    className="space-y-8 divide-y divide-gray-200"
                    onSubmit={handleSubmit}
                >
                    <div className="space-y-8 divide-y divide-gray-200">
                        <div>
                            <div>
                                <h3 className="text-xl leading-6 font-medium text-gray-900">
                                    Please take a moment to describe your experience during the task along the following dimensions:
                                </h3>
                            </div>
    
                            <div className="space-y-8 mt-9">
                                <div className="flex">
                                    <label htmlFor="question1" className={`${listClassName} pt-10 w-4/10`}>
                                        How mentally demanding was the task?
                                    </label>
                                    <div className="w-6/10">
                                        <LikertScale
                                            selected={question1}
                                            name="question1"
                                            onChange={(e) => setQuestion1(e.target.value)}
                                            showLabels={true}
                                        />
                                    </div>
                                </div>

                                <div className="flex pt-7">
                                    <label htmlFor="question2" className={`${listClassName} w-4/10`}>
                                        How physically demanding was the task?
                                    </label>
                                    <div className="w-6/10">
                                        <LikertScale
                                            selected={question2}
                                            name="question2"
                                            onChange={(e) => setQuestion2(e.target.value)}
                                            showLabels={false}
                                        />
                                    </div>
                                </div>
    
                                <div className="flex pt-7">
                                    <label htmlFor="question3" className={`${listClassName} w-4/10`}>
                                        How hurried or rushed was the pace of the task?
                                    </label>
                                    <div className="w-6/10">
                                        <LikertScale
                                            selected={question3}
                                            name="question3"
                                            onChange={(e) => setQuestion3(e.target.value)}
                                            showLabels={false}
                                        />
                                    </div>
                                </div>
    
                                <div className="flex pt-7">
                                    <label htmlFor="question4" className={`${listClassName} w-4/10`}>
                                       How successful do you think you were you in accomplishing what you were asked to do?
                                    </label>
                                    <div className="w-6/10">
                                        <LikertScale
                                            selected={question4}
                                            name="question4"
                                            onChange={(e) => setQuestion4(e.target.value)}
                                            showLabels={false}
                                        />
                                    </div>
                                </div>

                                <div className="flex pt-7">
                                    <label htmlFor="question5" className={`${listClassName} w-4/10`}>
                                        How hard did you have to work to accomplish your level of performance?
                                    </label>
                                    <div className="w-6/10">
                                        <LikertScale
                                            selected={question5}
                                            name="question5"
                                            onChange={(e) => setQuestion5(e.target.value)}
                                            showLabels={false}
                                        />
                                    </div>
                                </div>

                                <div className="flex pt-7">
                                    <label htmlFor="question6" className={`${listClassName} w-4/10`}>
                                        How insecure, discouraged, irritated, stressed, and annoyed were you during this task?
                                    </label>
                                    <div className="w-6/10">
                                        <LikertScale
                                            selected={question6}
                                            name="question6"
                                            onChange={(e) => setQuestion6(e.target.value)}
                                            showLabels={false}
                                        />
                                    </div>
                                </div>
    
                                <div className="mb-12 text-right">
                                    {!isComplete && (
                                        <p className="text-sm text-gray-500 mb-2">
                                            Please answer all six questions above to continue.
                                        </p>
                                    )}
                                    <Button type="submit" disabled={submitting || !isComplete}>Next</Button>
                                </div>
                            </div>
                        </div>
                    </div>
                </form>
            </div>
        </div>
    );
    
}

export function Radio({ selected, name, value, label, onChange }) {
    return (
        <label className="text-sm font-medium text-gray-700">
            <input
                className="mr-2 shadow-sm sm:text-sm"
                type="radio"
                name={name}
                value={value}
                checked={selected === value}
                onChange={onChange}
            />
            {label}
        </label>
    );
}


export function LikertScale({ selected, name, onChange, showLabels = true }) {
    const options = [
        { value: "1", label: "Very little" },
        { value: "2", label: "" },
        { value: "3", label: "" },
        { value: "4", label: "" },
        { value: "5", label: "" },
        { value: "6", label: "" },
        { value: "7", label: "Very much" },
    ];

    return (
        <div className="flex flex-col items-center w-full">
            {showLabels && (
                <div className="flex justify-between w-full mb-4 font-bold">
                    <span className="text-center w-1/5">{options[0].label}</span>
                    <span className="text-center w-1/5">{options[3].label}</span>
                    <span className="text-center w-1/5">{options[6].label}</span>
                </div>
            )}
             <div className="flex justify-between w-full">
                {options.map((option, index) => (
                    <div className="w-1/5 text-center">
                        <input
                            type="radio"
                            name={name}
                            value={option.value}
                            checked={selected === option.value}
                            onChange={onChange}
                            className="my-2"
                        />
                    </div>
                ))}
            </div>

        </div>
    );
}