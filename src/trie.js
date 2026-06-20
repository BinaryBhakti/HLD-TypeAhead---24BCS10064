'use strict';

// Prefix trie where every node caches the top-K completions in its subtree.
// A lookup is "walk the prefix characters, hand back the precomputed list", so
// it costs O(prefix length) and does not depend on how big the dataset is.
//
// Key invariant: in this system a query's all-time count only ever goes UP
// (searches add, nothing subtracts). That monotonicity is what lets us keep the
// per-node top-K correct with cheap incremental updates instead of recomputing
// a subtree on every search. See REQUIREMENTS §4.
//
// K here is a *candidate pool*, deliberately bigger than the 10 we display, so
// the trending re-ranker has room to pull a recently-hot query above an all-time
// favourite. The service slices it down to 10 after re-ranking.

const DEFAULT_K = 50;

function newNode() {
  return { children: Object.create(null), top: [] };
}

// Sort entries by count desc, then query asc so ordering is deterministic
// (matters for tests and for reproducible screenshots).
function byRank(a, b) {
  if (b.count !== a.count) return b.count - a.count;
  return a.query < b.query ? -1 : a.query > b.query ? 1 : 0;
}

class Trie {
  constructor(k = DEFAULT_K) {
    this.k = k;
    this.root = newNode();
    this.entries = new Map(); // query -> shared { query, count } object
  }

  get size() {
    return this.entries.size;
  }

  // Insert a new query or raise an existing one's count to `count`.
  // `count` is the absolute all-time value (not a delta); callers pass the new total.
  upsert(query, count) {
    let entry = this.entries.get(query);
    if (!entry) {
      entry = { query, count };
      this.entries.set(query, entry);
    } else {
      if (count <= entry.count) count = entry.count; // never let a count go backwards
      entry.count = count;
    }

    // Walk root -> terminal, refreshing each node's top-K with this entry.
    let node = this.root;
    this._consider(node, entry);
    for (const ch of query) {
      let next = node.children[ch];
      if (!next) next = node.children[ch] = newNode();
      node = next;
      this._consider(node, entry);
    }
  }

  // Make sure `entry` is correctly placed in this node's top-K.
  _consider(node, entry) {
    const top = node.top;
    const idx = top.indexOf(entry);
    if (idx !== -1) {
      // Already tracked here; its count may have risen, so just re-sort.
      top.sort(byRank);
      return;
    }
    if (top.length < this.k) {
      top.push(entry);
      top.sort(byRank);
    } else if (entry.count > top[top.length - 1].count) {
      top[top.length - 1] = entry; // evict the weakest, keep the pool at K
      top.sort(byRank);
    }
  }

  // Walk to the prefix node and return its cached candidates (already ranked by
  // all-time count). Returns [] for a prefix with no matches.
  candidates(prefix) {
    let node = this.root;
    for (const ch of prefix) {
      node = node.children[ch];
      if (!node) return [];
    }
    return node.top;
  }

  // Convenience for the popularity baseline: top-N by all-time count.
  topK(prefix, limit) {
    return this.candidates(prefix).slice(0, limit);
  }
}

module.exports = { Trie, DEFAULT_K };
