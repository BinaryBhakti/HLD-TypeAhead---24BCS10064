# Performance Report

All numbers below are measured, not estimated - reproduce them with `npm run bench` and the snippet
at the end.

## Environment

- Node.js v24.14, Windows 11, single dev machine
- **Dataset: 149,803 distinct queries** - Wikipedia pageviews (one hour of `en` traffic, top 150k by
  view count; some collapse on normalization). Loaded via `npm run fetch-data && npm run load`.
- Store: SQLite via `node:sqlite`
- Cache: 3 nodes, 150 virtual nodes each, 30s TTL. Measured on **both** backends: `redis` (three
  `redis:7-alpine` containers from `docker-compose.yml`) and `memory` (in-process). Same ring.
- Ranking: trending (recency-aware)
- Benchmark client: single-threaded, sequential requests (so the latency figures are per-request
  service time, not contended throughput)

## 1. Suggestion latency - `GET /suggest`

20,000 requests over a realistic prefix mix (60% hot prefixes, 30% warm, 10% cold), full 150k dataset,
measured on each cache backend:

| Metric | `redis` (3 containers) | `memory` (in-process) |
| --- | --- | --- |
| avg | 5.18 ms | 0.55 ms |
| p50 | 4.56 ms | 0.37 ms |
| **p95** | **9.14 ms** | **1.50 ms** |
| p99 | 15.2 ms | 2.67 ms |
| max | 147.8 ms | 19.9 ms |
| throughput | ~193 req/s | ~1,800 req/s |

The gap is the cost of being genuinely distributed: every cache hit on the `redis` backend is a real
TCP round-trip to a separate process, where the `memory` backend is a `Map` lookup in the same heap.
~9 ms p95 against real Redis on loopback is the honest number for a distributed cache; the `memory`
column is the lower bound the routing logic itself adds (sub-2 ms). Either way:

**Latency does not grow with dataset size.** On the 116-row sample the `memory` benchmark gave p95
1.06 ms; on 149,803 rows it's 1.50 ms - same order of magnitude. This is the trie paying off: a
lookup is O(prefix length), independent of how many queries are stored.

## 2. Cache effectiveness

From the `redis` run (`/stats`):

| Metric | Value |
| --- | --- |
| hits / misses | 19,888 / 112 |
| **hit rate** | **99.4%** |

Only the first request for each distinct prefix misses; every subsequent request is a hit until the
TTL expires or a write invalidates that prefix. A small set of hot prefixes serving the overwhelming
majority of traffic is exactly the real-world pattern, and it's why caching suggestion *results* (not
just raw data) pays off. The cached values live in the Redis containers themselves - `docker exec
typeahead-cache-0 redis-cli dbsize` reports the keys that node owns, and the per-node counts match
`/stats` `keysPerNode` exactly.

## 3. Database reads avoided

During the 20,000-request run, total DB reads = **1** (the one-time load at startup). Suggestions are
served from the trie and cache, never from SQL. That "1" is the headline: the read path does not touch
the database at all, no matter the dataset size.

## 4. Write reduction via batching - `POST /search`

90 raw searches submitted (60x "new york city", 30x "apple inc."), default flush settings
(2s / 500 distinct):

| Metric | Value |
| --- | --- |
| searches enqueued | 90 |
| DB rows written | 5 |
| **write reduction** | **18x** |

The repeats of each query were aggregated into single `count += N` updates, spread across the flush
windows that elapsed during the run (5 rows across 4 flushes). With a steadier stream of repeated
popular queries the reduction is larger - the ratio scales with how repetitive and bursty the traffic
is. The trade-off is durability: a crash loses at most one flush interval of un-flushed searches
(popularity counts only) - see [architecture.md](architecture.md#failure-model).

## 5. Consistent hashing - distribution and remap

100,000 keys across 3 cache nodes, then a 4th node added (`node -e` snippet below). These numbers are
dataset-independent - they're a property of the ring, not the data:

**Distribution (3 nodes)** - even, thanks to 150 virtual nodes + a murmur3 hash finalizer:

| node | keys | share |
| --- | --- | --- |
| cache-0 | 30,987 | 31.0% |
| cache-1 | 34,841 | 34.8% |
| cache-2 | 34,172 | 34.2% |

**Remap on adding a node** - only **26.7%** of keys moved (ideal for 3 -> 4 is 25%). Plain
`hash(key) % N` would have remapped roughly **75%**. That ~3x difference in cache churn on a topology
change is the entire reason consistent hashing is used here.

> Note: with a *small* number of distinct keys the per-node split looks lumpy (e.g. `keysPerNode` in
> `/stats` after a short benchmark shows ~4/13/13 across only ~30 cached prefixes), because there
> simply aren't enough keys to average out. The 100k-key test above is the fair measure of balance.

## 6. Memory footprint (the trade-off behind the fast reads)

The running server holds **~679 MB RSS** with the full 149,803-query dataset loaded. That cost buys
the O(prefix) reads above: every trie node caches a top-K *candidate pool* (K=50, sliced to 10 after
recency re-ranking), and the entry objects are shared across nodes.

This is the honest trade-off - materialized top-K is memory-hungry. It's fine for a single-process
local demo, and it's tunable: lowering `DEFAULT_K` in [trie.js](../src/trie.js) shrinks memory at the
cost of trending depth (fewer candidates for the recency re-ranker to pull from). Production-scale
typeahead systems use more compact structures (finite-state transducers, packed arrays) for the same
reason; that's a deliberate non-goal here.

## How to reproduce

```bash
npm run fetch-data && npm run load   # full ~150k dataset
docker compose up -d                 # the 3 Redis cache nodes
CACHE_BACKEND=redis npm start        # terminal 1  (or plain `npm start` for the memory backend)
npm run bench 20000                  # terminal 2  -> latency + cache numbers
docker exec typeahead-cache-0 redis-cli dbsize   # keys actually living in a node

# write reduction:
for i in $(seq 1 60); do curl -s -X POST localhost:3000/search \
  -H "Content-Type: application/json" -d '{"query":"new york city"}' >/dev/null; done
sleep 2.5 && curl -s localhost:3000/stats     # see batch.writeReduction

# consistent-hash distribution + remap:
node -e '
const { ConsistentHashRing } = require("./src/consistentHash");
const keys = Array.from({length:100000},(_,i)=>"prefix"+i);
const ring = new ConsistentHashRing(["cache-0","cache-1","cache-2"],150);
const before = keys.map(k=>ring.getNode(k));
const d={}; before.forEach(n=>d[n]=(d[n]||0)+1); console.log("3 nodes:",d);
ring.addNode("cache-3");
let m=0; keys.forEach((k,i)=>{if(ring.getNode(k)!==before[i])m++;});
console.log("moved on add:",(m/1000).toFixed(1)+"%");
'
```
