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

// Surface the cache topology at boot so a forgotten `docker compose up` is obvious.
cache.ping().then((status) => {
  if (config.cache.backend === 'redis') {
    const reachable = Object.values(status).filter(Boolean).length;
    const total = Object.keys(status).length;
    console.log(`[cache] backend=redis nodes=${total} reachable=${reachable} ${JSON.stringify(status)}`);
    if (reachable < total) {
      console.warn('[cache] some redis nodes are unreachable - is `docker compose up -d` running?');
    }
  } else {
    console.log(`[cache] backend=memory nodes=${cache.ring.nodes().length} (no Docker; set CACHE_BACKEND=redis for real Redis)`);
  }
}).catch(() => {});

// ---- http -------------------------------------------------------------------
const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, '..', 'public')));

// Wrap async handlers so a rejected promise becomes a 500, never an unhandled
// rejection that crashes the process (Node's default on --unhandled-rejections=throw).
const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

// Up to 10 prefix-matching suggestions, ranked by count (or recency in trending mode).
app.get('/suggest', wrap(async (req, res) => {
  const result = await service.suggest(req.query.q);
  res.json(result);
}));

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
app.get('/cache/debug', wrap(async (req, res) => {
  const prefix = normalize(req.query.prefix);
  const info = await cache.inspect(prefix);
  res.json({ prefix, node: info.nodeId, hit: info.hit, ttlRemainingMs: info.ttlRemainingMs });
}));

// Real counters for the performance report.
app.get('/stats', wrap(async (req, res) => {
  res.json({
    rankMode: config.rankMode,
    dataset: { queries: trie.size },
    cache: {
      backend: config.cache.backend,
      nodes: cache.ring.nodes().length,
      hits: cache.stats.hits,
      misses: cache.stats.misses,
      hitRate: Number(cache.hitRate().toFixed(4)),
      keysPerNode: await cache.distribution(),
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
}));

app.get('/health', (_req, res) => res.json({ ok: true }));

// Single JSON error handler. body-parser raises a SyntaxError on a malformed
// body (a 400, not our fault); anything else reaching here came from a wrapped
// async handler and is an unexpected 500. Either way: clean JSON, no stack dump,
// and crucially never an unhandled rejection.
app.use((err, _req, res, _next) => {
  if (err.type === 'entity.parse.failed' || err instanceof SyntaxError) {
    return res.status(400).json({ error: 'invalid JSON body' });
  }
  console.error('[error]', err.message);
  res.status(500).json({ error: 'internal error' });
});

const server = app.listen(config.port, () => {
  console.log(`typeahead up on http://localhost:${config.port}  (rankMode=${config.rankMode}, queries=${trie.size})`);
});

// Drain the buffer on shutdown so we don't lose the last few seconds of searches.
function shutdown() {
  console.log('\nshutting down, flushing batch buffer...');
  batch.stop();
  cache.close().catch(() => {});
  server.close(() => process.exit(0));
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

module.exports = app; // exported for tests / bench reuse
