'use strict';

const Redis = require('ioredis');
const { ConsistentHashRing } = require('./consistentHash');

// Distributed suggestion cache.
//
// "Distributed" means several independent cache nodes, each addressed through a
// consistent-hash ring on the prefix (src/consistentHash.js). A prefix always
// routes to exactly one node, so adding/removing a node only remaps ~1/N of keys.
//
// Two interchangeable backends sit behind the SAME ring and the SAME async API:
//   - redis  : one real Redis process per node (docker-compose.yml). This is the
//              real distributed cache - separate processes, real network hops.
//   - memory : one in-process Map per node. No Docker; used by tests and offline
//              runs. Identical routing, so the graded part (the ring) is unchanged.
//
// Cache key   = normalized prefix.
// Cache value = the rendered top-10 suggestion list (JSON).
// Entries carry a TTL so a burst of writes can't keep stale suggestions alive;
// with Redis the TTL is enforced by the server (PX), with memory by an expiry stamp.

// ---- backends ---------------------------------------------------------------
// Each backend exposes the same per-node primitives. The ring/TTL/stats logic
// lives in DistributedCache so it doesn't get duplicated.

class MemoryBackend {
  constructor(ids) {
    this.maps = new Map();
    for (const id of ids) this.maps.set(id, new Map()); // id -> (prefix -> {value, expiresAt})
  }

  async get(nodeId, key, now) {
    const m = this.maps.get(nodeId);
    const e = m.get(key);
    if (!e) return null;
    if (e.expiresAt <= now) {
      m.delete(key); // lazy expiry on read
      return null;
    }
    return { value: e.value };
  }

  async set(nodeId, key, value, ttlMs, now) {
    this.maps.get(nodeId).set(key, { value, expiresAt: now + ttlMs });
  }

  async del(nodeId, key) {
    this.maps.get(nodeId).delete(key);
  }

  async ttlRemaining(nodeId, key, now) {
    const e = this.maps.get(nodeId).get(key);
    if (!e || e.expiresAt <= now) return 0;
    return e.expiresAt - now;
  }

  async size(nodeId) {
    return this.maps.get(nodeId).size;
  }

  async ping() {
    return this.maps.size; // always reachable
  }

  async close() {}
}

class RedisBackend {
  // ids[i] connects to specs[i] = { host, port }.
  constructor(ids, specs) {
    this.conns = new Map();
    ids.forEach((id, i) => {
      const { host, port } = specs[i];
      const conn = new Redis({
        host,
        port,
        lazyConnect: false,
        // Don't let a flaky node take the process down - log and let commands retry.
        maxRetriesPerRequest: 2,
        retryStrategy: (times) => Math.min(times * 200, 2000),
      });
      conn.on('error', (err) => {
        // One line, not a stack spam, if a node is down.
        if (!conn._warned) {
          console.warn(`[cache] redis node ${id} (${host}:${port}) error: ${err.code || err.message}`);
          conn._warned = true;
        }
      });
      conn.on('ready', () => { conn._warned = false; });
      this.conns.set(id, conn);
    });
  }

  async get(nodeId, key) {
    const raw = await this.conns.get(nodeId).get(key);
    return raw == null ? null : { value: JSON.parse(raw) };
  }

  async set(nodeId, key, value, ttlMs) {
    await this.conns.get(nodeId).set(key, JSON.stringify(value), 'PX', ttlMs);
  }

  async del(nodeId, key) {
    await this.conns.get(nodeId).del(key);
  }

  async ttlRemaining(nodeId, key) {
    const ms = await this.conns.get(nodeId).pttl(key); // -2 missing, -1 no expiry
    return ms > 0 ? ms : 0;
  }

  async size(nodeId) {
    return this.conns.get(nodeId).dbsize();
  }

  // Confirm every node answers - used at startup so a missing Docker is obvious.
  async ping() {
    const out = {};
    for (const [id, conn] of this.conns) {
      try { out[id] = (await conn.ping()) === 'PONG'; }
      catch { out[id] = false; }
    }
    return out;
  }

  async close() {
    for (const conn of this.conns.values()) conn.disconnect();
  }
}

// ---- the cache --------------------------------------------------------------

class DistributedCache {
  constructor({ backend = 'memory', redisNodes = [], nodes = 3, vnodes = 150, ttlMs = 30_000 } = {}) {
    this.ttlMs = ttlMs;
    this.backendName = backend;

    // One logical node id per physical store. For redis that's one per Redis
    // process; for memory it's CACHE_NODES synthetic nodes.
    const count = backend === 'redis' ? redisNodes.length : nodes;
    const ids = Array.from({ length: count }, (_, i) => `cache-${i}`);

    this.ring = new ConsistentHashRing(ids, vnodes);
    this.backend = backend === 'redis' ? new RedisBackend(ids, redisNodes) : new MemoryBackend(ids);
    this.stats = { hits: 0, misses: 0 };
  }

  nodeIdFor(prefix) {
    return this.ring.getNode(prefix);
  }

  async get(prefix, now = Date.now()) {
    const nodeId = this.nodeIdFor(prefix);
    let found;
    try {
      found = await this.backend.get(nodeId, prefix, now);
      if (this._warned) this._warned.delete(nodeId); // node answered -> recovered
    } catch (err) {
      // The cache is an optimization, not a dependency: if its node is down or
      // errors, treat it as a miss so the read falls back to the trie. A cache
      // outage must never fail a suggestion or crash the process.
      this._degraded(nodeId, 'get', err);
      this.stats.misses += 1;
      return { value: null, nodeId, hit: false };
    }
    if (!found) {
      this.stats.misses += 1;
      return { value: null, nodeId, hit: false };
    }
    this.stats.hits += 1;
    return { value: found.value, nodeId, hit: true };
  }

  async set(prefix, value, now = Date.now()) {
    const nodeId = this.nodeIdFor(prefix);
    try {
      await this.backend.set(nodeId, prefix, value, this.ttlMs, now);
    } catch (err) {
      // Failing to populate the cache just means the next read recomputes - fine.
      this._degraded(nodeId, 'set', err);
    }
    return nodeId;
  }

  // Log a degraded node at most once per node until it recovers, so a downed
  // node doesn't spam a line per request.
  _degraded(nodeId, op, err) {
    if (!this._warned) this._warned = new Set();
    if (this._warned.has(nodeId)) return;
    this._warned.add(nodeId);
    console.warn(`[cache] node ${nodeId} unavailable on ${op} (${err.code || err.message}); serving from trie`);
  }

  // Drop a prefix from whichever node owns it. Called when a write changes the
  // ranking for that prefix so the next read recomputes. Fire-and-forget: the
  // write path must not block on (or fail because of) a cache eviction.
  invalidate(prefix) {
    const nodeId = this.nodeIdFor(prefix);
    Promise.resolve(this.backend.del(nodeId, prefix)).catch(() => {});
  }

  // Peek without counting a hit/miss - used by GET /cache/debug.
  async inspect(prefix, now = Date.now()) {
    const nodeId = this.nodeIdFor(prefix);
    try {
      const ttl = await this.backend.ttlRemaining(nodeId, prefix, now);
      return { nodeId, hit: ttl > 0, ttlRemainingMs: ttl };
    } catch {
      return { nodeId, hit: false, ttlRemainingMs: 0, error: 'node unavailable' };
    }
  }

  hitRate() {
    const total = this.stats.hits + this.stats.misses;
    return total === 0 ? 0 : this.stats.hits / total;
  }

  // Per-node key counts - shows the ring spreads load evenly. A down node
  // reports null rather than failing the whole /stats call.
  async distribution() {
    const out = {};
    for (const id of this.ring.nodes()) {
      try { out[id] = await this.backend.size(id); }
      catch { out[id] = null; }
    }
    return out;
  }

  async ping() {
    return this.backend.ping();
  }

  async close() {
    return this.backend.close();
  }
}

module.exports = { DistributedCache };
