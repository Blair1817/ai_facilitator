import React from "react";

// Shown when Empirica reports player.ended === "game failed", i.e. the
// game.start callback threw. This is distinct from "all games filled up":
// the slots are not exhausted, but the session cannot begin because the
// server-side research-assignment write did not complete. The previous
// "All games have filled up!" copy in this slot was a client bug that
// mis-routed participants here on any non-terminal ended value.

export function GameFailedFallback() {
  return (
    <div className="h-screen flex items-center justify-center px-6">
      <div className="w-92 flex flex-col items-center text-center">
        <h2 className="text-black-700 font-medium text-xl">
          The study session could not be started
        </h2>
        <p className="mt-3 text-black">
          A technical problem prevented this session from beginning. Please
          refresh this page in a private / incognito window. If the problem
          persists, contact the research team.
        </p>
        <a
          className="mt-4 text-blue-600 underline"
          href="mailto:jingnan.zhang.24@ucl.ac.uk"
        >
          jingnan.zhang.24@ucl.ac.uk
        </a>
      </div>
    </div>
  );
}
