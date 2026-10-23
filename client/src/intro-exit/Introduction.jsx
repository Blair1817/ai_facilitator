import React, { useEffect, useRef } from "react";
import { Button } from "../components/Button";
import { RenderMarkdown } from "../components/RenderMarkdown.jsx";
import { usePlayer, useRound } from "@empirica/core/player/classic/react";
import { draftKey, usePersistentDraft } from "../hooks/usePersistentDraft.js";

export function taskBackgroundOnly(markdown) {
  if (typeof markdown !== "string") return "";
  const firstCandidateSection = markdown.indexOf("\n## ");
  return firstCandidateSection >= 0 ? markdown.slice(0, firstCandidateSection) : markdown;
}

export function Introduction({ onNext, deadline } = {}) {
  const player = usePlayer();
  const round = useRound();
  const generalInfo = round?.get("generalInfo");
  const taskBackground = taskBackgroundOnly(generalInfo);
  const taskVersion = round?.get("taskVersion");
  const [taskInstructionsSeen, setTaskInstructionsSeen] = usePersistentDraft(
    draftKey({ playerId: player.id, roundId: round?.id, form: "taskInstructions", field: "seen" }),
    false,
  );
  const taskInstructionsRef = useRef(null);

  useEffect(() => {
    if (!taskInstructionsSeen
      && taskInstructionsRef.current && !taskInstructionsRef.current.open) {
      taskInstructionsRef.current.showModal();
    }
  }, [taskInstructionsSeen]);

  const closeTaskInstructions = () => {
    setTaskInstructionsSeen(true);
    taskInstructionsRef.current?.close();
  };

  if (player.stage.get("submit")) {
    return (
      <div className="h-full w-full flex items-center justify-center">
        <div className="text-center text-gray-400 pointer-events-none">
          Task information reviewed.
          <br />
          Please wait for the other participant(s).
        </div>
      </div>
    );
  }

  if (!taskBackground) {
    return (
      <div className="h-full w-full flex items-center justify-center text-gray-500">
        This task information is not available. Please contact the research team.
      </div>
    );
  }

  return (
    <div className="h-full w-full overflow-y-auto bg-gray-50 px-4 py-8 sm:px-8">
      <dialog
        ref={taskInstructionsRef}
        aria-labelledby="task-instructions-title"
        onCancel={closeTaskInstructions}
        className="w-full max-w-3xl max-h-[85vh] overflow-y-auto rounded-lg p-6 shadow-lg backdrop:bg-black/40 sm:p-8"
      >
        <article className="space-y-5 text-gray-700">
          <h1 id="task-instructions-title" className="text-2xl font-bold text-gray-900">Task Instructions</h1>
          <section>
            <h2 className="text-lg font-semibold text-gray-900">1. Read the task information</h2>
            <p className="mt-1">Read the Task Information carefully. You will then complete a short Review Quiz to check your understanding of the task.</p>
          </section>
          <section>
            <h2 className="text-lg font-semibold text-gray-900">2. Make an initial decision</h2>
            <p className="mt-1">After the Review Quiz, choose the option you initially consider most suitable and rate your confidence from 0 to 100.</p>
          </section>
          <section>
            <h2 className="text-lg font-semibold text-gray-900">3. Discuss with your group</h2>
            <p className="mt-1">You will discuss the task in a group of three for up to 15 minutes. Use the chat to share and compare the information available to your group, and work together to agree on one final choice.</p>
          </section>
          <section>
            <h2 className="text-lg font-semibold text-gray-900">4. Record the final decision</h2>
            <p className="mt-1">After the discussion, each group member will independently report the option they believe the group agreed on, rate their confidence in that outcome, and indicate whether they personally agree with it.</p>
            <p className="mt-2">If you do not personally agree, you will also provide your own preferred option and briefly explain your reasons on the same page.</p>
          </section>
        </article>
        <div className="mt-8 flex justify-end border-t border-gray-100 pt-6">
          <Button className="ml-0" handleClick={closeTaskInstructions}>Continue to Task Information</Button>
        </div>
      </dialog>
      <main className="mx-auto w-full max-w-3xl rounded-lg border border-gray-200 bg-white p-6 shadow-sm sm:p-8">
      <p className="text-xs uppercase tracking-wide text-gray-400 text-center mb-2">
        {round?.get("name")} · Task {taskVersion}
      </p>
      <RenderMarkdown markdownText={taskBackground} />
      <div className="mt-8 text-right">
        <Button handleClick={() => onNext ? onNext() : player.stage.set("submit", true)}>
          <p>Continue</p>
        </Button>
      </div>
      </main>
    </div>
  );
}
