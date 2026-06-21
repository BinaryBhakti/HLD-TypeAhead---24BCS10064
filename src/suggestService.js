'use strict';

const { normalize } = require('./util');

// Orchestrates the read path: cache -> trie -> (optional) recency re-rank.
// Keeps the server thin and keeps all the "how a suggestion is produced" logic here.

class SuggestService {
  constructor({ trie, cache, trending, db, config, clock = Date.now }) {
    this.trie = trie;
    this.cache = cache;
    this.trending = trending;
    this.db = db;
    this.config = config;
    this.clock = clock;
  }

  // Build the in-memory trie from the primary store. Source of truth is SQLite;
  // the trie is just a fast view we can always rebuild.
  load() {
    const rows = this.db.loadAll();
    for (const r of rows) this.trie.upsert(r.query, r.count);
    return this.trie.size;
  }

  countOf(query) {
    const e = this.trie.entries.get(query);
    return e ? e.count : 0;
  }

  // GET /suggest. Returns the list plus enough metadata for the cache-debug story.
  // Async because the cache may be a real Redis node (network round-trip).
  async suggest(rawPrefix) {
    const prefix = normalize(rawPrefix);
    const limit = this.config.suggestLimit;

    // Empty / missing input -> show trending rather than erroring (REQUIREMENTS §4.1).
    if (prefix === '') {
      return { prefix, suggestions: this.trendingList(limit), cached: false, source: 'trending' };
    }

    const now = this.clock();
    const cached = await this.cache.get(prefix, now);
    if (cached.hit) {
      return { prefix, suggestions: cached.value, cached: true, nodeId: cached.nodeId, source: 'cache' };
    }

    const candidates = this.trie.candidates(prefix);
    let suggestions;
    if (this.config.rankMode === 'trending') {
      suggestions = this.trending.rerank(candidates, limit, now);
    } else {
      suggestions = candidates.slice(0, limit).map((e) => ({ query: e.query, count: e.count }));
    }

    const nodeId = await this.cache.set(prefix, suggestions, now);
    return { prefix, suggestions, cached: false, nodeId, source: 'trie' };
  }

  // GET /trending. Recency-dominant. Falls back to all-time top when nothing has
  // been searched yet (cold start) so the UI panel is never empty.
  trendingList(limit) {
    const now = this.clock();
    const hot = this.trending.top(limit, (q) => this.countOf(q), now);
    if (hot.length >= limit) return hot;

    const seen = new Set(hot.map((h) => h.query));
    for (const e of this.trie.candidates('')) {
      if (hot.length >= limit) break;
      if (seen.has(e.query)) continue;
      hot.push({ query: e.query, count: e.count, recentWeight: 0 });
    }
    return hot.slice(0, limit);
  }
}

module.exports = { SuggestService };
