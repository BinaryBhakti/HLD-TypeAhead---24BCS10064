'use strict';

// Plain assertion tests, no framework. Run with `npm test`.
// These cover the bits whose correctness isn't obvious by reading: the trie's
// top-K, the ring's remap behaviour, and the decay maths.

const assert = require('node:assert');
const { Trie } = require('../src/trie');
const { ConsistentHashRing } = require('../src/consistentHash');
const { Trending } = require('../src/trending');
const { DistributedCache } = require('../src/cache');

let passed = 0;
const pending = [];
// Register tests; run them in order at the end. fn may be sync or async (the
// cache tests await Redis-shaped, now-async calls - here on the memory backend).
function test(name, fn) {
  pending.push(async () => {
    try {
      await fn();
      passed++;
      console.log(`  ok  ${name}`);
    } catch (e) {
      console.error(`FAIL  ${name}\n      ${e.message}`);
      process.exitCode = 1;
    }
  });
}

// ---- trie -------------------------------------------------------------------
test('trie returns prefix matches sorted by count desc', () => {
  const t = new Trie();
  t.upsert('iphone', 100);
  t.upsert('iphone 15', 85);
  t.upsert('iphone case', 54);
  t.upsert('ipad', 67);
  const r = t.topK('ip', 10).map((e) => e.query);
  assert.deepStrictEqual(r, ['iphone', 'iphone 15', 'ipad', 'iphone case']);
});

test('trie narrows as the prefix grows', () => {
  const t = new Trie();
  t.upsert('iphone', 100);
  t.upsert('ipad', 67);
  assert.deepStrictEqual(t.topK('ipa', 10).map((e) => e.query), ['ipad']);
});

test('trie returns [] for a prefix with no matches', () => {
  const t = new Trie();
  t.upsert('iphone', 100);
  assert.deepStrictEqual(t.topK('zzz', 10), []);
});

test('trie re-ranks when an existing count rises', () => {
  const t = new Trie();
  t.upsert('apple', 10);
  t.upsert('apricot', 50);
  assert.strictEqual(t.topK('ap', 10)[0].query, 'apricot');
  t.upsert('apple', 200); // apple overtakes
  assert.strictEqual(t.topK('ap', 10)[0].query, 'apple');
});

// ---- consistent hashing -----------------------------------------------------
test('ring spreads keys roughly evenly across nodes', () => {
  const ring = new ConsistentHashRing(['a', 'b', 'c'], 150);
  const counts = { a: 0, b: 0, c: 0 };
  for (let i = 0; i < 30000; i++) counts[ring.getNode('key' + i)]++;
  // each node should be within ~25% of a perfectly even 1/3 split
  for (const n of ['a', 'b', 'c']) {
    const share = counts[n] / 30000;
    assert.ok(share > 0.25 && share < 0.42, `node ${n} share ${share.toFixed(3)} off`);
  }
});

test('adding a node remaps far less than hash % N would', () => {
  const keys = Array.from({ length: 30000 }, (_, i) => 'k' + i);
  const ring = new ConsistentHashRing(['a', 'b', 'c'], 150);
  const before = keys.map((k) => ring.getNode(k));
  ring.addNode('d');
  let moved = 0;
  keys.forEach((k, i) => { if (ring.getNode(k) !== before[i]) moved++; });
  const frac = moved / keys.length;
  // ~1/4 of keys should move (the share the new node takes). modulo would move ~3/4.
  assert.ok(frac < 0.4, `moved ${(frac * 100).toFixed(1)}% on add - too many`);
});

// ---- trending ---------------------------------------------------------------
test('recent activity lifts a query above an all-time favourite', () => {
  const tr = new Trending({ halfLifeMs: 600000, weight: 3 });
  const now = 1_000_000;
  // "old" has huge all-time count; "hot" was just searched a lot.
  tr.record('hot', 200, now);
  const ranked = tr.rerank([{ query: 'old', count: 100000 }, { query: 'hot', count: 50 }], 2, now);
  assert.strictEqual(ranked[0].query, 'hot');
});

test('a spike decays away and no longer over-ranks later', () => {
  const tr = new Trending({ halfLifeMs: 600000, weight: 3 });
  const t0 = 1_000_000;
  tr.record('hot', 200, t0);
  const early = tr.recentWeight('hot', t0);
  const later = tr.recentWeight('hot', t0 + 3_600_000); // 1h = 6 half-lives later
  assert.ok(later < early / 50, `weight barely decayed: ${early} -> ${later}`);
});

test('prune drops decayed-to-nothing entries', () => {
  const tr = new Trending({ halfLifeMs: 1000, weight: 3 });
  tr.record('x', 1, 0);
  tr.prune(100000); // long after, fully decayed
  assert.strictEqual(tr.recentWeight('x', 100000), 0);
});

// ---- cache (memory backend; the redis backend shares this exact routing) -----
test('cache stores and serves, and expires by TTL', async () => {
  const c = new DistributedCache({ nodes: 3, ttlMs: 1000 });
  await c.set('ip', [{ query: 'iphone', count: 100 }], 0);
  assert.strictEqual((await c.get('ip', 500)).hit, true);
  assert.strictEqual((await c.get('ip', 2000)).hit, false); // past TTL
});

test('invalidate removes a key from its owning node', async () => {
  const c = new DistributedCache({ nodes: 3, ttlMs: 100000 });
  await c.set('java', [{ query: 'java', count: 1 }], 0);
  assert.strictEqual((await c.get('java', 0)).hit, true);
  c.invalidate('java');
  // invalidate is fire-and-forget; on the memory backend the delete is synchronous,
  // but await a microtask turn to be safe regardless of backend.
  await Promise.resolve();
  assert.strictEqual((await c.get('java', 0)).hit, false);
});

test('a prefix always routes to the same node', async () => {
  const c = new DistributedCache({ nodes: 5 });
  const n1 = (await c.inspect('python')).nodeId;
  const n2 = (await c.inspect('python')).nodeId;
  assert.strictEqual(n1, n2);
});

(async () => {
  for (const run of pending) await run();
  console.log(`\n${passed} passed`);
})();
