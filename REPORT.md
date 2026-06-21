# Search Typeahead System — Project Report

**Roll no:** 24BCS10064

A search autocomplete backend: type a prefix and get the 10 most relevant queries, ranked by
popularity and recent activity; submit a search and the popularity updates. The engineering focus is
the data layer — a prefix trie for fast reads, a distributed cache addressed by a hand-written
consistent-hash ring across three real Redis nodes, recency-aware "trending" ranking, and batched
writes so the database isn't touched on every search.

**Contents**
1. [Architecture](#1-architecture)
2. [Dataset — source and loading](#2-dataset--source-and-loading)
3. [API documentation](#3-api-documentation)
4. [Design choices and trade-offs](#4-design-choices-and-trade-offs)
5. [Performance report](#5-performance-report)

---

## 1. Architecture

The system separates **reads** (suggestions) from **writes** (search submissions). Reads are served
entirely from memory and a cache and never block on the database; writes are buffered and applied to
the database in aggregated batches.

```
                         ┌──────────────────────────────────────────────┐
                         │                  Browser UI                    │
                         │   debounced GET /suggest   |   POST /search     │
                         └───────────────┬────────────────────┬───────────┘
                          GET /suggest    │                    │ POST /search
                                          ▼                    ▼
        READ PATH                                                        WRITE PATH
 ┌───────────────────────────────────────────┐        ┌───────────────────────────────────┐
 │ SuggestService                              │        │ BatchWriter                         │
 │  1. normalize prefix                        │        │  enqueue(query) -> in-mem buffer    │
 │  2. consistent-hash(prefix) -> cache node   │        │  aggregate duplicates               │
 │  3. cache hit?  return cached top-10         │       │                                     │
 │  4. miss: ask trie for candidates           │        │  flush every 2s OR 500 distinct:    │
 │  5. trending mode? recency re-rank           │       │   | one SQLite transaction (UPSERT) │
 │  6. store in owning node (TTL) and return    │       │   | bump trie counts                │
 └─────┬──────────────────────────┬─────────────┘       │   | record into trending window     │
       │                          │                      │   | invalidate touched prefixes     │
       ▼                          ▼                      └──────────────┬──────────────────────┘
 ┌──────────────────────┐  ┌──────────────────┐                        │ updates
 │ DistributedCache      │  │ Trie (in-memory) │◄───────────────────────┘
 │ consistent-hash ring  │  │  per-node top-K  │
 │   │                   │  └────────┬─────────┘
 │   ├─► Redis cache-0    │           │ built at startup from
 │   ├─► Redis cache-1    │           ▼
 │   └─► Redis cache-2    │  ┌──────────────────┐
 │   (TTL per entry)      │  │ SQLite (queries) │  ◄── source of truth
 └──────────────────────┘  │  query,count,seen │
                            └──────────────────┘
```

### Components

| Module | Role |
| --- | --- |
| `src/server.js` | Express app and routes; wires the components together. |
| `src/suggestService.js` | The read path: cache → trie → optional recency re-rank. |
| `src/trie.js` | Prefix trie; every node caches the top-K completions in its subtree. |
| `src/consistentHash.js` | Hash ring with virtual nodes — maps a prefix to one cache node. |
| `src/cache.js` | Distributed cache over the ring; Redis or in-memory backend, TTL per entry. |
| `src/trending.js` | Exponentially-decaying recency score per query. |
| `src/batchWriter.js` | Buffers searches, aggregates duplicates, flushes to SQLite in batches. |
| `src/db.js` | SQLite primary store (`node:sqlite`), single batched write path. |
| `public/` | Vanilla HTML/CSS/JS UI: debounced suggest, dropdown, keyboard nav, trending panel. |

### How a request flows

**Suggestion (read).** The prefix is normalized (trimmed, lowercased). It is hashed onto the
consistent-hash ring, which selects one of three cache nodes. On a hit, the cached top-10 list is
returned directly. On a miss, the trie is walked to the prefix node — `O(prefix length)`, independent
of dataset size — its precomputed candidate pool is (optionally) re-ranked by recency, sliced to 10,
stored back in the owning cache node under a TTL, and returned.

**Search (write).** `POST /search` does **not** write to SQLite. It pushes the query into an in-memory
buffer that aggregates duplicates and returns `{"message":"Searched"}` immediately. A background worker
flushes the buffer — every 2 seconds or once 500 distinct queries accumulate, whichever comes first —
applying all updates in a single transaction, then updating the trie, recording recency, and
invalidating the affected cache prefixes so the next read recomputes.

### Why reads never hit SQLite

After the one-time load at startup, suggestions are answered by the cache or the trie — both fast
paths. SQLite is touched only by (a) the startup load and (b) batched writes. A 20,000-request
benchmark produced **1** total DB read (see §5). That is the entire purpose of the trie + cache layer.

### Fault tolerance

The cache is an optimization, not a hard dependency. If a Redis node is unreachable or errors, the
read **degrades to a cache miss and is served from the trie** instead of failing. A single cache node
going down therefore never fails a suggestion or crashes the process — verified by killing a node
mid-traffic and confirming all requests still returned `200` and recovered cleanly when the node
came back.

---

## 2. Dataset — source and loading

**Requirement:** ≥ 100,000 queries, each with a count.

**Source: Wikipedia pageviews hourly dumps** (`https://dumps.wikimedia.org/other/pageviews/`). Each
line is `domain page-title view-count bytes`. Filtering English (`en`) traffic for a single hour gives
hundreds of thousands of `title → count` rows. The **page title is the query** and the **view count is
the popularity signal**.

Why this dataset: it is fully open (no privacy issues like the pulled AOL query log), it has a genuine
count per entry, it is reproducible from a fixed URL, and one hour of `en` traffic comfortably exceeds
the 100k-row minimum. The bundled `data/queries.csv` holds **149,803 distinct queries** built this way.

### Loading instructions

```bash
npm install

# Option A — use the dataset committed in the repo (149,803 rows):
npm run load

# Option B — rebuild from a fresh Wikipedia dump, then load:
node scripts/download-dataset.js 150000 20240115 12   # topN, YYYYMMDD, HH
npm run load

# Option C — tiny bundled sample (~116 rows), for a quick smoke test:
npm run load:sample
```

`scripts/download-dataset.js` streams the `.gz`, keeps `en` titles, cleans them (underscores → spaces,
drops namespace pages like `Special:`/`Talk:`, drops one-off noise), takes the top N by views, and
writes `query,count` to `data/queries.csv`. `scripts/load.js` normalizes each query and UPSERTs it into
SQLite; the server builds the trie from that table at startup.

> Verified end to end against a live dump: 7.75M lines scanned → 456K candidate titles → clean
> `query,count` output, counts sorted descending, zero namespace junk, zero malformed rows.

---

## 3. API documentation

Base URL: `http://localhost:3000`

### `GET /suggest?q=<prefix>`
Up to 10 prefix matches, ranked by all-time count (or recency-aware score when `RANK_MODE=trending`,
the default). `q` is normalized (trimmed, lowercased). Empty/missing `q` returns the trending list
instead of an error; an unknown prefix returns an empty list with HTTP 200.

```json
{
  "prefix": "ip",
  "suggestions": [
    { "query": "iphone", "count": 100000, "score": 11.51 },
    { "query": "ipad",   "count": 67000,  "score": 11.11 }
  ],
  "cached": false,
  "nodeId": "cache-1",
  "source": "trie"
}
```
- `score` is present only in trending mode. `cached` indicates a cache hit; `nodeId` is the owning
  cache node; `source` is `cache` | `trie` | `trending`.

### `POST /search`
Body `{ "query": "<text>" }`. Records the search (buffered for the next batch flush — **not** written
synchronously) and returns the dummy response. Missing/blank query → HTTP 400; malformed JSON →
`{"error":"invalid JSON body"}` with HTTP 400.

```json
{ "message": "Searched" }
```
The count update becomes visible in `/suggest` and `/trending` after the next flush (≤ 2s by default).

### `GET /trending?limit=<n>`
Current trending queries, ordered by **decayed recent activity** (not raw count). Falls back to
all-time top queries when nothing recent exists, so the panel is never empty.

```json
{ "trending": [ { "query": "iphone", "count": 100000, "recentWeight": 40.85 } ], "rankMode": "trending" }
```

### `GET /cache/debug?prefix=<prefix>`
Which cache node owns a prefix and whether it is currently cached. Demonstrates consistent-hash
routing. This call **peeks** — it does not count as a hit/miss.

```json
{ "prefix": "ip", "node": "cache-1", "hit": true, "ttlRemainingMs": 29759 }
```

### `GET /stats`
Live counters for the performance report: cache backend/nodes/hit-rate/keys-per-node, DB read/write
counts, and batch buffer depth + write-reduction ratio.

```json
{
  "rankMode": "trending",
  "dataset": { "queries": 149803 },
  "cache": { "backend": "redis", "nodes": 3, "hits": 19888, "misses": 112,
             "hitRate": 0.9944, "keysPerNode": { "cache-0": 9, "cache-1": 2, "cache-2": 8 } },
  "db": { "reads": 1, "writes": 2 },
  "batch": { "enqueued": 90, "rowsWritten": 5, "flushes": 4, "bufferDepth": 0, "writeReduction": 18.0 }
}
```

### `GET /health`
`{ "ok": true }` — liveness.

---

## 4. Design choices and trade-offs

### Stack
| Layer | Choice | Reason |
| --- | --- | --- |
| Backend | Node.js + Express | One language across the stack; the trie/cache/ring logic reads cleanly in JS. |
| Datastore | SQLite via `node:sqlite` | One file, real SQL, no native module to compile; synchronous API makes the read/write paths easy to reason about and to count. |
| Cache | 3 real Redis nodes (Docker Compose) | Three independent processes on ports 6379–6381; the app routes prefixes across them via a ring it implements itself. An in-process `memory` backend mirrors the same ring for tests/offline runs. |
| Frontend | Vanilla HTML/CSS/JS | No build step; a debounced input + dropdown is all the UI needs. |

### Trie for suggestions
A prefix trie gives `O(prefix length)` lookups, independent of dataset size, because each node caches
the top-K completions in its subtree. The alternative — a sorted array with binary search — finds the
prefix range in `O(log n)` but then must scan and sort that whole range per request, which is far worse
for short, hot prefixes (e.g. `"a"`) that match a huge slice of the data. A key invariant makes the
trie cheap to maintain: counts only ever increase, so top-K is updated incrementally on each write
rather than recomputing a subtree.

**Trade-off:** the materialized top-K is memory-hungry (≈ 679 MB RSS for 149,803 queries, see §5). That
is the deliberate price of flat read latency; it is tunable by lowering the candidate-pool size `K`.

### Consistent hashing with virtual nodes
The ring lives in **application code**, not in a Redis cluster. A Redis cluster would hash keys for us
inside the client — hiding the exact mechanism the assignment asks us to implement. So we run three
*plain, independent* Redis nodes and route ourselves: hash the prefix, walk the ring clockwise to the
first virtual node, pick its physical node. **150 virtual nodes per physical node** (plus a murmur3-style
hash finalizer) keep the load even; without virtual nodes a 3-node ring splits traffic very unequally.

**Why this matters:** adding or removing a node remaps only ≈ 1/N of keys, versus ≈ all of them for
naïve `hash(key) % N`. Measured: adding a 4th node moved **26.7%** of keys vs ~75% for modulo (see §5).

### Cache-aside with TTL
`/suggest` is cache-aside: check the cache, compute from the trie on a miss, write back with a short
TTL (default 30s). The TTL bounds staleness so a burst of writes cannot keep stale suggestions alive;
writes additionally invalidate the affected prefixes on flush. **Trade-off:** suggestions can be up to
one flush-interval (≈ 2s) or one TTL stale — acceptable for typeahead, where freshness within seconds
is plenty and read latency stays flat.

### Batch writes
Writing to SQLite once per search would make the DB the bottleneck. Instead, searches are buffered and
duplicates aggregated, so 50 searches for one query become a single `count += 50` update. **Failure
trade-off:** the buffer is in memory, so a crash loses at most one flush-interval of searches — and only
popularity counts, never user data. The trie is rebuilt from SQLite (the source of truth) on restart.
Hardening would mean a write-ahead log before acking, reintroducing the synchronous write batching
exists to avoid — out of scope for this assignment and documented as such.

### Trending: continuous exponential decay
Rather than discrete hourly buckets, each query keeps a single exponentially-decaying recency
accumulator with a ~10-minute half-life. The suggestion score is
`score = log(1 + all_time_count) + W · decayed_recent_weight`. A short spike decays to zero on its own,
so it cannot permanently over-rank a query — no manual cleanup needed; decayed entries are pruned on
each flush. **Trade-off vs buckets:** simpler and continuous, at the cost of not retaining an explicit
per-hour history (which this use case does not need).

### Fault tolerance over strict consistency
A cache-node failure degrades to a trie read rather than an error (see §1). We chose availability —
suggestions keep working from the trie — over surfacing a cache outage to the user, which is the right
call for a best-effort suggestion feature.

---

## 5. Performance report

All figures are **measured**, reproducible with `npm run bench` and the snippets below.

**Environment:** Node.js v24, Windows 11, single dev machine. Dataset: 149,803 distinct queries
(Wikipedia pageviews). Cache: 3 nodes, 150 virtual nodes each, 30s TTL. Ranking: trending. Benchmark
client: single-threaded, sequential (so latencies are per-request service time, not contended
throughput).

### 5.1 Suggestion latency — `GET /suggest`
20,000 requests over a realistic prefix mix (60% hot, 30% warm, 10% cold), full dataset, measured on
each cache backend:

| Metric | `redis` (3 containers) | `memory` (in-process) |
| --- | --- | --- |
| avg | 5.18 ms | 0.55 ms |
| p50 | 4.56 ms | 0.37 ms |
| **p95** | **9.14 ms** | **1.50 ms** |
| p99 | 15.2 ms | 2.67 ms |
| throughput | ~193 req/s | ~1,800 req/s |

The gap is the cost of being genuinely distributed: every hit on the Redis backend is a real TCP
round-trip to a separate process, where the memory backend is a same-heap `Map` lookup. **Latency does
not grow with dataset size** — the trie makes a lookup `O(prefix length)`, so the 116-row sample and the
149,803-row dataset give the same order of magnitude.

### 5.2 Cache effectiveness
From the Redis run: **19,888 hits / 112 misses = 99.4% hit rate.** Only the first request for each
distinct prefix misses; a small set of hot prefixes serving most traffic is the real-world pattern and
is why caching suggestion *results* (not just raw data) pays off. The cached values live in the Redis
containers themselves — `docker exec typeahead-cache-0 redis-cli dbsize` reports the keys a node owns,
and the per-node counts match `/stats` exactly.

### 5.3 Database reads avoided
During the 20,000-request run, total DB reads = **1** (the startup load). The read path never touches
SQL, regardless of dataset size.

### 5.4 Write reduction — `POST /search`
With repeated popular queries (e.g. 90 raw searches across a few distinct queries), aggregation
collapsed them into a handful of UPSERTs — a measured **~18× write reduction**; the ratio scales with
how repetitive and bursty traffic is (a controlled 60-search / 2-query test showed 30×). Trade-off:
a crash loses at most one flush interval of un-flushed counts.

### 5.5 Consistent hashing — distribution and remap
100,000 keys across 3 nodes (a property of the ring, not the data):

| node | keys | share |
| --- | --- | --- |
| cache-0 | 30,987 | 31.0% |
| cache-1 | 34,841 | 34.8% |
| cache-2 | 34,172 | 34.2% |

Adding a 4th node remapped only **26.7%** of keys (ideal for 3→4 is 25%); naïve `hash % N` would remap
~75%. That ~3× reduction in cache churn on a topology change is the entire reason consistent hashing is
used.

### 5.6 Memory footprint (the trade-off behind fast reads)
The server holds **~679 MB RSS** with the full dataset loaded — the cost of the materialized per-node
top-K that buys `O(prefix)` reads. Tunable by lowering the candidate-pool size `K`.

### 5.7 Correctness and robustness testing
- **Unit tests** (`npm test`): 12/12 — trie top-K, ring distribution/remap, decay maths, cache.
- **API edge cases**: 56/56 on **both** backends — empty/missing/whitespace/unicode/SQL-injection
  inputs, no-match, case-folding, ≤10 results, 404s, malformed JSON, 60 concurrent requests.
- **Frontend (real browser)**: 24/24 — debounce coalescing, dropdown, keyboard nav (↑/↓/Enter/Esc),
  click/Go submit, trending clicks, "No matches" and error states, no uncaught JS errors.
- **Batch paths**: 15/15 — `FLUSH_SIZE` early flush, aggregation, shutdown drain.
- **Resilience**: a Redis node killed mid-traffic — all requests stayed `200` (served from the trie)
  and the cache resumed on recovery.

### Reproduce
```bash
npm run load                          # full dataset
docker compose up -d                  # 3 Redis cache nodes
CACHE_BACKEND=redis npm start         # terminal 1  (or plain `npm start` for the memory backend)
npm run bench 20000                   # terminal 2  -> latency + cache numbers
docker exec typeahead-cache-0 redis-cli dbsize   # keys living in a node

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
