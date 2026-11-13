import { open, stat } from "node:fs/promises";

export const EXPORT_LIST_KEYS = {
  batch: new Set(["createdAt", "status", "treatment", "treatmentName", "testControlsEnabled"]),
  game: new Set(["batchID", "startedAt", "endedAt", "status", "sequenceId", "treatment", "treatmentName", "testControlsEnabled"]),
  player: new Set(["gameID"]),
};

// Tajriba file format 0 is an append-only JSONL journal. Its loader also
// limits a record to 10 MiB. Bound each record, not just each scopes page:
// never materialize a complete store or retain chat/audit/form values in
// the metadata map. Only the current bounded record/tail is buffered.
const CHUNK_BYTES = 64 * 1024;
const MAX_RECORD_BYTES = 10 * 1024 * 1024;
const MAX_METADATA_BYTES = 64 * 1024;
const ANCHOR_BYTES = 128;
const STORE_KINDS = new Set(["Scope", "Step", "Attribute", "Participant", "User", "Group", "Link", "Transition", "Service", "Session"]);

export class ExportMetadataUnavailable extends Error {
  constructor() {
    super("Export listing metadata is unavailable. Try again shortly; direct game downloads remain separate.");
    this.name = "ExportMetadataUnavailable";
  }
}

/**
 * Read-only, process-local metadata index. It is disposable: the Tajriba file
 * remains authoritative, and no attributes or extra files are written to it.
 * Initial construction streams bounded records; later reads consume only the
 * journal suffix. A failed refresh is never served as a successful partial
 * list, and never falls back to an unbounded HTTP scan.
 *
 * Format reference: empiricaly/tajriba internal/store/store.go (format 0),
 * internal/runtime/load.go (latest scalar wins in journal order).
 */
export class ExportMetadataIndex {
  #scopes;
  #offset;
  #parts;
  #partBytes;
  #line;
  #identity;
  #anchor;
  #mtime;
  #queue = Promise.resolve();

  constructor({ file } = {}) {
    if (typeof file !== "string" || !file) throw new Error("ExportMetadataIndex: store file is required");
    this.file = file;
    this.#reset();
  }

  #reset() {
    this.#scopes = new Map();
    this.#offset = 0;
    this.#parts = [];
    this.#partBytes = 0;
    this.#line = 0;
    this.#identity = null;
    this.#anchor = Buffer.alloc(0);
    this.#mtime = null;
  }

  read({ signal } = {}) {
    // Cancellation is request-local; rejected refreshes cannot poison the
    // queue, and simultaneous callers cannot apply the journal suffix twice.
    const task = this.#queue.then(() => this.#refresh(signal));
    this.#queue = task.catch(() => {});
    return task;
  }

  async #refresh(signal) {
    let handle;
    try {
      signal?.throwIfAborted();
      handle = await open(this.file, "r");
      const source = await handle.stat();
      if (!source.isFile()) throw new ExportMetadataUnavailable();
      const identity = `${source.dev}:${source.ino}`;
      let rebuild = this.#identity !== identity || source.size < this.#offset ||
        (source.size === this.#offset && this.#mtime !== source.mtimeMs);
      if (!rebuild && this.#anchor.length) {
        const check = Buffer.alloc(this.#anchor.length);
        const { bytesRead } = await handle.read(check, 0, check.length, this.#offset - check.length);
        rebuild = bytesRead !== check.length || !check.equals(this.#anchor);
      }
      if (rebuild) this.#reset();
      this.#identity = identity;
      const start = this.#offset;
      // Freeze this refresh's boundary so a busy discussion cannot make a
      // listing chase an ever-growing tail. New bytes are read next refresh.
      while (this.#offset < source.size) {
        signal?.throwIfAborted();
        const chunk = Buffer.alloc(Math.min(CHUNK_BYTES, source.size - this.#offset));
        const { bytesRead } = await handle.read(chunk, 0, chunk.length, this.#offset);
        signal?.throwIfAborted();
        if (!bytesRead) throw new ExportMetadataUnavailable();
        const data = chunk.subarray(0, bytesRead);
        this.#consume(data);
        this.#anchor = Buffer.from(data.length >= ANCHOR_BYTES ? data.subarray(-ANCHOR_BYTES)
          : Buffer.concat([this.#anchor, data]).subarray(-ANCHOR_BYTES));
        this.#offset += bytesRead;
      }
      const current = await stat(this.file);
      if (`${current.dev}:${current.ino}` !== identity || current.size < source.size ||
          (current.size === source.size && current.mtimeMs !== source.mtimeMs)) {
        throw new ExportMetadataUnavailable();
      }
      signal?.throwIfAborted();
      if (this.#line < 2) throw new ExportMetadataUnavailable();
      this.#mtime = source.mtimeMs;
      return {
        scopes: [...this.#scopes.values()].map(scope => ({
          id: scope.id, kind: scope.kind, createdAt: scope.createdAt,
          attributes: [...scope.attributes.values()].map(attribute => ({ ...attribute })),
        })),
        metadata: {
          source: "read-only-store-index",
          checkedAt: new Date().toISOString(),
          sourceModifiedAt: source.mtime.toISOString(),
          completeThroughBytes: this.#offset - this.#partBytes,
          sourceSizeBytes: source.size,
          bytesRead: this.#offset - start,
          pendingTail: this.#partBytes > 0,
        },
      };
    } catch (error) {
      // Do not keep an incomplete rebuild or leak source paths, record
      // contents, credentials or participant text into HTTP errors/logs.
      this.#reset();
      if (signal?.aborted) throw signal.reason;
      throw new ExportMetadataUnavailable();
    } finally {
      await handle?.close();
    }
  }

  #consume(chunk) {
    let start = 0;
    while (start < chunk.length) {
      const newline = chunk.indexOf(10, start);
      const end = newline === -1 ? chunk.length : newline;
      const part = chunk.subarray(start, end);
      this.#partBytes += part.length;
      if (this.#partBytes > MAX_RECORD_BYTES) throw new ExportMetadataUnavailable();
      this.#parts.push(part);
      if (newline === -1) break;
      const line = Buffer.concat(this.#parts, this.#partBytes).toString("utf8").trim();
      this.#parts = [];
      this.#partBytes = 0;
      this.#line += 1;
      if (line || this.#line <= 2) this.#apply(JSON.parse(line));
      start = end + 1;
    }
  }

  #apply(event) {
    if (this.#line === 1) {
      if (!event || typeof event !== "object" || event.kind || !event.version) throw new ExportMetadataUnavailable();
      return;
    }
    if (this.#line === 2) {
      if (event?.version !== 0 || event.format !== "JSON" || event.compression !== "NoCompression") {
        throw new ExportMetadataUnavailable();
      }
      return;
    }
    if (!event || !STORE_KINDS.has(event.kind) || !event.obj || typeof event.obj.id !== "string") {
      throw new ExportMetadataUnavailable();
    }
    const obj = event.obj;
    if (event.kind === "Scope") {
      if (!Object.hasOwn(EXPORT_LIST_KEYS, obj.kind)) return;
      const existing = this.#scopes.get(obj.id);
      this.#scopes.set(obj.id, { id: obj.id, kind: obj.kind, createdAt: obj.createdAt || null,
        attributes: existing?.attributes || new Map() });
      return;
    }
    if (event.kind !== "Attribute") return;
    const scope = this.#scopes.get(obj.nodeID);
    if (!scope || !EXPORT_LIST_KEYS[scope.kind].has(obj.key) || obj.index != null || obj.vector) return;
    if (obj.deletedAt != null || obj.deleted === true) {
      scope.attributes.delete(obj.key);
      return;
    }
    if (obj.val != null && (typeof obj.val !== "string" || Buffer.byteLength(obj.val) > MAX_METADATA_BYTES)) {
      throw new ExportMetadataUnavailable();
    }
    // Versions are not serialized by Tajriba; replay order is authoritative.
    // Retain one current scalar, never its historical candidates or values.
    scope.attributes.set(obj.key, { key: obj.key, val: obj.val ?? null });
  }
}
