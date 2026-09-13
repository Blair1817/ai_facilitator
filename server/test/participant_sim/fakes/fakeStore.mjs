// Generic in-memory stand-in for an Empirica "scope" (Game / Round / Stage /
// Player). Every module under server/src touches these scopes ONLY through
// .get(key) / .set(key, value) / .append(key, value) (confirmed by reading
// AppendOnlyAttribute.mjs, InFlightAudit.mjs, CheckpointManager.mjs,
// ExperimentPolicies.mjs and callbacks.js directly this session) so a plain
// Map-backed object satisfies every real module's expectations without
// reimplementing any decision logic ourselves.
let idCounter = 0;
function nextId(prefix) { return `${prefix}-${(++idCounter).toString(36)}-${Date.now().toString(36)}`; }

export class FakeScope {
  constructor(kind, fields = {}) {
    this.kind = kind;
    this.id = fields.id || nextId(kind);
    this._attrs = new Map(Object.entries(fields));
    this._attrs.delete("id");
  }
  get(key) { return this._attrs.has(key) ? this._attrs.get(key) : undefined; }
  set(key, value) { this._attrs.set(key, value); return this; }
  append(key, value) {
    const arr = Array.isArray(this._attrs.get(key)) ? this._attrs.get(key).slice() : [];
    arr.push(value);
    this._attrs.set(key, arr);
    return this;
  }
}

export class FakePlayer extends FakeScope {
  constructor(fields) { super("player", fields); }
}

export class FakeStage extends FakeScope {
  constructor(fields, round) {
    super("stage", fields);
    this.round = round;
  }
  isCurrent() { return this._current !== false; }
}

export class FakeRound extends FakeScope {
  constructor(fields, game) {
    super("round", fields);
    this.currentGame = game;
  }
}

export class FakeGame extends FakeScope {
  constructor(fields, players) {
    super("game", fields);
    this.players = players || [];
    this._currentRound = null;
    this._currentStage = null;
  }
  get currentRound() { return this._currentRound; }
  set currentRound(r) { this._currentRound = r; }
  get currentStage() { return this._currentStage; }
  set currentStage(s) { this._currentStage = s; }
}

export function makeFakePlayer({ id, name, hexCode }) {
  return new FakePlayer({ id, name, hexCode });
}
