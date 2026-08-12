import React from "react";
import { Button } from "../components/Button";

export function OverallInstructions({ next }) {
  return (
    <div className="flex min-h-full w-full items-center justify-center bg-gray-50 px-4 py-8 sm:px-8">
      <main className="w-full max-w-3xl rounded-lg border border-gray-200 bg-white p-6 shadow-sm sm:p-8">
        <h1 className="text-2xl font-bold leading-8 text-gray-900">Overall Instructions</h1>
        <div className="mt-4 space-y-4 text-base leading-6 text-gray-700">
          <section>
            <h2 className="text-lg font-semibold leading-6 text-gray-900">What you will do</h2>
            <p className="mt-1">You will work in a group of three and complete two different decision-making tasks, with a short break between them. For each task, you will read the materials, complete a short knowledge check, make a private initial decision, discuss the options, record your group’s final decision, and answer private follow-up questions.</p>
          </section>

          <section>
            <h2 className="text-lg font-semibold leading-6 text-gray-900">Use only the study information</h2>
            <p className="mt-1">Base your decisions only on the materials provided and your group chat. Do not search online, use external AI tools, consult other people, or discuss the task outside your assigned group.</p>
          </section>

          <section>
            <h2 className="text-lg font-semibold leading-6 text-gray-900">Chat, AI, and privacy</h2>
            <p className="mt-1">Use the chat to share information and compare options. You may tag a group member with <strong>@</strong> and their nickname. An AI facilitator may occasionally support the discussion; you may address it with <strong>@[Facilitator]</strong>, but it will not decide for your group.</p>
            <p className="mt-2">You will use a colour nickname. Chat messages and the group decision are visible to your group; your other responses are private. Do not share personal or sensitive information in the chat.</p>
          </section>

          <section>
            <h2 className="text-lg font-semibold leading-6 text-gray-900">During the study</h2>
            <p className="mt-1">Keep this page open, do not refresh it, and follow each page’s instructions. You cannot send messages after a timed discussion ends. If a technical problem occurs, contact <a className="break-all font-medium text-blue-700 underline sm:break-normal" href="mailto:jingnan.zhang.24@ucl.ac.uk">jingnan.zhang.24@ucl.ac.uk</a>.</p>
          </section>
        </div>
        <div className="mt-8 flex justify-end border-t border-gray-100 pt-6">
          <Button className="ml-0" handleClick={next}>
            Continue
          </Button>
        </div>
      </main>
    </div>
  );
}
