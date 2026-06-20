'use strict';

// Batch writer (the other +20%).
//
// POST /search does NOT touch SQLite. It drops the query into this in-memory
// buffer and returns immediately. The buffer aggregates duplicates, so 50 searches
// for "iphone" between flushes become a single `count += 50` row update, not 50
// writes. We flush on a timer OR once enough distinct queries pile up.
//
// Failure trade-off (REQUIREMENTS §7): the buffer is in memory, so a crash loses
// at most one flush-interval of searches. That's acceptable for popularity counts.
// Hardening it would mean writing to a durable log before acking — which reintroduces
// the per-request synchronous write we're trying to avoid — so it's left out by design.

class BatchWriter {
  constructor({ db, trie, trending, cache, flushMs = 2000, flushSize = 500, clock = Date.now } = {}) {
    this.db = db;
    this.trie = trie;
    this.trending = trending;
    this.cache = cache;
    this.flushMs = flushMs;
    this.flushSize = flushSize;
    this.clock = clock;

    this.buffer = new Map(); // query -> pending delta
    this.timer = null;

    this.stats = {
      enqueued: 0,   // raw search submissions seen
      rowsWritten: 0, // distinct rows actually UPSERTed
      flushes: 0,
    };
  }

  enqueue(query) {
    this.stats.enqueued += 1;
    this.buffer.set(query, (this.buffer.get(query) || 0) + 1);
    if (this.buffer.size >= this.flushSize) this.flush();
  }

  flush() {
    if (this.buffer.size === 0) return 0;

    const now = this.clock();
    const pending = this.buffer;
    this.buffer = new Map(); // swap out so new searches buffer while we write

    const rows = [];
    for (const [query, delta] of pending) {
      rows.push({ query, count: delta, lastSeen: now });
    }

    // 1) Persist — one transaction for the whole batch.
    this.db.flushBatch(rows);

    // 2) Update the in-memory read structures so suggestions reflect the writes.
    for (const { query, count: delta } of rows) {
      const entry = this.trie.entries.get(query);
      const newCount = (entry ? entry.count : 0) + delta;
      this.trie.upsert(query, newCount);
      this.trending.record(query, delta, now);
      this._invalidatePrefixes(query);
    }

    // 3) Let decayed-to-nothing trending entries go.
    this.trending.prune(now);

    this.stats.rowsWritten += rows.length;
    this.stats.flushes += 1;
    return rows.length;
  }

  // A query can only appear in suggestions for its own prefixes, so those are the
  // only cache keys whose ranking just changed. Cap the length we bother with —
  // nobody caches a 60-char prefix.
  _invalidatePrefixes(query) {
    const max = Math.min(query.length, 20);
    for (let i = 1; i <= max; i++) this.cache.invalidate(query.slice(0, i));
  }

  // Ratio of raw searches to actual DB writes — the headline write-reduction number.
  writeReduction() {
    return this.stats.rowsWritten === 0 ? 0 : this.stats.enqueued / this.stats.rowsWritten;
  }

  start() {
    if (this.timer) return;
    this.timer = setInterval(() => this.flush(), this.flushMs);
    if (this.timer.unref) this.timer.unref(); // don't keep the process alive just for this
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.flush(); // best-effort drain on shutdown
  }
}

module.exports = { BatchWriter };
