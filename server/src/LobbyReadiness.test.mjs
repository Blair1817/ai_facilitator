import assert from "node:assert/strict";
import test from "node:test";

import { countLobbyReadyPlayers } from "./LobbyReadiness.mjs";

function player(attributes) {
  return { get: (key) => attributes[key] };
}

test("counts only participants who completed intro and have not ended", () => {
  assert.equal(
    countLobbyReadyPlayers([
      player({ introDone: true }),
      player({ introDone: true, ended: "game terminated" }),
      player({ introDone: false }),
      player({}),
    ]),
    1,
  );
});

test("tolerates a missing roster", () => {
  assert.equal(countLobbyReadyPlayers(), 0);
});
