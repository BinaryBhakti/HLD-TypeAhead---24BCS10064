'use strict';

// Builds data/queries.csv from a Wikipedia pageviews hourly dump.
//
//   node scripts/download-dataset.js [topN] [YYYYMMDD] [HH]
//   e.g. node scripts/download-dataset.js 150000 20240115 12
//
// Each line of a pageviews dump is: "<domain> <page_title> <views> <bytes>".
// We keep en.wikipedia, treat the page title as a search query and views as its
// popularity, clean the title, take the top N by views, and write a query,count CSV.
//
// Why this dataset: it's fully open (no privacy issues like the AOL query log), it
// has a real count per entry, it's reproducible from a fixed URL, and one hour of
// en traffic is comfortably more than the required 100k distinct titles.

const fs = require('fs');
const path = require('path');
const https = require('https');
const zlib = require('zlib');
const readline = require('readline');

const TOP_N = parseInt(process.argv[2], 10) || 150_000;
const DATE = process.argv[3] || '20240115'; // YYYYMMDD
const HOUR = (process.argv[4] || '12').padStart(2, '0'); // HH

const year = DATE.slice(0, 4);
const month = DATE.slice(4, 6);
const url = `https://dumps.wikimedia.org/other/pageviews/${year}/${year}-${month}/pageviews-${DATE}-${HOUR}0000.gz`;

const outPath = path.join(__dirname, '..', 'data', 'queries.csv');

// Namespaces / junk we don't want as "queries".
const SKIP_PREFIX = [
  'Special:', 'File:', 'Talk:', 'Wikipedia:', 'Category:', 'Template:', 'Portal:',
  'Help:', 'Draft:', 'User:', 'Module:', 'MediaWiki:', 'Book:', 'TimedText:',
];

function cleanTitle(raw) {
  let t = raw;
  try { t = decodeURIComponent(t.replace(/\+/g, ' ')); } catch { /* leave as-is on bad encoding */ }
  t = t.replace(/_/g, ' ').trim();
  return t;
}

function keep(title) {
  if (title.length < 2) return false;
  if (title === 'Main Page') return false;
  for (const p of SKIP_PREFIX) if (title.startsWith(p)) return false;
  if (!/[a-zA-Z0-9]/.test(title)) return false; // drop pure punctuation
  return true;
}

function csvField(s) {
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

console.log(`fetching ${url}`);

https.get(url, (res) => {
  if (res.statusCode !== 200) {
    console.error(`HTTP ${res.statusCode} for ${url}`);
    console.error('Pick a date/hour that exists, e.g.: node scripts/download-dataset.js 150000 20240115 12');
    res.resume();
    process.exit(1);
  }

  const rl = readline.createInterface({ input: res.pipe(zlib.createGunzip()), crlfDelay: Infinity });
  const counts = new Map(); // title -> views
  let lines = 0;

  rl.on('line', (line) => {
    lines++;
    // domain title views bytes
    const sp1 = line.indexOf(' ');
    if (sp1 === -1) return;
    const domain = line.slice(0, sp1);
    if (domain !== 'en') return; // English Wikipedia only
    const rest = line.slice(sp1 + 1);
    const sp2 = rest.indexOf(' ');
    if (sp2 === -1) return;
    const rawTitle = rest.slice(0, sp2);
    const views = parseInt(rest.slice(sp2 + 1), 10);
    if (!Number.isFinite(views) || views < 2) return; // drop one-off noise
    const title = cleanTitle(rawTitle);
    if (!keep(title)) return;
    counts.set(title, (counts.get(title) || 0) + views);
    if (lines % 1_000_000 === 0) process.stdout.write(`\rscanned ${(lines / 1e6).toFixed(0)}M lines...`);
  });

  rl.on('close', () => {
    console.log(`\nscanned ${lines.toLocaleString()} lines, ${counts.size.toLocaleString()} candidate titles.`);
    const top = [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, TOP_N);
    const out = fs.createWriteStream(outPath);
    out.write('query,count\n');
    for (const [title, views] of top) out.write(`${csvField(title)},${views}\n`);
    out.end(() => {
      console.log(`wrote ${top.length.toLocaleString()} rows to ${path.relative(process.cwd(), outPath)}`);
      console.log('next: npm run load   (then npm start)');
    });
  });
}).on('error', (e) => {
  console.error('download failed:', e.message);
  console.error('If you are offline, just use the bundled sample: npm run load:sample');
  process.exit(1);
});
