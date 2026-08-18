import React from "react";

export function GamesFull() {
  return (
    <div className="h-screen flex items-center justify-center">
      <div className="w-92 flex flex-col items-center">
        <h2 className="text-black-700 font-medium text-xl">All games have filled up!</h2>
        <p className="mt-2 text-black text-center">Unfortunately, all available games have been filled. Please close this page.</p>
      </div>
    </div>
  );
}

export function SessionStartFailed() {
  return (
    <div className="h-screen flex items-center justify-center px-6">
      <div className="w-full max-w-xl rounded border border-gray-200 bg-white p-8 text-center shadow-sm">
        <h2 className="text-black-700 font-semibold text-2xl">Unable to start this session</h2>
        <p className="mt-4 text-black leading-relaxed">
          Your session could not be started safely because its study assignment could not be recorded.
          Please close this page and contact the research team.
        </p>
        <a
          className="mt-4 inline-block font-medium text-blue-700 underline"
          href="mailto:jingnan.zhang.24@ucl.ac.uk"
        >
          jingnan.zhang.24@ucl.ac.uk
        </a>
      </div>
    </div>
  );
}
