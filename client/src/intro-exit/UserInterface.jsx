import React from "react";
import { Button } from "../components/Button";
import { usePlayer, useGame } from "@empirica/core/player/classic/react";


export function UserInterface({ previous, next }) {
  const game = useGame();
  const { facilitation, gameDuration } = game.get("treatment");

  return (
    <div className="flex-col justify-center mx-20% mt-5%">
      <div className="prose !max-w-none">
        <h1> Task walkthrough:</h1>
        <ul className="space-y-4">
          <li><strong>During the task, you'll be assigned a color as a nickname, and be able to chat with your group members using the chat window in the right half of the screen.</strong></li>
          <li><strong>In the chat window, you can use "@" to tag another member of the committee in your message.</strong></li>
          {facilitation != "none" && <li><strong>Other than the members of the committee, there will be {facilitation == "human" ? "a human": "an AI"} facilitator whose role is to listen to the conversation and support the group as you reach a decision.</strong> You can also tag the facilitator in your messages using "@" to address them directly.</li>}
          <li><strong>On the left side of the screen, you'll be able to review information about the task, and view a research report that was prepared for you before the meeting.</strong></li>
          <li><strong>You will have a total of {gameDuration} minutes to discuss the decision as a group;</strong> the remaining time is shown at the top of the screen. After the timer is up, you will automatically proceed to the exit process:
            <ol>
              <li>Report the option your group chose. If you are uncertain or your group did not reach a shared decision, choose the option you found most convincing.</li>
              <li>Complete all steps of the exit survey.</li>
            </ol>
          </li>
        </ul>
      </div>
      <div className="flex mt-10 justify-between">
        <div className="text-left">
          <Button handleClick={previous} autoFocus>
            <p>Previous</p>
          </Button>
        </div>
        <div className="text-right">
          <Button handleClick={next} autoFocus>
            <p>Next</p>
          </Button>
        </div>
      </div>
    </div>
  );
}


