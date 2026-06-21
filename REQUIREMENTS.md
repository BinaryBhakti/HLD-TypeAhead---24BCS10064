# Search Typeahead - Requirements & Design Notes

This is my working spec for the assignment. It restates what is being asked, then records the
decision I made for each point and *why*. I keep it next to the code so that when I change my
mind about something, the reasoning is in one place.

Roll no: 24BCS10064

---

## 1. What the system has to do

A typeahead/autocomplete backend, plus a small UI to drive it:

- Type a prefix -> get up to 10 suggestions, ranked by search popularity.
- Submit a search -> backend returns a dummy `{ "message": "Searched" }` and the query's count goes up.
- Suggestions are served from a **cache** that sits in front of the primary store.
- The cache is **distributed across several logical nodes**, and which node owns a prefix is
  decided by **consistent hashing**.
- Two ranking modes: plain all-time count (the 60% baseline) and a **recency-aware** ranking for
  trending (the +20%).
- Writes are **batched** instead of hitting the DB once per search (the other +20%).

The assignment is explicitly a *data-systems* exercise. The UI is there to demonstrate the backend,
not the other way around, so most of the thinking below is about storage, caching and ranking.

---

## 2. Stack and why

| Layer | Choice | Reason |
| --- | --- | --- |
| Backend | Node.js + Express | Single language across the stack; the trie/cache/ring logic reads cleanly in JS, which matters for the viva. |
| Datastore | SQLite (`node:sqlite`) | One file, zero setup, real SQL. Node's built-in synchronous driver keeps the read/write paths easy to reason about and easy to count, with no native module to compile. |
| Cache | 3 real Redis nodes (Docker Compose) | Three independent `redis:7-alpine` processes on ports 6379-6381. The app routes each prefix to exactly one of them through a consistent-hash ring it implements itself (`consistentHash.js`). A built-in `memory` backend mirrors the same ring for tests/offline runs. |
| Frontend | Vanilla HTML/CSS/JS | No build step. Debounced fetch + a dropdown is all the UI needs, and there's nothing to explain away. |

The decision worth defending: **the consistent-hash ring lives in my application code, not in
Redis.** A Redis *cluster* would hash keys for me inside the client/cluster, which hides the exact
thing the rubric asks me to implement and demonstrate. So I run three *plain, independent* Redis
nodes and do the routing myself: I hash the prefix, walk the ring, and pick the owning node. That
keeps both properties I need to defend in the viva - real distributed nodes (separate processes,
separate ports, real network hops, key data I can inspect with `redis-cli` in each container) **and**
a ring I own, so I can print which node a key lands on and add/remove a node live to show only ~1/N
of keys move.

The `memory` backend (in-process `Map` per node, same ring) exists so `npm test` and a no-Docker
checkout still work; it is selected with `CACHE_BACKEND=memory`. `CACHE_BACKEND=redis` is the real
demo path. Switching backends changes only the per-node storage, never the routing - which is the
graded part.

---

## 3. Data model

Primary store - one main table:

```
queries(
  query      TEXT PRIMARY KEY,   -- normalized (trimmed + lowercased)
  count      INTEGER NOT NULL,   -- all-time search count
  last_seen  INTEGER             -- epoch ms of the most recent search (for recency)
)
```

Index: `query` is the PK, so prefix range scans (`WHERE query >= ? AND query < ?`) use the index.
That's the cold-path fallback when the trie isn't used; the hot path is the in-memory trie.

Why store `count` *and* `last_seen` rather than a full event log: the assignment wants reliable
counts for a demo, not analytics history. A single aggregated row per query is the smallest thing
that supports both popularity and recency ranking. Recent activity that hasn't been flushed yet
lives in the batch buffer and the trending window (section 6), not in a per-event table.

---

## 4. Suggestion path (the read)

```
GET /suggest?q=<prefix>
   -> normalize prefix
   -> consistent-hash(prefix) -> owning cache node
   -> node hit?  return cached top-10
   -> miss:      ask the trie for top-10 for this prefix
                -> (trending mode) re-rank with recency
                -> store in the owning node with a TTL
                -> return
```

**Trie**: an in-memory prefix trie built from the `queries` table at startup. Every node caches the
top-K (K=10) completions in its subtree, so a lookup is "walk the prefix, return the precomputed
list" - O(prefix length), independent of dataset size. This is the whole reason reads are fast.

**Cache key** is the normalized prefix. **Cache value** is the rendered top-10 list. TTL is short
(default 30s) so a burst of writes can't keep stale suggestions alive for long; trending re-ranking
also invalidates affected prefixes on flush (section 6).

Edge cases the endpoint must handle gracefully: empty/missing `q` -> return trending (not an error);
mixed case -> normalized; no matches -> empty list, 200 not 500.

---

## 5. Consistent hashing

A hash ring with **virtual nodes** (default 150 vnodes per physical node). Key -> hash -> first vnode
clockwise -> physical node. Virtual nodes are what keep the load balanced; without them a 3-node ring
splits traffic very unevenly.

What I have to be able to show:
- `GET /cache/debug?prefix=<p>` returns which node owns the prefix and whether it's currently a hit.
- Adding/removing a node only remaps ~1/N of keys (logged), unlike plain `hash % N` which remaps
  almost everything. This is the entire reason consistent hashing exists and is the likely viva
  question.

---

## 6. Trending / recency (the +20%)

Baseline (60% version): sort by all-time `count` descending. Done by the trie's per-node top-K.

Enhanced version: combine all-time popularity with **recent** activity using a decayed score.

- **Tracking recency**: a separate in-memory "recent counts" map accumulates how many times each
  query was searched inside a sliding window, updated as searches come in.
- **Scoring**: `score = log(1 + all_time_count) + W * recent_weighted`, where `recent_weighted`
  applies **exponential time decay** with a half-life (default ~10 min) so a search from 1 minute
  ago counts far more than one from an hour ago.
- **Why it can't permanently over-rank a short-lived spike**: the recent term *decays to zero* on
  its own once searches stop, and only the (log-dampened) all-time count remains. A query that was
  hot for ten minutes falls back down once the window moves past it - no manual cleanup needed.
- **Cache interaction**: when the trending window updates rankings (on each batch flush), the
  affected prefixes are invalidated in the cache so the next read recomputes. Between flushes the
  TTL bounds staleness anyway.
- **Trade-offs**: recompute-on-flush keeps reads cheap (the read never does the decay math for the
  whole dataset) at the cost of suggestions being up to one flush-interval stale. That's the right
  call for a typeahead - freshness within seconds is plenty, and the read latency stays flat.

`GET /suggest` serves *both* modes; a flag/env switch selects the ranking so I can demo the
difference on the same endpoint with the same data.

---

## 7. Batch writes (the other +20%)

Goal: don't write to SQLite once per `POST /search`.

```
POST /search -> enqueue(query) into an in-memory buffer (aggregating duplicates) -> return 200 immediately
batch writer  -> every FLUSH_MS (default 2s) OR when buffer hits FLUSH_SIZE (default 500 distinct):
                 -> one transaction: UPSERT each (query, +count, last_seen)
                 -> update the trie counts + recent-window
                 -> invalidate touched prefixes in cache
```

- **Aggregation**: if "iphone" is searched 50 times between flushes, that's *one* row update of
  `count += 50`, not 50 writes. The write-reduction number in the perf report comes straight from
  this ratio.
- **Failure trade-off (the question they'll ask)**: the buffer is in memory. If the process crashes
  before a flush, the searches since the last flush are lost - at most `FLUSH_MS` of writes. For a
  typeahead that is acceptable: counts are popularity hints, not money. I note in the report how
  you'd harden it (append to a write-ahead log / durable queue before acking) and why I didn't -
  it's out of scope for a single-process demo and would add the very synchronous write we're trying
  to avoid.

---

## 8. APIs

| Method | Route | Behaviour |
| --- | --- | --- |
| GET | `/suggest?q=<prefix>` | Up to 10 prefix matches, ranked by count (or recency in trending mode). Empty/blank `q` returns trending. |
| POST | `/search` | Body `{ "query": "..." }`. Returns `{ "message": "Searched" }` and enqueues a count update. |
| GET | `/trending` | Current top trending queries (recency-weighted). Used by the UI panel. |
| GET | `/cache/debug?prefix=<p>` | Owning node id for the prefix + hit/miss. |
| GET | `/stats` | Cache hit rate, DB read/write counts, buffer depth - feeds the perf report. |
| GET | `/health` | Liveness. |

`/trending` and `/stats` aren't in the minimum list; I added them because the UI needs trending and
the perf report needs real counters rather than hand-waving.

---

## 9. Dataset

Requirement: >=100,000 queries, each with a count.

**Primary dataset: Wikipedia pageview dumps** (`dumps.wikimedia.org/other/pageviews/...`). Each line
is `domain page-title view-count bytes`. Filtering `en` for a single hour gives hundreds of thousands
of `title -> count` rows. I treat **page title as the query** and **view count as the popularity**.
It's fully open (no privacy issues like the AOL query log has), reproducible from a fixed URL, and
trivially clears 100k rows. `scripts/download-dataset.js` streams the `.gz`, filters/cleans titles
(underscores -> spaces, drop `Main_Page`/`Special:` junk), takes the top N, and writes
`data/queries.csv`.

**Bundled fallback**: `data/sample-queries.csv` (a few thousand rows) is committed so the app runs
immediately after `npm install` without downloading anything. The README is explicit that the full
>=100k load is the real demo and the sample is just so nothing is broken on first clone.

Why not AOL: it's the textbook "search query log", and I mention it in the viva, but the official
release was pulled over a privacy incident and mirrors are flaky - bad for a "just run it"
reproducibility story. Wikipedia pageviews give the same `query,count` shape without that baggage.

Loader (`scripts/load.js`) normalizes each query, upserts into SQLite, then the server builds the
trie from the table at startup.

---

## 10. Non-functional targets

- Easy local run: `npm install`, `npm run load`, `npm start`. No external services.
- Suggest latency: report **p95** from `scripts/bench.js` (hammers `/suggest` over a prefix mix).
- Report **cache hit rate** and **DB read/write counts** from `/stats`.
- Log consistent-hashing behaviour (node ownership + remap-on-resize).
- Code: modular files per concern (trie / ring / cache / trending / batch / service / server),
  readable, commented where the *why* isn't obvious.

---

## 11. Mapping to the rubric

| Component | Marks | Where it lives |
| --- | --- | --- |
| Basic implementation | 60 | `load.js` (ingestion), `public/` (UI), `suggestService` + `/suggest`, `/search`, batch UPSERT into SQLite, `consistentHash` + `cache` (distributed cache). |
| Trending searches | 20 | `trending.js` (decayed score), enhanced ranking on `/suggest`, `/trending`, explanation in §6. |
| Batch writes | 20 | `batchWriter.js`, write-reduction numbers in the perf report, failure discussion in §7. |

---

## 12. Things explicitly out of scope

So I don't get asked "why didn't you do X" without an answer:

- No Redis *cluster* / sharding-in-the-client - the ring is mine on purpose (see §2). The nodes are
  real separate Redis processes, but routing is application-side.
- No personalization or ML ranking (popularity + recency only - that's what the rubric asks for).
- No auth, no rate limiting - not part of the assignment.
- Cache isn't persisted (Redis runs with `--save "" --appendonly no`); the trie is rebuilt from
  SQLite on restart, which is the source of truth.
