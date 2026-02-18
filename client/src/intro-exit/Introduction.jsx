import React from "react";
import { Button } from "../components/Button";
import { RenderMarkdown } from "../components/RenderMarkdown.jsx";
import { usePlayer, useGame } from "@empirica/core/player/classic/react";
import { generalInfo } from "./IntroContent.js";

export function Introduction({ next }) {
  const game = useGame();

  return (
    <div className="flex-col justify-center mx-20% mt-5%">
      <RenderMarkdown markdownText={generalInfo} />
      <div className="text-right pb-10px">
        <Button handleClick={next}>
          <p>Next</p>
        </Button>
      </div>
    </div>
  );
}


