'use strict';

const path = require('path');
const express = require('express');

const config = require('./config');
const db = require('./db');
const { Trie } = require('./trie');
const { DistributedCache } = require('./cache');
const { Trending } = require('./trending');
const { BatchWriter } = require('./batchWriter');
const { SuggestService } = require('./suggestService');
const { normalize } = require('./util');

// ---- wire up the components -------------------------------------------------
const trie = new Trie();
const cache = new DistributedCache(config.cache);
const trending = new Trending(config.trending);
const batch = new BatchWriter({
  db,
  trie,
  trending,
  cache,
  flushMs: config.batch.flushMs,
  flushSize: config.batch.flushSize,
});
const service = new SuggestService({ trie, cache, trending, db, config });

const loaded = service.load();
if (loaded === 0) {
  console.warn('[startup] queries table is empty - run `npm run load` (or `npm run load:sample`) first.');
}
batch.start();

// ---- http -------------------------------------------------------------------
const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, '..', 'public')));

// Up to 10 prefix-matching suggestions, ranked by count (or recency in trending mode).
app.get('/suggest', (req, res) => {
  const result = service.suggest(req.query.q);
  res.json(result);
});

// Dummy search. Records the query for a later batched write; never blocks on the DB.
app.post('/search', (req, res) => {
  const query = normalize(req.body && req.body.query);
  if (!query) return res.status(400).json({ error: 'query is required' });
  batch.enqueue(query);
  res.json({ message: 'Searched' });
});

app.get('/trending', (req, res) => {
  const limit = Number(req.query.limit) || config.suggestLimit;
  res.json({ trending: service.trendingList(limit), rankMode: config.rankMode });
});

// Shows which cache node owns a prefix and whether it's currently a hit.
app.get('/cache/debug', (req, res) => {
  const prefix = normalize(req.query.prefix);
  const info = cache.inspect(prefix);
  res.json({ prefix, node: info.nodeId, hit: info.hit, ttlRemainingMs: info.ttlRemainingMs });
});

// Real counters for the performance report.
app.get('/stats', (req, res) => {
  res.json({
    rankMode: config.rankMode,
    dataset: { queries: trie.size },
    cache: {
      nodes: cache.ring.nodes().length,
      hits: cache.stats.hits,
      misses: cache.stats.misses,
      hitRate: Number(cache.hitRate().toFixed(4)),
      keysPerNode: cache.distribution(),
    },
    db: { reads: db.counters.reads, writes: db.counters.writes },
    batch: {
      enqueued: batch.stats.enqueued,
      rowsWritten: batch.stats.rowsWritten,
      flushes: batch.stats.flushes,
      bufferDepth: batch.buffer.size,
      writeReduction: Number(batch.writeReduction().toFixed(2)),
    },
  });
});

app.get('/health', (_req, res) => res.json({ ok: true }));

const server = app.listen(config.port, () => {
  console.log(`typeahead up on http://localhost:${config.port}  (rankMode=${config.rankMode}, queries=${trie.size})`);
});

// Drain the buffer on shutdown so we don't lose the last few seconds of searches.
function shutdown() {
  console.log('\nshutting down, flushing batch buffer...');
  batch.stop();
  server.close(() => process.exit(0));
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

module.exports = app; // exported for tests / bench reuse
