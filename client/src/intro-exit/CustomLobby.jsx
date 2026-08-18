import React from "react";
import { usePlayer, useGame } from "@empirica/core/player/classic/react";
import { ConnectionRecovery } from "./ConnectionRecovery";

export function CustomLobby() {
    const player = usePlayer();
    const game = useGame();

    if (!player || !game) {
        return <ConnectionRecovery />;
    }

    const treatment = player.get("treatment");
    if (!treatment || !treatment.playerCount) {
        console.warn("lobby: no treatment found on player");
        return (
            <div className="flex h-full items-center justify-center px-6">
                <div className="max-w-xl text-center">
                    <h3 className="text-2xl font-medium text-gray-900">
                        Session information is still loading
                    </h3>
                    <p className="mt-3 text-lg text-gray-600">
                        Please wait a moment. If this message remains, use the
                        reconnect button below.
                    </p>
                    <button
                        type="button"
                        className="mt-5 rounded bg-empirica-600 px-5 py-3 text-white"
                        onClick={() => window.location.reload()}
                    >
                        Reconnect
                    </button>
                </div>
            </div>
        );
    }

    // Empirica does not reliably publish ParticipantChange events before a
    // Classic game starts, so usePlayers() can stay undefined throughout the
    // lobby. The server updates this count whenever a participant completes
    // the intro. Fall back to one only during the brief propagation window for
    // the current participant's own introDone write.
    const readyCount = Number(game.get("lobbyReadyCount"));
    const assignedPlayerCount = Number.isInteger(readyCount) && readyCount > 0
        ? Math.min(readyCount, treatment.playerCount)
        : 1;

    return (
        <div className="flex h-full items-center justify-center">
            <div className="text-center">
                <svg
                    xmlns="http://www.w3.org/2000/svg"
                    viewBox="0 0 640 512"
                    className="mx-auto h-12 w-12 text-gray-400"
                    stroke="none"
                    fill="currentColor"
                    aria-hidden="true"
                >
                    <path d="M544 224c44.2 0 80-35.8 80-80s-35.8-80-80-80-80 35.8-80 80 35.8 80 80 80zm0-128c26.5 0 48 21.5 48 48s-21.5 48-48 48-48-21.5-48-48 21.5-48 48-48zM320 256c61.9 0 112-50.1 112-112S381.9 32 320 32 208 82.1 208 144s50.1 112 112 112zm0-192c44.1 0 80 35.9 80 80s-35.9 80-80 80-80-35.9-80-80 35.9-80 80-80zm244 192h-40c-15.2 0-29.3 4.8-41.1 12.9 9.4 6.4 17.9 13.9 25.4 22.4 4.9-2.1 10.2-3.3 15.7-3.3h40c24.2 0 44 21.5 44 48 0 8.8 7.2 16 16 16s16-7.2 16-16c0-44.1-34.1-80-76-80zM96 224c44.2 0 80-35.8 80-80s-35.8-80-80-80-80 35.8-80 80 35.8 80 80 80zm0-128c26.5 0 48 21.5 48 48s-21.5 48-48 48-48-21.5-48-48 21.5-48 48-48zm304.1 180c-33.4 0-41.7 12-80.1 12-38.4 0-46.7-12-80.1-12-36.3 0-71.6 16.2-92.3 46.9-12.4 18.4-19.6 40.5-19.6 64.3V432c0 26.5 21.5 48 48 48h288c26.5 0 48-21.5 48-48v-44.8c0-23.8-7.2-45.9-19.6-64.3-20.7-30.7-56-46.9-92.3-46.9zM480 432c0 8.8-7.2 16-16 16H176c-8.8 0-16-7.2-16-16v-44.8c0-16.6 4.9-32.7 14.1-46.4 13.8-20.5 38.4-32.8 65.7-32.8 27.4 0 37.2 12 80.2 12s52.8-12 80.1-12c27.3 0 51.9 12.3 65.7 32.8 9.2 13.7 14.1 29.8 14.1 46.4V432zM157.1 268.9c-11.9-8.1-26-12.9-41.1-12.9H76c-41.9 0-76 35.9-76 80 0 8.8 7.2 16 16 16s16-7.2 16-16c0-26.5 19.8-48 44-48h40c5.5 0 10.8 1.2 15.7 3.3 7.5-8.5 16.1-16 25.4-22.4z" />
                </svg>
                <h3 className="mt-2 text-5xl font-medium text-gray-900">
                    {treatment.playerCount > 1
                        ? `${assignedPlayerCount}/${treatment.playerCount} players connected — waiting for other players to join...`
                        : "Game loading"}
                </h3>
                <br/>
                <p className="mt-1 text-2xl text-gray-500">
                    Please be ready for the game to begin; this should take no more than a few minutes.
                </p>
            </div>
        </div>
    );
}
