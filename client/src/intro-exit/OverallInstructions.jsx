import React from "react";
import { Button } from "../components/Button";

export function OverallInstructions({ next }) {
  return (
    <div className="flex min-h-full w-full items-center justify-center bg-gray-50 px-4 py-8 sm:px-8">
      <div className="w-full max-w-3xl rounded-lg border border-gray-200 bg-white p-6 shadow-sm sm:p-8">
        <h1 className="text-2xl font-bold leading-8 text-gray-900">Overall Instructions</h1>
        <div className="mt-4 space-y-3 text-base leading-6 text-gray-700">
          <p>Please read the following instructions carefully before beginning the experiment.</p>
          <p>Detailed experiment instructions will be added here.</p>
        </div>
        <div className="mt-8 flex justify-end">
          <Button className="ml-0" handleClick={next} primary>
            Continue
          </Button>
        </div>
      </div>
    </div>
  );
}
