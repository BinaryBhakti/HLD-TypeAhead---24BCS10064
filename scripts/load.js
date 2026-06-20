'use strict';

// Loads a `query,count` CSV into the SQLite primary store.
//
//   node scripts/load.js [path]
//
// Default path is data/queries.csv (the full dataset produced by download-dataset.js).
// Falls back to nothing - if you haven't fetched the big dataset, run:
//   node scripts/load.js data/sample-queries.csv   (npm run load:sample)
//
// Counts are REPLACED, not added, so re-running is idempotent. Duplicate queries
// after normalization (e.g. "iPhone" and "iphone") are summed.

const fs = require('fs');
const readline = require('readline');
const { DatabaseSync } = require('node:sqlite');
const config = require('../src/config');
const { normalize } = require('../src/util');

const file = process.argv[2] || 'data/queries.csv';
if (!fs.existsSync(file)) {
  console.error(`Dataset not found: ${file}`);
  console.error('Either run `npm run fetch-data` for the full dataset, or `npm run load:sample`.');
  process.exit(1);
}

// Minimal CSV field splitter: handles double-quoted fields with embedded commas.
function splitCsv(line) {
  const out = [];
  let cur = '';
  let inQ = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (inQ) {
      if (c === '"') {
        if (line[i + 1] === '"') { cur += '"'; i++; }
        else inQ = false;
      } else cur += c;
    } else if (c === '"') inQ = true;
    else if (c === ',') { out.push(cur); cur = ''; }
    else cur += c;
  }
  out.push(cur);
  return out;
}

async function main() {
  const db = new DatabaseSync(config.dbPath);
  db.exec('PRAGMA journal_mode = WAL;');
  db.exec(`CREATE TABLE IF NOT EXISTS queries (query TEXT PRIMARY KEY, count INTEGER NOT NULL DEFAULT 0, last_seen INTEGER);`);
  db.exec('DELETE FROM queries;'); // fresh load

  const upsert = db.prepare(`
    INSERT INTO queries (query, count, last_seen) VALUES (?, ?, NULL)
    ON CONFLICT(query) DO UPDATE SET count = count + excluded.count
  `);
  const insertMany = (rows) => {
    db.exec('BEGIN');
    try {
      for (const [q, c] of rows) upsert.run(q, c);
      db.exec('COMMIT');
    } catch (e) {
      db.exec('ROLLBACK');
      throw e;
    }
  };

  const rl = readline.createInterface({ input: fs.createReadStream(file), crlfDelay: Infinity });
  let batch = [];
  let total = 0;
  let skipped = 0;
  let headerSeen = false;
  const BATCH = 20_000;

  for await (const line of rl) {
    if (!line) continue;
    if (!headerSeen) {
      headerSeen = true;
      if (/^\s*query\s*,/i.test(line)) continue; // skip header row
    }
    const fields = splitCsv(line);
    if (fields.length < 2) { skipped++; continue; }
    const query = normalize(fields[0]);
    const count = parseInt(fields[1], 10);
    if (!query || !Number.isFinite(count) || count <= 0) { skipped++; continue; }
    batch.push([query, count]);
    if (batch.length >= BATCH) {
      insertMany(batch);
      total += batch.length;
      batch = [];
      process.stdout.write(`\rloaded ${total.toLocaleString()} rows...`);
    }
  }
  if (batch.length) { insertMany(batch); total += batch.length; }

  const distinct = db.prepare('SELECT COUNT(*) AS n FROM queries').get().n;
  console.log(`\ndone. ${total.toLocaleString()} rows read, ${distinct.toLocaleString()} distinct queries in store (${skipped} skipped).`);
  if (distinct < 100_000 && !file.includes('sample')) {
    console.warn('note: under the 100k minimum - fetch a larger dataset with `npm run fetch-data`.');
  }
  db.close();
}

main().catch((e) => { console.error(e); process.exit(1); });
