import React from "react";
import { Button } from "../components/Button";
import { usePlayer, useGame, useRound } from "@empirica/core/player/classic/react";


export function UserInterface() {
  const player = usePlayer();
  const game = useGame();
  const round = useRound();
  const { gameDuration } = game.get("treatment");
  const facilitation = round?.get("facilitation");

  if (player.stage.get("submit")) {
    return (
      <div className="h-full w-full flex items-center justify-center">
        <div className="text-center text-gray-400 pointer-events-none">
          Walkthrough completed.
          <br />
          Please wait for the other participant(s).
        </div>
      </div>
    );
  }

  return (
    <div className="flex-col justify-center mx-20% mt-5%">
      <div className="prose !max-w-none">
        <h1> Task walkthrough:</h1>
        <ul className="space-y-4">
          <li><strong>During the task, you'll be assigned a color as a nickname, and be able to chat with your group members using the chat window in the right half of the screen.</strong></li>
          <li><strong>In the chat window, you can use "@" to tag another member of the committee in your message.</strong></li>
          {facilitation != "none" && <li><strong>Other than the members of the committee, there will be {facilitation == "human" ? "a human": "an AI"} facilitator whose role is to listen to the conversation and support the group as you reach a decision.</strong> You can also tag the facilitator in your messages using "@" to address them directly.</li>}
          <li><strong>On the left side of the screen, you'll be able to review information about the task, and view a research report that was prepared for you before the meeting.</strong></li>
          <li><strong>You will have a total of {gameDuration} minutes to discuss the decision as a group;</strong> the remaining time is shown at the top of the screen. After the timer is up, you will:
            <ol>
              <li>Submit your final individual decision.</li>
              <li>Complete the questionnaire for this task.</li>
            </ol>
          </li>
        </ul>
      </div>
      <div className="flex mt-10 justify-end">
        <div className="text-right">
          <Button handleClick={() => player.stage.set("submit", true)} autoFocus>
            <p>Next</p>
          </Button>
        </div>
      </div>
    </div>
  );
}

