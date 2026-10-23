import React, { useEffect, useRef, useState } from "react";
import {
  usePlayer,
  usePlayers,
  useRound,
} from "@empirica/core/player/classic/react";
import { Loading } from "@empirica/core/player/react";
import { RenderMarkdown } from "../components/RenderMarkdown.jsx";
import { taskBackgroundOnly } from "../intro-exit/Introduction.jsx";
import { Button } from "../components/Button";
import { clearDraftKeys, draftKey, usePersistentDraft } from "../hooks/usePersistentDraft.js";
import {
  evaluateReviewQuiz,
  getReviewQuiz,
} from "./reviewQuizConfig";

export function ReviewQuiz({ onNext, deadline } = {}) {
  const player = usePlayer();
  const players = usePlayers();
  const round = useRound();
  const taskVersion = round?.get("taskVersion") ?? null;
  const quiz = getReviewQuiz(taskVersion, round?.get("decisionOptions"));
  const answersDraftKey = draftKey({
    playerId: player.id,
    roundId: round?.id,
    form: "reviewQuiz",
    field: "answers",
  });
  const [answers, setAnswers] = usePersistentDraft(answersDraftKey, {});
  const [incorrectQuestionIds, setIncorrectQuestionIds] = useState([]);
  const [instructionsOpen, setInstructionsOpen] = useState(false);
  const instructionsRef = useRef(null);
  const feedbackRef = useRef(null);
  const instructions = taskBackgroundOnly(round?.get("generalInfo"));
  useEffect(() => {
    if (instructionsOpen && instructionsRef.current && !instructionsRef.current.open) {
      instructionsRef.current.showModal();
    }
  }, [instructionsOpen]);
  useEffect(() => {
    if (incorrectQuestionIds.length > 0) {
      feedbackRef.current?.focus();
      feedbackRef.current?.scrollIntoView({ block: "center" });
    }
  }, [incorrectQuestionIds]);
  const [isProcessing, setIsProcessing] = useState(false);
  const processingRef = useRef(false);

  if (!quiz) {
    return (
      <div className="h-full w-full flex items-center justify-center text-gray-500">
        This understanding check is not available. Please contact the research team.
      </div>
    );
  }

  if (player.stage.get("submit")) {
    if (players.length === 1) {
      return <Loading />;
    }
    return (
      <div className="h-full w-full flex items-center justify-center">
        <div className="text-center text-gray-400 pointer-events-none">
          You completed the understanding check.
          <br />
          Please wait for the other participant(s).
        </div>
      </div>
    );
  }

  const isComplete = quiz.questions.every((question) =>
    String(answers[question.id] ?? "").trim()
  );

  const setAnswer = (questionId, value) => {
    setAnswers((current) => ({ ...current, [questionId]: value }));
  };

  const handleSubmit = (event) => {
    event.preventDefault();
    if (!isComplete || processingRef.current) {
      return;
    }

    processingRef.current = true;
    setIsProcessing(true);
    const evaluation = evaluateReviewQuiz(taskVersion, answers);
    if (evaluation.allCorrect) {
      player.round.set("reviewQuizPassed", true);
      clearDraftKeys([answersDraftKey]);
      if (onNext) onNext(); else player.stage.set("submit", true);
      return;
    }

    setIncorrectQuestionIds(evaluation.incorrectQuestionIds);
    processingRef.current = false;
    setIsProcessing(false);
  };

  return (
    <div className="h-full w-full overflow-y-auto bg-gray-50">
      <dialog ref={instructionsRef} aria-labelledby="instructions-title"
        onClose={() => setInstructionsOpen(false)}
        className="w-full max-w-3xl max-h-[85vh] overflow-y-auto rounded-lg p-6 shadow-lg backdrop:bg-black/40">
        <h2 id="instructions-title" className="text-xl font-bold mb-4">Task instructions</h2>
        {instructions ? <RenderMarkdown markdownText={instructions} /> : (
          Object.entries(quiz.remediation).map(([key, section]) => (
            <section key={key} className="mb-4">
              <h3 className="font-semibold">{section.title}</h3>
              <p>{section.content}</p>
            </section>
          ))
        )}
        <div className="mt-6 text-right">
          <Button className="ml-0" handleClick={() => instructionsRef.current.close()}>Return to questions</Button>
        </div>
      </dialog>
      <form
        className="w-full max-w-4xl mx-auto px-4 sm:px-8 py-8 flex flex-col"
        onSubmit={handleSubmit}
      >
        <p className="text-xs uppercase tracking-wide text-gray-400 text-center mb-2">
          {round?.get("name")} · Task {taskVersion}
        </p>
        <h1 className="text-2xl font-bold text-center mb-3">Check your understanding</h1>
        <p className="text-sm text-gray-600 mb-4">
          Answer five short questions to check that you understand the task instructions.
          You can review the instructions at any time.
        </p>
        <div className="mb-6">
          <Button className="ml-0" handleClick={() => setInstructionsOpen(true)}>View instructions</Button>
        </div>
        <h2 className="text-lg font-semibold text-gray-800 mb-2">{quiz.title}</h2>
        <p className="text-sm text-gray-600 mb-8">{quiz.scenario}</p>
        <p className="mb-6 text-center text-sm font-bold text-gray-700">Scroll down to answer all five questions.</p>

        {incorrectQuestionIds.length > 0 && (
          <p ref={feedbackRef} tabIndex={-1} role="alert" className="mb-6 text-sm text-red-700">
            Please review the instructions below the highlighted questions and try again.
            Your previous choices have been kept.
          </p>
        )}
        <div className="space-y-8">
          {quiz.questions.map((question, questionIndex) => (
            <fieldset
              key={question.id}
              className={`w-full min-w-0 bg-white border rounded-lg p-5 ${incorrectQuestionIds.includes(question.id) ? "border-red-500" : "border-gray-200"}`}
            >
              <legend className="max-w-full whitespace-normal font-semibold leading-6 text-gray-800 px-1">
                {questionIndex + 1}. {question.prompt}
              </legend>

              {question.type === "number" ? (
                <input
                  type="number"
                  name={question.id}
                  value={answers[question.id] ?? ""}
                  onChange={(event) => setAnswer(question.id, event.target.value)}
                  className="mt-4 w-full px-3 py-2 border border-gray-300 rounded-md"
                  autoComplete="off"
                />
              ) : (
                <div className="mt-4 grid gap-3">
                  {question.options.map((option) => (
                    <label
                      key={option.value}
                      className="flex w-full min-w-0 items-start gap-3 text-sm leading-5 text-gray-700"
                    >
                      <input
                        type="radio"
                        name={question.id}
                        value={option.value}
                        checked={answers[question.id] === option.value}
                        onChange={(event) => setAnswer(question.id, event.target.value)}
                        className="mt-1 h-4 w-4 flex-none shrink-0 p-0 rounded-full"
                      />
                      <span className="min-w-0 flex-1">{option.label}</span>
                    </label>
                  ))}
                </div>
              )}
              {incorrectQuestionIds.includes(question.id) && (
                <section className="mt-4 rounded-md bg-gray-50 p-4" aria-label="Instruction to review">
                  <p className="text-sm font-semibold text-red-700 mb-2">
                    Please review the instruction below and try this question again.
                  </p>
                  <h3 className="text-sm font-semibold">{quiz.remediation[question.remediationKey].title}</h3>
                  <p className="text-sm text-gray-700 mt-1">{quiz.remediation[question.remediationKey].content}</p>
                </section>
              )}
            </fieldset>
          ))}
        </div>

        {!isComplete && (
          <p className="mt-6 text-sm text-gray-500">Please answer all five questions before submitting.</p>
        )}

        <div className="mt-6 text-right">
          <Button className="ml-0" type="submit" disabled={!isComplete || isProcessing}>
            {isProcessing ? "Submitting…" : (incorrectQuestionIds.length > 0 ? "Check answers again" : "Check answers")}
          </Button>
        </div>
      </form>
    </div>
  );
}
