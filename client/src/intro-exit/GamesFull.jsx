import React, { useState } from "react";

export function GamesFull() {
  return (
    <div className="h-screen flex items-center justify-center">
      <div className="w-92 flex flex-col items-center">
        <h2 className="text-black-700 font-medium text-xl">All games have filled up!</h2>
        <p className="mt-2 text-black text-justify font-bold">Unfortunately, all available games have been filled. Please submit the following code to complete the study:</p>
        <br/>
        <p className="text-black text-justify font-bold text-4xl">[INSERT CODE HERE]</p>
      </div>
    </div>
  );
}
