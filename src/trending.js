'use strict';

// Recency-aware ranking (the +20%).
//
// Baseline ranking is just all-time count. Here we add a *decayed* recent-activity
// term so queries that are hot right now float up, and - crucially - fall back down
// on their own once the searches stop, because the recent term decays to zero.
//
//   score = log(1 + allTimeCount) + WEIGHT * recentWeight(now)
//
// - log() dampens all-time count so a query with 10M historical hits doesn't
//   permanently bury everything; the recent term can actually move the ranking.
// - recentWeight is an exponentially-decaying accumulator. Each search adds to it;
//   between searches it decays with a half-life H. A 1-minute-old search counts far
//   more than a 1-hour-old one, and a burst that ends simply melts away - that's how
//   we avoid permanently over-ranking a short-lived spike (REQUIREMENTS §6).

class Trending {
  constructor({ halfLifeMs = 600_000, weight = 3 } = {}) {
    this.halfLifeMs = halfLifeMs;
    this.weight = weight;
    // query -> { weight, t } where weight is the decayed activity as of time t.
    this.recent = new Map();
  }

  _decayFactor(dtMs) {
    // 0.5 ^ (dt / halfLife)
    return Math.pow(0.5, dtMs / this.halfLifeMs);
  }

  // Fold `delta` searches that happened at `now` into the accumulator.
  record(query, delta, now) {
    const cur = this.recent.get(query);
    if (!cur) {
      this.recent.set(query, { weight: delta, t: now });
      return;
    }
    cur.weight = cur.weight * this._decayFactor(now - cur.t) + delta;
    cur.t = now;
  }

  recentWeight(query, now) {
    const cur = this.recent.get(query);
    if (!cur) return 0;
    return cur.weight * this._decayFactor(now - cur.t);
  }

  score(query, allTimeCount, now) {
    return Math.log(1 + allTimeCount) + this.weight * this.recentWeight(query, now);
  }

  // Re-rank a candidate pool (entries with {query, count}) by recency-aware score.
  rerank(candidates, limit, now) {
    return candidates
      .map((e) => ({ query: e.query, count: e.count, score: this.score(e.query, e.count, now) }))
      .sort((a, b) => (b.score !== a.score ? b.score - a.score : a.query < b.query ? -1 : 1))
      .slice(0, limit);
  }

  // Global "trending now" list, recency-dominant. `countOf` fetches all-time count
  // for display/tiebreak. Decayed weight, not raw count, drives the order.
  top(limit, countOf, now) {
    const rows = [];
    for (const [query, cur] of this.recent) {
      const w = cur.weight * this._decayFactor(now - cur.t);
      rows.push({ query, recentWeight: w, count: countOf(query) });
    }
    rows.sort((a, b) => b.recentWeight - a.recentWeight);
    return rows.slice(0, limit);
  }

  // Drop entries that have decayed to nothing so the map doesn't grow forever.
  // Called on each batch flush.
  prune(now, epsilon = 1e-3) {
    for (const [query, cur] of this.recent) {
      if (cur.weight * this._decayFactor(now - cur.t) < epsilon) this.recent.delete(query);
    }
  }
}

module.exports = { Trending };
