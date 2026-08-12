import React, { FormEvent, useState } from "react";

export interface PlayerCreateProps {
  onPlayerID: (playerID: string) => void;
  connecting: boolean;
}

export function PlayerCreate({ onPlayerID, connecting }: PlayerCreateProps) {
  const [playerID, setPlayerID] = useState("");

  const handleSubmit = (evt: FormEvent) => {
    evt.preventDefault();
    if (!playerID || playerID.trim() === "") {
      return;
    }

    onPlayerID(playerID);
  };

  return (
    <div className="min-h-screen bg-empirica-50 flex items-center justify-center py-12 sm:px-6 lg:px-8">
      <div className="sm:mx-auto sm:w-full sm:max-w-md">
        <h2 className="mt-6 text-center text-3xl font-extrabold text-gray-900">
          Please enter your identifier:
        </h2>
        <div className="mt-8 bg-white py-8 shadow flex-col">
          <form
            className="space-y-6 w-full justify-center"
            action="#"
            method="POST"
            onSubmit={handleSubmit}
          >
            <fieldset disabled={connecting}>
              <div className="py-5 flex-col items-center">
                <label
                  htmlFor="playerID"
                  className="block text-sm font-medium text-gray-700 text-center"
                >
                  Identifier
                </label>
                <div className="mt-1 w-full">
                  <input
                    id="playerID"
                    name="playerID"
                    type="text"
                    autoComplete="off"
                    required
                    autoFocus
                    className="appearance-none block w-full px-3 py-2 border border-gray-300 rounded-md shadow-sm placeholder-gray-400 focus:outline-none focus:ring-empirica-500 focus:border-empirica-500 sm:text-sm"
                    value={playerID}
                    onChange={(e) => setPlayerID(e.target.value)}
                  />
                </div>
              </div>

              <div className="flex justify-center">
                <button
                  type="submit"
                  className="w-full flex justify-center py-2 px-4 border border-transparent rounded-md shadow-sm text-sm font-medium text-white bg-empirica-600 hover:bg-empirica-700 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-empirica-500"
                >
                  Enter
                </button>
              </div>
            </fieldset>
          </form>
        </div>
      </div>
    </div>
  );
}
