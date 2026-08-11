import React, { useRef, useState } from "react";
import {
  usePlayer,
  usePlayers,
  useRound,
} from "@empirica/core/player/classic/react";
import { Loading } from "@empirica/core/player/react";
import { Button } from "../components/Button";
import {
  clearIncorrectReviewQuizAnswers,
  evaluateReviewQuiz,
  getReviewQuiz,
  getReviewQuizRemediation,
} from "./reviewQuizConfig";

export function ReviewQuiz() {
  const player = usePlayer();
  const players = usePlayers();
  const round = useRound();
  const taskVersion = round?.get("taskVersion") ?? null;
  const quiz = getReviewQuiz(taskVersion);
  const [answers, setAnswers] = useState({});
  const [remediationSections, setRemediationSections] = useState([]);
  const [isProcessing, setIsProcessing] = useState(false);
  const processingRef = useRef(false);

  if (!quiz) {
    return (
      <div className="h-full w-full flex items-center justify-center text-gray-500">
        This Review Quiz is not available. Please contact the research team.
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
          You passed the Review Quiz.
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
      player.stage.set("submit", true);
      return;
    }

    setAnswers((currentAnswers) =>
      clearIncorrectReviewQuizAnswers(currentAnswers, evaluation.incorrectQuestionIds)
    );
    setRemediationSections(
      getReviewQuizRemediation(taskVersion, evaluation.incorrectQuestionIds)
    );
    processingRef.current = false;
    setIsProcessing(false);
  };

  const returnToQuiz = () => {
    setRemediationSections([]);
  };

  if (remediationSections.length > 0) {
    return (
      <div className="h-full w-full overflow-y-auto bg-gray-50">
        <div className="max-w-3xl mx-auto px-8 py-10">
          <h1 className="text-2xl font-bold text-center mb-3">Review the Task Information</h1>
          <p className="text-sm text-gray-600 text-center mb-8">
            Please review the relevant experiment information before trying the unanswered questions again.
          </p>
          <p className="mb-6 text-center text-sm font-bold text-gray-700">Scroll down to review all relevant information.</p>
          <div className="space-y-5">
            {remediationSections.map((section) => (
              <section key={section.key} className="bg-white border border-gray-200 rounded-lg p-5">
                <h2 className="font-semibold text-gray-800 mb-2">{section.title}</h2>
                <p className="text-sm text-gray-600">{section.content}</p>
              </section>
            ))}
          </div>
          <div className="mt-8 text-right">
            <Button className="ml-0" handleClick={returnToQuiz}>
              Return to Review Quiz
            </Button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="h-full w-full overflow-y-auto bg-gray-50">
      <form
        className="w-full max-w-4xl mx-auto px-4 sm:px-8 py-8 flex flex-col"
        onSubmit={handleSubmit}
      >
        <p className="text-xs uppercase tracking-wide text-gray-400 text-center mb-2">
          {round?.get("name")} · Task {taskVersion}
        </p>
        <h1 className="text-2xl font-bold text-center mb-3">Review Quiz</h1>
        <h2 className="text-lg font-semibold text-gray-800 mb-2">{quiz.title}</h2>
        <p className="text-sm text-gray-600 mb-8">{quiz.scenario}</p>
        <p className="mb-6 text-center text-sm font-bold text-gray-700">Scroll down to answer all five questions.</p>

        <div className="space-y-8">
          {quiz.questions.map((question, questionIndex) => (
            <fieldset
              key={question.id}
              className="w-full min-w-0 bg-white border border-gray-200 rounded-lg p-5"
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
            </fieldset>
          ))}
        </div>

        {!isComplete && (
          <p className="mt-6 text-sm text-gray-500">Please answer all five questions before submitting.</p>
        )}

        <div className="mt-6 text-right">
          <Button className="ml-0" type="submit" disabled={!isComplete || isProcessing}>
            {isProcessing ? "Submitting…" : "Submit Review Quiz"}
          </Button>
        </div>
      </form>
    </div>
  );
}
