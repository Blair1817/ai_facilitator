import {
  usePlayer,
  usePlayers,
  useRound,
  useStage
} from "@empirica/core/player/classic/react";
import { Loading } from "@empirica/core/player/react";
import React from "react";
import { RenderMarkdown } from "./components/RenderMarkdown.jsx";
import { Timer } from "./components/Timer.jsx";

export function IceBreakerTransition({ position }) {
  const message = position === "before"
    ? "Get ready to meet your group in a quick icebreaker!"
    : "Now that we’re all acquainted, get ready for the task!";

  return (
    <div className="flex h-full w-full items-center justify-center bg-gray-50 px-4 py-8">
      <main className="w-full max-w-xl rounded-lg border-2 border-gray-300 bg-white px-8 py-7 text-center shadow-md">
        <h1 className="text-xl font-bold text-gray-900 sm:text-2xl">{message}</h1>
        <div className="mt-5">
          <Timer />
        </div>
      </main>
    </div>
  );
}

// Renders the "Introduction" (icebreaker) stage only. InitialDecision,
// Discussion, and FinalDecision are now dedicated top-level components (see
// client/src/stages/) rendered directly by Game.jsx, not through this file.
export function Stage() {
  const player = usePlayer();
  const players = usePlayers();
  const round = useRound();
  const stage = useStage();
  const taskVersion = round?.get("taskVersion");
  const introInstructions = taskVersion === "A"
    ? `## IceBreaker: Would You Rather...?

**Scroll down to review all IceBreaker instructions.**

**Round prompt:** Would you rather be able to speak every language fluently or play every musical instrument expertly?

### How to play

1. Choose one of the two options.
2. Post your choice in the chat and give a short reason.
3. If time allows, reply to a teammate whose answer is different from yours.
4. Practise tagging a group member: type \`@\`, select their nickname, and invite them to share their choice.

**Example of the format:** “I would choose the musical instruments because making music would be a fun way to connect with people.”

This activity is unrelated to the task candidates and Task Report. Please give every group member an opportunity to answer. The timer shows when the IceBreaker will end and the Initial Decision will begin.`
    : `## IceBreaker: Word Chain

**Scroll down to review all IceBreaker instructions.**

**Starting word:** Rocket

### How to play

1. The next word must begin with the final letter of the previous word.
2. Post only one word at a time, then let another participant continue the chain.
3. Avoid repeating a word that has already appeared.
4. Practise tagging a group member: type \`@\`, select their nickname, and invite them to post the next word.

**Example chain:** Rocket → Tiger → River → Rainbow

Start with **Rocket** in the chat and build the longest chain you can together. This activity is unrelated to the task candidates and Task Report. The timer shows when the IceBreaker will end and the Initial Decision will begin.`;

  if (player.stage.get("submit")) {
    if (players.length === 1) {
      return <Loading />;
    }

    return (
      <div className="text-center text-gray-400 pointer-events-none">
        Please wait for other player(s).
      </div>
    );
  }

  return (
    <div className="h-full w-full overflow-y-auto px-6 py-5">
      <div className="mx-auto w-full max-w-2xl rounded-lg border border-gray-200 bg-white p-5 shadow-sm">
        <RenderMarkdown markdownText={introInstructions} />
      </div>
    </div>
  );
}
