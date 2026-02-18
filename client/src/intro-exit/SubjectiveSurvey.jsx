import { usePlayer, useGame } from "@empirica/core/player/classic/react";
import React, { useState } from "react";
import { Alert } from "../components/Alert";
import { Button } from "../components/Button";

export function SubjectiveSurvey({ next }) {
    const labelClassName = "block text-md font-bold text-gray-700 my-2";
    const listClassName = "block text-md font-medium text-gray-700 my-2";
    const inputClassName =
        "appearance-none block w-full px-3 py-2 border border-gray-300 rounded-md shadow-sm placeholder-gray-400 focus:outline-none focus:ring-empirica-500 focus:border-empirica-500 sm:text-sm";
    const player = usePlayer();
    const game = useGame();
    const { facilitation } = game.get("treatment");
    const playerName = player.get("name");

    // Define state variables for each question
    const [question1, setQuestion1] = useState("");
    const [question2, setQuestion2] = useState("");
    const [question3, setQuestion3] = useState("");
    const [question4, setQuestion4] = useState("");
    const [question5, setQuestion5] = useState("");
    const [question6, setQuestion6] = useState("");
    const [question7, setQuestion7] = useState("");
    const [question8, setQuestion8] = useState("");
    const [question9, setQuestion9] = useState("");
    const [question10, setQuestion10] = useState("");
    const [question11, setQuestion11] = useState("");
    const [question12, setQuestion12] = useState("");
    const [question13, setQuestion13] = useState("");


    function handleSubmit(event) {
        event.preventDefault();
        player.set("subjectiveSurvey", {
            groupFreeText: question1,
            groupContribution: question2,
            groupInfluence: question3,
            groupProductive: question4,
            groupStructured: question5,
            groupCohesion: question6,
            facilitatorRoleFreetext: question7,
            facilitatorGroupFreetext: question8,
            facilitatorSharing: question9,
            facilitatorDistracting: question10,
            facilitatorSynthesis: question11,
            facilitatorFocus: question12,
            facilitatorPreference: question13,

        });
        next();
    }

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
                                    Please take a moment to describe your experience during the task
                                </h3>
                                <p className="mt-1 text-sm text-gray-500">
                                    Please answer the following short survey. You do not have to
                                    provide any information you feel uncomfortable with.
                                </p>
                            </div>

                            <div className="space-y-8 mt-9">
                                <div>
                                    <label htmlFor="question1" className={labelClassName}>
                                        How did you feel about your group during the task?
                                    </label>
                                    <div className="mt-1">
                                        <textarea
                                            id="question1"
                                            name="question1"
                                            type="text"
                                            rows={4}
                                            autoComplete="off"
                                            className={inputClassName}
                                            value={question1}
                                            onChange={(e) => setQuestion1(e.target.value)}
                                        />
                                    </div>
                                </div>

                                <div className={labelClassName}>Please rate your agreement with the following statements:</div>
                                <div className="flex">
                                    <label htmlFor="question2" className={`${listClassName} pt-15 w-4/10`}>
                                        I feel that I was able to contribute to the group discussion
                                    </label>
                                    <div className="w-6/10">
                                        <LikertScale
                                            selected={question2}
                                            name="question2"
                                            onChange={(e) => setQuestion2(e.target.value)}
                                            showLabels={true}
                                        />
                                    </div>
                                </div>

                                <div className="flex">
                                    <label htmlFor="question3" className={`${listClassName} w-4/10`}>
                                        I feel that I was able to influence the group's decision
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


                                <div className="flex">
                                    <label htmlFor="question4" className={`${listClassName} w-4/10`}>
                                        The group's discussion felt productive
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

                                <div className="flex">
                                    <label htmlFor="question5" className={`${listClassName} w-4/10`}>
                                        The group had a structured way of collecting and summarizing information to reach a decision
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

                                <RadioGroup
                                    question="If you were to do this task again, would you rather do it with the same group, or a new group of random people?"
                                    options={[
                                        { value: "same", label: "Same group I was in" },
                                        { value: "random", label: "A new group of random people" },
                                    ]}
                                    selectedOption={question6}
                                    onChange={(e) => setQuestion6(e.target.value)}
                                />


                                <div className="py-10"><hr className="border-gray-400 border-t-4" /></div>




                                {(playerName == "Facilitator") && <>
                                    <div>
                                        <label htmlFor="question7" className={`${labelClassName}`}>
                                            How did you feel about your role as the facilitator during the task? What went well? What could have gone better?
                                        </label>
                                        <div className="mt-1">
                                            <textarea
                                                id="question7"
                                                name="question7"
                                                type="text"
                                                rows={4}
                                                autoComplete="off"
                                                className={inputClassName}
                                                value={question7}
                                                onChange={(e) => setQuestion7(e.target.value)}
                                            />
                                        </div>
                                    </div>
                                </>}



                                {(facilitation != "none" && playerName != "Facilitator") && <><div>
                                    <label htmlFor="question8" className={`${labelClassName}`}>
                                        How did you feel about the facilitator during the task?
                                    </label>
                                    <div className="mt-1">
                                        <textarea
                                            id="question8"
                                            name="question8"
                                            type="text"
                                            rows={4}
                                            autoComplete="off"
                                            className={inputClassName}
                                            value={question8}
                                            onChange={(e) => setQuestion8(e.target.value)}
                                        />
                                    </div>
                                </div>

                                    <div className={labelClassName}>Please rate your agreement with the following statements:</div>
                                    <div className="flex">
                                        <label htmlFor="question9" className={`${listClassName} pt-15 w-4/10`}>
                                            The facilitator encouraged the group to share information
                                        </label>
                                        <div className="w-6/10">
                                            <LikertScale
                                                selected={question9}
                                                name="question9"
                                                onChange={(e) => setQuestion9(e.target.value)}
                                                showLabels={true}
                                            />
                                        </div>
                                    </div>

                                    <div className="flex">
                                        <label htmlFor="question10" className={`${listClassName} w-4/10`}>
                                            The facilitator was distracting
                                        </label>
                                        <div className="w-6/10">
                                            <LikertScale
                                                selected={question10}
                                                name="question10"
                                                onChange={(e) => setQuestion10(e.target.value)}
                                                showLabels={false}
                                            />
                                        </div>
                                    </div>

                                    <div className="flex">
                                        <label htmlFor="question11" className={`${listClassName} w-4/10`}>
                                        The facilitator helped the group summarize the information shared to reach a decision
                                        </label>
                                        <div className="w-6/10">
                                            <LikertScale
                                                selected={question11}
                                                name="question11"
                                                onChange={(e) => setQuestion11(e.target.value)}
                                                showLabels={false}
                                            />
                                        </div>
                                    </div>

                                    <div className="flex">
                                        <label htmlFor="question12" className={`${listClassName} w-4/10`}>
                                            The facilitator was able to keep the group focused on the task
                                        </label>
                                        <div className="w-6/10">
                                            <LikertScale
                                                selected={question12}
                                                name="question12"
                                                onChange={(e) => setQuestion12(e.target.value)}
                                                showLabels={false}
                                            />
                                        </div>
                                    </div>

                                    
                                </>}

                                {playerName != "Facilitator" && <>
                                    <RadioGroup
                                        question={`You completed this task ${facilitation == "none" ? "without a facilitator" : facilitation == "human" ? "with a human facilitator" : "with an AI facilitator"}. If you were to repeat this task, which would you prefer?`}
                                        options={[
                                            { value: "no", label: "No facilitator" },
                                            { value: "human", label: "A human facilitator" },
                                            { value: "ai", label: "An AI facilitator" },
                                        ]}
                                        selectedOption={question13}
                                        onChange={(e) => setQuestion13(e.target.value)}
                                    />
                                </>}

                                <div className="mb-12 text-right">
                                    <Button type="submit">Next</Button>
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
        { value: "1", label: "Strongly Disagree" },
        { value: "2", label: "" },
        { value: "3", label: "Neutral" },
        { value: "4", label: "" },
        { value: "5", label: "Strongly Agree" },
    ];

    return (
        <div className="flex flex-col items-center w-full">
            {showLabels && (
                <div className="flex justify-between w-full mb-4 font-bold">
                    <span className="text-center w-1/5">{options[0].label}</span>
                    <span className="text-center w-1/5">{options[2].label}</span>
                    <span className="text-center w-1/5">{options[4].label}</span>
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

export function RadioGroup({ question, options, selectedOption, onChange }) {
    return (
        <div className="mb-4">
            <label className="block text-md font-bold text-gray-700 mb-4">
                {question}
            </label>
            <div className="flex flex-col space-y-2">
                {options.map((option) => (
                    <label key={option.value} className="text-md font-medium text-gray-700">
                        <input
                            className="mr-2"
                            type="radio"
                            name={question}
                            value={option.value}
                            checked={selectedOption === option.value}
                            onChange={onChange}
                        />
                        {option.label}
                    </label>
                ))}
            </div>
        </div>
    );
}
