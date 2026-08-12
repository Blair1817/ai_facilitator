/** Restart-safe, study-global permuted-block allocation. */

export const RANDOMIZATION_LEDGER_KEY = "sequenceAllocationLedgerV1";
export const RANDOMIZATION_LEDGER_VERSION = 1;

function shuffled(values, random = Math.random) {
  const result = [...values];
  for (let i = result.length - 1; i > 0; i -= 1) {
    const j = Math.floor(random() * (i + 1));
    [result[i], result[j]] = [result[j], result[i]];
  }
  return result;
}

function emptyCounts(sequenceIds) {
  return Object.fromEntries(sequenceIds.map((sequenceId) => [sequenceId, 0]));
}

function validSequence(value, sequenceIds) {
  return typeof value === "string" && sequenceIds.includes(value);
}

export function buildLedgerFromGames(games, sequenceIds) {
  const counts = emptyCounts(sequenceIds);
  const assignments = {};
  let allocationNumber = 0;

  for (const game of games || []) {
    const sequenceId = game?.get?.("sequenceId");
    if (!game?.id || !validSequence(sequenceId, sequenceIds)) continue;
    allocationNumber += 1;
    counts[sequenceId] += 1;
    assignments[game.id] = {
      sequenceId,
      allocationNumber,
      allocationBlockId: game.get("allocationBlockId") ?? Math.floor((allocationNumber - 1) / sequenceIds.length) + 1,
      allocationPosition: game.get("allocationPosition") ?? ((allocationNumber - 1) % sequenceIds.length) + 1,
      claimedAt: game.get("allocationClaimedAt") ?? null,
      migrated: true,
    };
  }

  return {
    version: RANDOMIZATION_LEDGER_VERSION,
    sequenceIds: [...sequenceIds],
    allocationNumber,
    counts,
    assignments,
    blocks: {},
  };
}

export function normalizeLedger(rawLedger, games, sequenceIds) {
  if (
    !rawLedger ||
    rawLedger.version !== RANDOMIZATION_LEDGER_VERSION ||
    !Array.isArray(rawLedger.sequenceIds) ||
    rawLedger.sequenceIds.join("|") !== sequenceIds.join("|") ||
    typeof rawLedger.assignments !== "object" || rawLedger.assignments === null ||
    typeof rawLedger.counts !== "object" || rawLedger.counts === null
  ) {
    return buildLedgerFromGames(games, sequenceIds);
  }

  return {
    ...rawLedger,
    counts: { ...emptyCounts(sequenceIds), ...rawLedger.counts },
    assignments: { ...rawLedger.assignments },
    blocks: { ...(rawLedger.blocks || {}) },
  };
}

export function claimFromLedger(rawLedger, { gameId, sequenceIds, now = Date.now(), random = Math.random }) {
  const ledger = normalizeLedger(rawLedger, [], sequenceIds);
  const existing = ledger.assignments[gameId];
  if (existing && validSequence(existing.sequenceId, sequenceIds)) {
    return { ledger, claim: existing, reused: true };
  }

  const minimum = Math.min(...sequenceIds.map((sequenceId) => ledger.counts[sequenceId] ?? 0));
  const eligible = sequenceIds.filter((sequenceId) => (ledger.counts[sequenceId] ?? 0) === minimum);
  const sequenceId = shuffled(eligible, random)[0];
  const allocationNumber = (ledger.allocationNumber || 0) + 1;
  const allocationBlockId = Math.floor((allocationNumber - 1) / sequenceIds.length) + 1;
  const allocationPosition = ((allocationNumber - 1) % sequenceIds.length) + 1;
  const claim = { sequenceId, allocationNumber, allocationBlockId, allocationPosition, claimedAt: now };
  const blockKey = String(allocationBlockId);

  const nextLedger = {
    ...ledger,
    allocationNumber,
    counts: { ...ledger.counts, [sequenceId]: (ledger.counts[sequenceId] ?? 0) + 1 },
    assignments: { ...ledger.assignments, [gameId]: claim },
    blocks: { ...ledger.blocks, [blockKey]: [...(ledger.blocks[blockKey] || []), sequenceId] },
  };

  return { ledger: nextLedger, claim, reused: false };
}

export function claimSequenceForStudy(globals, games, game, sequenceIds, options = {}) {
  if (!globals) throw new Error("Cannot allocate a sequence without Empirica Globals");
  const ledger = normalizeLedger(globals.get(RANDOMIZATION_LEDGER_KEY), games, sequenceIds);
  const result = claimFromLedger(ledger, { gameId: game.id, sequenceIds, ...options });
  globals.set(RANDOMIZATION_LEDGER_KEY, result.ledger);
  return result;
}
