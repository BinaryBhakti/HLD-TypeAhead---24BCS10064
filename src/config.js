'use strict';

const fs = require('fs');
const path = require('path');

// Tiny .env reader so we don't pull in a dependency just for this.
// Anything already in process.env wins, so CLI/shell overrides still work.
function loadDotEnv() {
  const file = path.join(__dirname, '..', '.env');
  if (!fs.existsSync(file)) return;
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    const val = trimmed.slice(eq + 1).trim().replace(/^["']|["']$/g, '');
    if (!(key in process.env)) process.env[key] = val;
  }
}
loadDotEnv();

const num = (v, d) => (v === undefined ? d : Number(v));

// "host:port,host:port,..." -> [{ host, port }]. Drives both how many cache
// nodes the ring has and which Redis process each one connects to.
function parseRedisNodes(s) {
  return s.split(',').map((pair) => {
    const [host, port] = pair.trim().split(':');
    return { host: host || '127.0.0.1', port: num(port, 6379) };
  });
}

const redisNodes = parseRedisNodes(
  process.env.CACHE_REDIS_NODES || '127.0.0.1:6379,127.0.0.1:6380,127.0.0.1:6381'
);

const config = {
  port: num(process.env.PORT, 3000),

  dbPath: path.resolve(__dirname, '..', process.env.DB_PATH || 'data/typeahead.db'),

  suggestLimit: num(process.env.SUGGEST_LIMIT, 10),
  rankMode: process.env.RANK_MODE || 'trending', // "popularity" | "trending"

  cache: {
    // "redis" routes to the real Redis processes in docker-compose.yml; "memory"
    // keeps everything in-process (no Docker needed) for tests and offline runs.
    // Same consistent-hash ring either way - only the per-node store changes.
    backend: process.env.CACHE_BACKEND || 'memory',
    redisNodes,
    // For the memory backend, CACHE_NODES sets the node count; for redis it's the
    // number of redisNodes entries (one logical node per Redis process).
    nodes: num(process.env.CACHE_NODES, 3),
    vnodes: num(process.env.CACHE_VNODES, 150),
    ttlMs: num(process.env.CACHE_TTL_MS, 30_000),
  },

  trending: {
    halfLifeMs: num(process.env.TRENDING_HALF_LIFE_MS, 600_000),
    weight: num(process.env.TRENDING_WEIGHT, 3),
  },

  batch: {
    flushMs: num(process.env.FLUSH_MS, 2_000),
    flushSize: num(process.env.FLUSH_SIZE, 500),
  },
};

module.exports = config;
