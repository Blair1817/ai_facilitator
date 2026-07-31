import React, { useState } from "react";
import {
  useGame,
  usePlayer,
  usePlayers,
  useRound,
} from "@empirica/core/player/classic/react";
import { Chat } from "../components/CustomChat";
import { PlayerList } from "../components/PlayerList.jsx";
import { Profile } from "../Profile";
import { Button } from "../components/Button";
import { PlayerSpecificInfo } from "../components/PlayerSpecificInfo.jsx";
import { RenderMarkdown } from "../components/RenderMarkdown.jsx";

// Renders the "Task" stage (the group discussion). Kept as its own
// self-contained page -- like InitialDecision.jsx/FinalDecision.jsx -- rather
// than living inside the generic Stage.jsx dispatcher, so round/task context
// and the private-info section can be laid out clearly per the current
// design (top banner, shared info + private info on one side, chat on the
// other).
export function Discussion() {
  const game = useGame();
  const round = useRound();
  const roundName = round?.get("name");
  // Round-first with game-level fallback (defensive; callbacks.js now always
  // sets these round-scoped). Field name matches Blair's callbacks.js exactly:
  // round.set("decisionOptions", task["decisionOptions"]) -- NOT
  // "taskDecisionOptions" (an old 2nd field name that no longer matches).
  const generalInfo = round?.get("generalInfo") ?? game.get("generalInfo");
  // decisionOptions is now an array of {id, label} objects (Blair's
  // HPTConfig.json schema), not plain strings -- see the .map/.join below.
  const decisionOptions = round?.get("decisionOptions") ?? game.get("decisionOptions");
  const totalRounds = game.get("totalRounds") ?? 2;
  // round.get("index") is the single source of truth for round ordering:
  // proven framework-set (Empirica's own addRound(), see
  // chunk-CA6WWEPS.js, sets an immutable 0-based "index" on every round it
  // creates -- independent of callbacks.js), 0-based. roundNumber is the
  // 1-based value derived from it for "Round X of N" display.
  const roundIndex = round?.get("index") ?? null;
  const roundNumber = typeof roundIndex === "number" ? roundIndex + 1 : null;

  return (
    <div className="h-full w-full flex flex-col">
      <div className="px-4 pt-3 pb-2 border-b border-gray-200 text-center flex-shrink-0">
        {roundNumber ? (
          <p className="text-xs uppercase tracking-wide text-gray-400">
            Round {roundNumber} of {totalRounds}
          </p>
        ) : (
          roundName && (
            <p className="text-xs uppercase tracking-wide text-gray-400">{roundName}</p>
          )
        )}
        <h1 className="text-lg font-bold text-gray-800">Group Discussion</h1>
      </div>

      <div className="flex-1 flex min-h-0">
        <div className="w-1/2 h-full flex flex-col overflow-y-auto px-4 py-3 border-r border-gray-200">
          <div className="mb-3">
            <Profile />
          </div>

          {!generalInfo && !decisionOptions?.length && (
            <div className="text-center text-gray-500 my-6">
              This session is not yet available. Please contact the research team.
            </div>
          )}

          {generalInfo && (
            <div className="mb-4">
              <RenderMarkdown markdownText={generalInfo} />
            </div>
          )}

          {decisionOptions && decisionOptions.length > 0 && (
            <div className="mb-4 text-sm text-gray-600">
              <span className="font-semibold">Options under discussion: </span>
              {decisionOptions.map((option) => option.label).join(", ")}
            </div>
          )}

          <div className="border-2 border-empirica-200 rounded-lg p-2 mb-4">
            <p className="text-xs font-bold uppercase tracking-wide text-empirica-700 mb-1 text-center">
              Your private information (only visible to you)
            </p>
            <PlayerSpecificInfo />
          </div>

          <ReadyToDecidePanel />
        </div>

        <div className="w-1/2 h-full flex flex-col">
          <div className="w-full px-4 pt-3">
            <PlayerList />
          </div>
          <div className="w-full flex-grow overflow-y-auto overflow-x-hidden px-2">
            {/*
              MIGRATED from old 2nd: scope={game} (not `round`) is
              intentional -- Empirica's Chat component itself only supports
              game-scoped chat storage, and server/src/callbacks.js's
              AI-trigger listener also reads/writes at the game level -- it
              isolates rounds via the attribute NAME instead (chat_round_0 /
              chat_round_1), keyed off the round's own index. This must match
              callbacks.js's `chatKey = \`chat_round_${roundIndex}\`` exactly,
              or participant messages and the AI-trigger listener silently
              stop seeing each other. Without this fix, this stayed on the
              static "chat" attribute, which callbacks.js's chat_round_0/
              chat_round_1 listeners never observe -- messages would never
              reach the AI-trigger logic in either round.
            */}
            <Chat scope={game} attribute={`chat_round_${roundIndex ?? 0}`} />
          </div>
        </div>
      </div>
    </div>
  );
}

// "Ready to make the final decision" control, ported from the previous
// Stage.jsx implementation unchanged in behavior. Ready state is stored via
// player.stage.set("submit", ...) -- the same Empirica-synced playerStage
// attribute InitialDecision.jsx/FinalDecision.jsx use, and the framework's
// own built-in "playerStage submit" listener (see
// node_modules/@empirica/core/dist/chunk-CA6WWEPS.js) automatically ends the
// stage's timer early once every player in the game has submit=true. That is
// a built-in framework behavior, not something implemented here.
function ReadyToDecidePanel() {
  const player = usePlayer();
  const players = usePlayers();
  const [toggling, setToggling] = useState(false);

  const isReady = Boolean(player.stage.get("submit"));
  const readyCount = players.filter((p) => Boolean(p.stage?.get("submit"))).length;
  const totalCount = players.length;
  const allReady = totalCount > 0 && readyCount === totalCount;

  const handleToggle = () => {
    if (toggling || allReady) {
      return;
    }
    setToggling(true);
    player.stage.set("submit", !isReady);
    // Brief lock to absorb rapid double-clicks while the synced attribute
    // catches up to the new value; does not block legitimate later toggles.
    setTimeout(() => setToggling(false), 300);
  };

  return (
    <div className="mt-4 pt-4 border-t border-gray-200 text-center">
      <p className="text-sm text-gray-600 mb-2">
        {readyCount} of {totalCount} participants are ready
      </p>
      <Button handleClick={handleToggle} disabled={toggling || allReady}>
        <p>{isReady ? "Cancel ready" : "Ready to make the final decision"}</p>
      </Button>
      {isReady && !allReady && (
        <p className="text-xs text-gray-400 mt-2">
          Waiting for other participant(s) to be ready…
        </p>
      )}
    </div>
  );
}
