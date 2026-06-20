'use strict';

const { ConsistentHashRing } = require('./consistentHash');

// Distributed suggestion cache.
//
// "Distributed" here means several independent logical cache nodes, each its own
// Map, addressed through a consistent-hash ring on the prefix. In a real system
// these would be separate Redis processes on separate boxes; the routing logic
// the assignment cares about is identical, and keeping them in-process lets us
// log exactly where each key lands (REQUIREMENTS §2).
//
// Cache key   = normalized prefix.
// Cache value = the rendered top-10 suggestion list.
// Entries carry a TTL so a burst of writes can't keep stale suggestions alive.

class CacheNode {
  constructor(id) {
    this.id = id;
    this.map = new Map(); // prefix -> { value, expiresAt }
  }
}

class DistributedCache {
  constructor({ nodes = 3, vnodes = 150, ttlMs = 30_000 } = {}) {
    this.ttlMs = ttlMs;
    this.nodes = new Map();
    const ids = [];
    for (let i = 0; i < nodes; i++) {
      const id = `cache-${i}`;
      this.nodes.set(id, new CacheNode(id));
      ids.push(id);
    }
    this.ring = new ConsistentHashRing(ids, vnodes);
    this.stats = { hits: 0, misses: 0 };
  }

  nodeFor(prefix) {
    const id = this.ring.getNode(prefix);
    return this.nodes.get(id);
  }

  get(prefix, now = Date.now()) {
    const node = this.nodeFor(prefix);
    const entry = node.map.get(prefix);
    if (!entry) {
      this.stats.misses += 1;
      return { value: null, nodeId: node.id, hit: false };
    }
    if (entry.expiresAt <= now) {
      node.map.delete(prefix); // lazy expiry on read
      this.stats.misses += 1;
      return { value: null, nodeId: node.id, hit: false };
    }
    this.stats.hits += 1;
    return { value: entry.value, nodeId: node.id, hit: true };
  }

  set(prefix, value, now = Date.now()) {
    const node = this.nodeFor(prefix);
    node.map.set(prefix, { value, expiresAt: now + this.ttlMs });
    return node.id;
  }

  // Drop a prefix from whichever node owns it. Called when a write changes the
  // ranking for that prefix so the next read recomputes (REQUIREMENTS §6/§7).
  invalidate(prefix) {
    this.nodeFor(prefix).map.delete(prefix);
  }

  // Peek without counting a hit/miss - used by GET /cache/debug.
  inspect(prefix, now = Date.now()) {
    const node = this.nodeFor(prefix);
    const entry = node.map.get(prefix);
    const hit = !!entry && entry.expiresAt > now;
    return { nodeId: node.id, hit, ttlRemainingMs: hit ? entry.expiresAt - now : 0 };
  }

  hitRate() {
    const total = this.stats.hits + this.stats.misses;
    return total === 0 ? 0 : this.stats.hits / total;
  }

  // Per-node key counts - handy for showing the ring spreads load evenly.
  distribution() {
    const out = {};
    for (const [id, node] of this.nodes) out[id] = node.map.size;
    return out;
  }
}

module.exports = { DistributedCache };
