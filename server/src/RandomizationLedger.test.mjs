import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import {
  RANDOMIZATION_LEDGER_KEY,
  buildLedgerFromGames,
  claimFromLedger,
  claimSequenceForStudy,
} from "./RandomizationLedger.mjs";

const IDS = ["S1", "S2", "S3", "S4"];
const deterministicRandom = () => 0;
const dirname = path.dirname(fileURLToPath(import.meta.url));
const callbacksSource = readFileSync(path.join(dirname, "callbacks.js"), "utf8");

test("every complete four-claim block contains S1-S4 exactly once", () => {
  let ledger = buildLedgerFromGames([], IDS);
  const claims = [];
  for (let i = 0; i < 40; i += 1) {
    const result = claimFromLedger(ledger, { gameId: `g${i}`, sequenceIds: IDS, now: i, random: deterministicRandom });
    ledger = result.ledger;
    claims.push(result.claim.sequenceId);
  }
  for (let i = 0; i < claims.length; i += 4) {
    assert.deepEqual([...claims.slice(i, i + 4)].sort(), IDS);
  }
});

test("a persisted Global ledger continues a partial block across process restarts and Batches", () => {
  const attributes = new Map();
  const globals = {
    get: (key) => attributes.get(key),
    set: (key, value) => attributes.set(key, value),
  };
  const games = [];
  const allocate = (id) => {
    const game = { id, get: () => undefined };
    games.push(game);
    return claimSequenceForStudy(globals, games, game, IDS, { random: deterministicRandom }).claim.sequenceId;
  };
  const claims = [allocate("g1"), allocate("g2"), allocate("g3"), allocate("g4")];
  assert.deepEqual([...claims].sort(), IDS);
  assert.equal(attributes.get(RANDOMIZATION_LEDGER_KEY).allocationNumber, 4);
});

test("the same Game idempotently reuses its durable claim", () => {
  const first = claimFromLedger(buildLedgerFromGames([], IDS), { gameId: "same", sequenceIds: IDS, random: deterministicRandom });
  const second = claimFromLedger(first.ledger, { gameId: "same", sequenceIds: IDS, random: () => 0.99 });
  assert.equal(second.reused, true);
  assert.deepEqual(second.claim, first.claim);
  assert.equal(second.ledger.allocationNumber, 1);
});

test("legacy Game assignments bootstrap counts and repair imbalance", () => {
  const games = ["S1", "S1", "S2"].map((sequenceId, index) => ({
    id: `old-${index}`,
    get: (key) => key === "sequenceId" ? sequenceId : undefined,
  }));
  const result = claimFromLedger(buildLedgerFromGames(games, IDS), { gameId: "new", sequenceIds: IDS, random: deterministicRandom });
  assert.ok(["S3", "S4"].includes(result.claim.sequenceId));
  assert.equal(result.ledger.allocationNumber, 4);
});

test("production allocation is persisted on Globals before onGameStart and never falls back to process memory", () => {
  const allocationIndex = callbacksSource.indexOf('Empirica.before("game", "start"');
  const gameStartIndex = callbacksSource.indexOf("Empirica.onGameStart");
  assert.ok(allocationIndex !== -1 && allocationIndex < gameStartIndex);
  assert.match(callbacksSource, /claimSequenceForStudy\(ctx\.globals, games, game, SEQUENCE_IDS\)/);
  assert.match(callbacksSource, /has no valid durable sequence allocation/);
  assert.doesNotMatch(callbacksSource, /currentSequenceBlock|nextAllocationPosition|claimNextSequence/);
});
