'use strict';

// Latency + cache benchmark for /suggest. Start the server first (npm start),
// then in another terminal: npm run bench  (or: node scripts/bench.js 20000)
//
// Reports p50/p95/p99 latency, cache hit rate, and DB read/write counts pulled
// straight from /stats so the numbers in the perf report aren't hand-waved.

const BASE = process.env.BASE || 'http://localhost:3000';
const N = parseInt(process.argv[2], 10) || 20_000;

// A realistic prefix mix: a few hot prefixes get most of the traffic (that's what
// makes a suggestion cache worth having), with a long tail of colder ones.
const HOT = ['ip', 'ja', 'py', 'how', 'best', 'goo', 'you', 'rea'];
const WARM = ['ipho', 'java', 'pyth', 'sam', 'doc', 'git', 'red', 'net', 'mys', 'sys'];
const COLD = ['iphone 1', 'javascript', 'python pa', 'how to', 'best l', 'docker c', 'react h', 'system d', 'data s', 'machine'];

function pickPrefix() {
  const r = Math.random();
  if (r < 0.6) return HOT[(Math.random() * HOT.length) | 0];   // 60% hot
  if (r < 0.9) return WARM[(Math.random() * WARM.length) | 0]; // 30% warm
  return COLD[(Math.random() * COLD.length) | 0];              // 10% cold
}

function percentile(sorted, p) {
  const idx = Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length));
  return sorted[idx];
}

async function getStats() {
  const r = await fetch(`${BASE}/stats`);
  return r.json();
}

async function main() {
  // sanity check
  try {
    const h = await fetch(`${BASE}/health`);
    if (!h.ok) throw new Error();
  } catch {
    console.error(`Can't reach ${BASE}. Start the server with \`npm start\` first.`);
    process.exit(1);
  }

  const before = await getStats();
  console.log(`benchmarking ${N.toLocaleString()} /suggest requests against ${BASE} ...`);

  const latencies = new Array(N);
  const wallStart = process.hrtime.bigint();

  for (let i = 0; i < N; i++) {
    const prefix = pickPrefix();
    const t0 = process.hrtime.bigint();
    const res = await fetch(`${BASE}/suggest?q=${encodeURIComponent(prefix)}`);
    await res.json();
    const t1 = process.hrtime.bigint();
    latencies[i] = Number(t1 - t0) / 1e6; // ms
    if (i % 2000 === 0 && i) process.stdout.write(`\r${i.toLocaleString()} done...`);
  }

  const wallMs = Number(process.hrtime.bigint() - wallStart) / 1e6;
  const after = await getStats();

  latencies.sort((a, b) => a - b);
  const sum = latencies.reduce((a, b) => a + b, 0);

  // Cache hits attributable to this run (the server counts globally).
  const hits = after.cache.hits - before.cache.hits;
  const misses = after.cache.misses - before.cache.misses;
  const runHitRate = hits + misses ? hits / (hits + misses) : 0;

  console.log('\n\n=== /suggest latency ===');
  console.log(`requests   : ${N.toLocaleString()}`);
  console.log(`throughput : ${(N / (wallMs / 1000)).toFixed(0)} req/s (single client, sequential)`);
  console.log(`avg        : ${(sum / N).toFixed(3)} ms`);
  console.log(`p50        : ${percentile(latencies, 50).toFixed(3)} ms`);
  console.log(`p95        : ${percentile(latencies, 95).toFixed(3)} ms`);
  console.log(`p99        : ${percentile(latencies, 99).toFixed(3)} ms`);
  console.log(`max        : ${latencies[latencies.length - 1].toFixed(3)} ms`);

  console.log('\n=== cache (this run) ===');
  console.log(`hits / misses : ${hits.toLocaleString()} / ${misses.toLocaleString()}`);
  console.log(`hit rate      : ${(runHitRate * 100).toFixed(1)}%`);
  console.log(`keys per node : ${JSON.stringify(after.cache.keysPerNode)}`);

  console.log('\n=== datastore ===');
  console.log(`dataset size : ${after.dataset.queries.toLocaleString()} queries`);
  console.log(`db reads     : ${after.db.reads} (suggest reads are served from the trie/cache, not SQL)`);
}

main().catch((e) => { console.error(e); process.exit(1); });
