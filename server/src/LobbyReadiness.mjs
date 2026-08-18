export function countLobbyReadyPlayers(players = []) {
  return players.filter(
    (player) => player?.get?.("introDone") && !player?.get?.("ended"),
  ).length;
}
