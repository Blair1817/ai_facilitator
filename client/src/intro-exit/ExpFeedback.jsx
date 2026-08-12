import { usePlayer, useGame } from "@empirica/core/player/classic/react";
import React, { useEffect, useState } from "react";
import { Alert } from "../components/Alert";
import { Button } from "../components/Button";
import { clearDraftKeys, draftKey, usePersistentDraft } from "../hooks/usePersistentDraft.js";

export function ExpFeedback({ next }) {
    const labelClassName = "block text-md font-bold text-gray-700 my-2";
    const listClassName = "block text-md font-medium text-gray-700 my-2";
    const inputClassName =
        "appearance-none block w-full px-3 py-2 border border-gray-300 rounded-md shadow-sm placeholder-gray-400 focus:outline-none focus:ring-empirica-500 focus:border-empirica-500 sm:text-sm";
    const player = usePlayer();
    // Phase 6.2 cleanup: previously read `const { facilitation } =
    // game.get("treatment")` here. v2 design dropped the treatment-level
    // `facilitation` factor, so the value is always undefined and was
    // never actually used in this component. Removed.
    const game = useGame();

    // Define state variables for each question
    const feedbackDraftKey = draftKey({ playerId: player.id, form: "expFeedback", field: "question1" });
    const [question1, setQuestion1] = usePersistentDraft(feedbackDraftKey, "");
    const [submitting, setSubmitting] = useState(false);
    const [pendingSubmissionId, setPendingSubmissionId] = useState(null);
    const storedSubmission = player.get("expFeedback");

    useEffect(() => {
        if (!pendingSubmissionId || storedSubmission?.submissionId !== pendingSubmissionId) return;
        clearDraftKeys([feedbackDraftKey]);
        next();
    }, [pendingSubmissionId, storedSubmission?.submissionId]);


    function handleSubmit(event) {
        event.preventDefault();
        if (submitting) {
            return;
        }
        setSubmitting(true);
        const submissionId = `${player.id}:${Date.now()}`;
        setPendingSubmissionId(submissionId);
        player.set("expFeedback", {
            submissionId,
            expFeedback: question1,
            submittedAt: Date.now(),
        });
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
