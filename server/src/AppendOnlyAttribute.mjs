/**
 * AppendOnlyAttribute.mjs
 *
 * Storage pattern that prevents the Tajriba JSONL from bloating into a
 * single unreadable line.
 *
 * Background: the previous implementation stored an append-only log
 * (e.g. `llmLog`) as a single Tajriba Attribute whose value was the
 * entire growing array. Each new entry rewrote the whole array, so
 * `tajriba.json` contained O(N) Attribute records of average size O(N),
 * and the largest line eventually exceeded Tajriba's Go `bufio.Scanner`
 * token limit on reload. The Empirica server then failed to start with
 * `bufio.Scanner: token too long`, losing access to the entire local
 * event log.
 *
 * This module replaces that pattern with two cooperating Attributes:
 *
 *   - One Attribute per entry, keyed `<namespace>.<id>` (e.g.
 *     `llmLog.01HXY...`). The value is a single entry object. The line
 *     length in `tajriba.json` is therefore bounded by the size of one
 *     entry, not by the cumulative log size.
 *
 *   - One small index Attribute, keyed `<namespace>Index` (e.g.
 *     `llmLogIndex`), whose value is a JSON array of `<id>` strings in
 *     append order. The index grows linearly (one short string per
 *     entry) and stays small even with thousands of entries.
 *
 * Reads reconstruct the full ordered list by walking the index. If an
 * index entry is missing (e.g. data predates this module, or the entry
 * was written under a previous key shape), readers tolerate the gap
 * and skip it.
 *
 * The helper is intentionally generic. Both `llmLog` (per-LLM-call audit)
 * and `operationalEvents` (rare, mostly per-game-start) use it.
 *
 * Migration / coexistence: a Tajriba store that still carries an old
 * monolithic `<namespace>` Attribute is read as an empty list. This
 * module does not rewrite or delete the old attribute; researchers who
 * need the pre-fix data should read the raw JSONL. The new attributes
 * are written alongside, so a fresh pilot starts on the bounded path
 * immediately.
 */

function indexKey(namespace) {
  return `${namespace}Index`;
}

function entryKey(namespace, id) {
  return `${namespace}.${id}`;
}

/**
 * Append `entry` to a Tajriba Attribute namespace.
 *
 * @param {Object} store    Empirica store (game/round/player) with .get/.set
 * @param {string} namespace logical name, e.g. "llmLog"
 * @param {Object} entry     the entry to append (must include `id`)
 * @returns {string} the id used to store the entry
 * @throws  if `entry.id` is missing
 */
export function appendToAttribute(store, namespace, entry) {
  if (!entry || typeof entry !== "object") {
    throw new Error(`appendToAttribute(${namespace}): entry must be an object`);
  }
  const id = entry.id;
  if (typeof id !== "string" || id.length === 0) {
    throw new Error(`appendToAttribute(${namespace}): entry.id must be a non-empty string`);
  }

  // Per-entry Attribute. Bounded by one entry's size, not cumulative.
  store.set(entryKey(namespace, id), entry);

  // Index. Linear in id-string size, not in entry size.
  const ik = indexKey(namespace);
  const previous = Array.isArray(store.get(ik)) ? store.get(ik) : [];
  store.set(ik, [...previous, id]);

  return id;
}

/**
 * Read the ordered list of entries previously appended to `namespace`.
 *
 * Missing index, missing entries, and non-array index are all treated
 * as "empty log" rather than as errors. This keeps callers robust
 * against partial data (e.g. legacy stores that pre-date this module,
 * or stores where a single entry write failed).
 *
 * @param {Object} store    Empirica store (game/round/player) with .get
 * @param {string} namespace logical name, e.g. "llmLog"
 * @returns {Array<Object>} entries in append order
 */
export function readAppendOnlyAttribute(store, namespace) {
  const ik = indexKey(namespace);
  const index = store.get(ik);
  if (!Array.isArray(index) || index.length === 0) {
    return [];
  }
  const out = [];
  for (const id of index) {
    if (typeof id !== "string") continue;
    const entry = store.get(entryKey(namespace, id));
    if (entry && typeof entry === "object") {
      out.push(entry);
    }
  }
  return out;
}

/**
 * Initialise the index for `namespace` to the empty array if it does
 * not already exist. Safe to call multiple times; safe to call on a
 * store that already has entries (e.g. mid-restart).
 *
 * @param {Object} store
 * @param {string} namespace
 */
export function ensureAppendOnlyAttribute(store, namespace) {
  const ik = indexKey(namespace);
  if (!Array.isArray(store.get(ik))) {
    store.set(ik, []);
  }
}

export const _internal = { indexKey, entryKey };
