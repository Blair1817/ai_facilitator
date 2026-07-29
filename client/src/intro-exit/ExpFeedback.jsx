import { usePlayer, useGame } from "@empirica/core/player/classic/react";
import React, { useState } from "react";
import { Alert } from "../components/Alert";
import { Button } from "../components/Button";

export function ExpFeedback({ next }) {
    const labelClassName = "block text-md font-bold text-gray-700 my-2";
    const listClassName = "block text-md font-medium text-gray-700 my-2";
    const inputClassName =
        "appearance-none block w-full px-3 py-2 border border-gray-300 rounded-md shadow-sm placeholder-gray-400 focus:outline-none focus:ring-empirica-500 focus:border-empirica-500 sm:text-sm";
    const player = usePlayer();
    const game = useGame();
    const { facilitation } = game.get("treatment");

    // Define state variables for each question
    const [question1, setQuestion1] = useState("");
    const [submitting, setSubmitting] = useState(false);


    function handleSubmit(event) {
        event.preventDefault();
        if (submitting) {
            return;
        }
        setSubmitting(true);
        player.set("expFeedback", {
            expFeedback: question1,
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
                    <div className="space-y-8 divide-y divide-gray-200 mx-10%">
                        <div>
                            <div>
                                <h3 className="text-xl leading-6 font-medium text-gray-900">
                                    Do you have any other feedback about this study that you'd like to share?
                                </h3>
                            </div>
    
                            <div className="space-y-8 mt-9">
                                <div>
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
    
    
                                <div className="mb-12 text-right">
                                    <Button type="submit" disabled={submitting}>Exit survey and receive submission code</Button>
                                </div>
                            </div>
                        </div>
                    </div>
                </form>
            </div>
        </div>
    );
    
}
