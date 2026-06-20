'use strict';

const fs = require('fs');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');
const config = require('./config');

// Primary store. One aggregated row per query - see REQUIREMENTS §3 for why we
// don't keep a per-event log. Everything else (trie, cache) is derived from this
// and can be rebuilt by re-reading the table.
//
// We use Node's built-in node:sqlite (synchronous), so there's no native module
// to compile - `npm install` just pulls express and the app runs anywhere Node 22+
// is installed.

fs.mkdirSync(path.dirname(config.dbPath), { recursive: true });

const db = new DatabaseSync(config.dbPath);
db.exec('PRAGMA journal_mode = WAL;');   // concurrent reads while a batch flush writes
db.exec('PRAGMA synchronous = NORMAL;'); // fine for popularity counts; see failure trade-off in docs

db.exec(`
  CREATE TABLE IF NOT EXISTS queries (
    query     TEXT PRIMARY KEY,
    count     INTEGER NOT NULL DEFAULT 0,
    last_seen INTEGER
  );
`);

// Counters so /stats can report real DB read/write numbers instead of guesses.
const counters = { reads: 0, writes: 0 };

const stmts = {
  upsert: db.prepare(`
    INSERT INTO queries (query, count, last_seen)
    VALUES (?, ?, ?)
    ON CONFLICT(query) DO UPDATE SET
      count = count + excluded.count,
      last_seen = excluded.last_seen
  `),
  all: db.prepare(`SELECT query, count, last_seen AS lastSeen FROM queries`),
  total: db.prepare(`SELECT COUNT(*) AS n FROM queries`),
  prefix: db.prepare(`
    SELECT query, count FROM queries
    WHERE query >= ? AND query < ?
    ORDER BY count DESC
    LIMIT ?
  `),
};

// Apply a batch of aggregated updates in a single transaction. This is the only
// write path - POST /search never writes directly (REQUIREMENTS §7).
function flushBatch(rows) {
  if (rows.length === 0) return;
  db.exec('BEGIN');
  try {
    for (const r of rows) {
      stmts.upsert.run(r.query, r.count, r.lastSeen);
      counters.writes += 1;
    }
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}

// Cold-path prefix lookup straight from SQL. The hot path is the in-memory trie;
// this exists as a fallback / sanity check and to show the index range scan works.
function prefixFromDb(prefix, limit) {
  counters.reads += 1;
  // [prefix, prefix + '￿') is the range of all strings starting with prefix.
  const upper = prefix + '￿';
  return stmts.prefix.all(prefix, upper, limit);
}

function loadAll() {
  counters.reads += 1;
  return stmts.all.all();
}

function totalRows() {
  return stmts.total.get().n;
}

module.exports = {
  db,
  counters,
  flushBatch,
  prefixFromDb,
  loadAll,
  totalRows,
};
