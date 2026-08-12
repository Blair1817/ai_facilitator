import React, { useLayoutEffect, useRef } from "react";
import { Button } from "../components/Button";
import { usePlayer } from "@empirica/core/player/classic/react";


export function UserInterface() {
  const player = usePlayer();
  const scrollContainerRef = useRef(null);

  useLayoutEffect(() => {
    scrollContainerRef.current?.scrollTo(0, 0);
    document.getElementById("participant-scroll-root")?.scrollTo(0, 0);
    window.scrollTo(0, 0);
  }, []);

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
    <div ref={scrollContainerRef} className="h-full w-full overflow-y-auto bg-gray-50 px-4 py-8 sm:px-8">
      <main className="mx-auto w-full max-w-3xl rounded-lg border border-gray-200 bg-white p-6 shadow-sm sm:p-8">
        <article className="prose !max-w-none">
          <h1>Task Walkthrough</h1>
          <p><strong>Scroll down to review the full walkthrough.</strong></p>
          <section>
            <h2>1. Read the materials</h2>
            <p>Read the task information and your Task Report carefully. The report contains the information for this task. You will then complete a short review quiz.</p>
          </section>
          <section>
            <h2>2. Make an initial decision</h2>
            <p>Choose the option you currently think is most appropriate and rate your confidence from 0 to 100. This response is private.</p>
          </section>
          <section>
            <h2>3. Discuss with your group</h2>
            <p>After a short icebreaker, you will discuss the task for 10 minutes. Your Task Report will remain visible beside the chat.</p>
            <p>Use the chat to discuss information from the task materials and the available options. You may tag a group member by typing <code>@</code> followed by their nickname. The AI facilitator may also post brief messages during the discussion.</p>
          </section>
          <section>
            <h2>4. Record the final decision</h2>
            <p>After the discussion, record your group’s final decision. If your group did not reach a final decision, you will then complete a short set of individual questions. Your individual responses will not be shown to the other group members.</p>
          </section>
        </article>
        <div className="mt-8 flex justify-end border-t border-gray-100 pt-6">
          <Button handleClick={() => player.stage.set("submit", true)}>
            <span>Next</span>
          </Button>
        </div>
      </main>
    </div>
  );
}
