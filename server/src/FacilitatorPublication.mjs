// Short critical sections only: no Generator or Validator call may run here.
// Serialises publication within the sole callbacks process. Tajriba scalar
// attributes are not a cross-process compare-and-set; see deployment notes.
export function createFacilitatorPublicationCoordinator() {
  const tails = new Map(), requests = new Map();
  function requestedStarted(game, entry) {
    const pending = requests.get(game.id) || new Map();
    pending.set(entry.auditRequestId, { roundId: entry.roundId, stageId: entry.stageId });
    requests.set(game.id, pending);
  }
  function requestedFinished(game, entry) {
    const pending = requests.get(game.id);
    pending?.delete(entry.auditRequestId);
    if (!pending?.size) requests.delete(game.id);
  }
  function hasRequested(game) {
    const matches = entry => entry.roundId === game.currentRound?.id && entry.stageId === game.currentStage?.id;
    return [...(requests.get(game.id)?.values() || [])].some(matches)
      || Object.values(game.get("llmInFlight") || {}).some(entry => entry.participantRequested && matches(entry));
  }
  async function commit(game, task) {
    const previous = tails.get(game.id) || Promise.resolve();
    const result = previous.then(task);
    const settled = result.then(() => undefined, () => undefined);
    tails.set(game.id, settled);
    try { return await result; }
    finally { if (tails.get(game.id) === settled) tails.delete(game.id); }
  }
  return { commit, requestedStarted, requestedFinished, hasRequested };
}
