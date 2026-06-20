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

const config = {
  port: num(process.env.PORT, 3000),

  dbPath: path.resolve(__dirname, '..', process.env.DB_PATH || 'data/typeahead.db'),

  suggestLimit: num(process.env.SUGGEST_LIMIT, 10),
  rankMode: process.env.RANK_MODE || 'trending', // "popularity" | "trending"

  cache: {
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
