import React, { useEffect, useRef, useState } from "react";
import {
  useGame,
  usePlayer,
  usePlayers,
  useRound,
  useStage,
} from "@empirica/core/player/classic/react";
import { Chat } from "../components/CustomChat";
import { PlayerList } from "../components/PlayerList.jsx";
import { Profile } from "../Profile";
import { Button } from "../components/Button";
import { PlayerSpecificInfo } from "../components/PlayerSpecificInfo.jsx";

// Renders the "Task" stage (the group discussion). Kept as its own
// self-contained page -- like InitialDecision.jsx/FinalDecision.jsx -- rather
// than living inside the generic Stage.jsx dispatcher, so round/task context
// and the Task Report can be laid out clearly per the current
// design (top banner, Task Report on one side, chat on the
// other).
export function Discussion() {
  const game = useGame();
  const round = useRound();
  // Round-first with game-level fallback (defensive; callbacks.js now always
  // sets these round-scoped). Field name matches Blair's callbacks.js exactly:
  // round.set("decisionOptions", task["decisionOptions"]) -- NOT
  // "taskDecisionOptions" (an old 2nd field name that no longer matches).
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
    <div className="h-full w-full overflow-x-auto">
      <DiscussionAdvanceGuard />
      <div className="flex h-full min-h-0 min-w-[960px]">
        <div className="flex h-full min-h-0 min-w-0 w-3/5 flex-col border-r border-gray-200 px-4 py-3">
          <div className="sticky top-0 z-10 mb-3 flex-none bg-white">
            <Profile />
          </div>

          <div className="mb-4 flex-none text-center">
            {roundNumber && (
              <p className="mb-1 text-xs uppercase tracking-wide text-gray-400">
                Round {roundNumber} of {totalRounds}
              </p>
            )}
            <h1 className="text-lg font-bold text-gray-900">
              Review the information available below, and discuss the options with your group.
            </h1>
            <p className="mt-1 text-sm text-gray-600">
              (The discussion will end when time runs out or when all participants are ready to make the final decision.)
            </p>
          </div>

          {!decisionOptions?.length && (
            <div className="text-center text-gray-500 my-6">
              This session is not yet available. Please contact the research team.
            </div>
          )}

          <PlayerSpecificInfo mode="compact" className="min-h-0 flex-1" />

          <ReadyToDecidePanel />

        </div>

        <div className="flex h-full min-h-0 min-w-0 w-2/5 flex-col">
          <div className="w-full flex-none px-4 pt-3">
            <PlayerList />
          </div>
          <div className="min-h-0 w-full flex-1 overflow-hidden px-2">
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

// Empirica normally advances a stage through its internal Step transition.
// This guard only requests the same transition conditions from the server;
// it never advances the client by itself. The server independently verifies
// either unanimous readiness or expiry of the server-authored deadline.
function DiscussionAdvanceGuard() {
  const game = useGame();
  const player = usePlayer();
  const players = usePlayers();
  const round = useRound();
  const stage = useStage();
  const lastRequestKey = useRef(null);
  const deadline = game.get("deadline");
  const allReady = players.length > 0
    && players.every((participant) => Boolean(participant.stage?.get("submit")));

  useEffect(() => {
    const requestAdvance = (reason) => {
      const requestKey = `${stage.id}:${reason}`;
      if (lastRequestKey.current === requestKey) return;
      lastRequestKey.current = requestKey;
      player.set("discussionAdvanceRequest", {
        requestId: globalThis.crypto?.randomUUID?.() ?? `${player.id}-${Date.now()}`,
        roundId: round?.id ?? null,
        stageId: stage.id,
        reason,
        requestedAt: Date.now(),
      });
    };

    if (allReady) {
      requestAdvance("all_ready");
      return undefined;
    }
    if (!Number.isFinite(deadline)) return undefined;

    const delay = Math.max(0, deadline - Date.now()) + 100;
    const timeout = setTimeout(() => requestAdvance("deadline_reached"), delay);
    return () => clearTimeout(timeout);
  }, [allReady, deadline, player, round?.id, stage.id]);

  return null;
}

// Empirica ends the stage early once every participant has set the synced
// player-stage submit flag. Until then, each participant can cancel readiness.
function ReadyToDecidePanel() {
  const player = usePlayer();
  const players = usePlayers();
  const [toggling, setToggling] = useState(false);

  const isReady = Boolean(player.stage.get("submit"));
  const readyCount = players.filter((participant) => Boolean(participant.stage?.get("submit"))).length;
  const totalCount = players.length;
  const allReady = totalCount > 0 && readyCount === totalCount;

  const handleToggle = () => {
    if (toggling || allReady) return;
    setToggling(true);
    player.stage.set("submit", !isReady);
    setTimeout(() => setToggling(false), 300);
  };

  return (
    <div className="mt-4 border-t border-gray-200 pt-4 text-center">
      <p className="mb-2 text-sm text-gray-600">
        {readyCount} of {totalCount} participants are ready
      </p>
      <Button handleClick={handleToggle} disabled={toggling || allReady}>
        <span>{isReady ? "Cancel ready" : "Ready to make the final decision"}</span>
      </Button>
      {isReady && !allReady && (
        <p className="mt-2 text-xs text-gray-400">
          Waiting for other participant(s) to be ready…
        </p>
      )}
    </div>
  );
}
