# Architecture

## The two paths

Reads (suggestions) and writes (search submissions) are deliberately separated. Reads are served
entirely from memory and never block on the database; writes are buffered and applied to the
database in batches.

```
                         ┌─────────────────────────────────────────────┐
                         │                  Browser UI                  │
                         │   debounced /suggest   |   /search on enter   │
                         └───────────────┬───────────────┬───────────────┘
                                         │ GET /suggest  │ POST /search
                                         ▼               ▼
   READ PATH                                                          WRITE PATH
 ┌──────────────────────────────────────┐         ┌──────────────────────────────────┐
 │ SuggestService                        │         │ BatchWriter                        │
 │  1. normalize prefix                  │         │  enqueue(query) -> in-mem buffer   │
 │  2. consistent-hash -> cache node     │         │  aggregate duplicates              │
 │  3. cache hit? return top-10          │         │                                    │
 │  4. miss: ask trie for candidates     │         │  flush every 2s OR 500 distinct:   │
 │  5. trending mode? recency re-rank    │         │   | one DB transaction (UPSERT)    │
 │  6. store in owning node (TTL)        │         │   | bump trie counts               │
 └───────┬───────────────────┬───────────┘         │   | record into trending window    │
         │                   │                      │   | invalidate touched prefixes    │
         ▼                   ▼                      └───────────────┬────────────────────┘
 ┌───────────────┐   ┌───────────────────┐                         │
 │ DistributedCache│  │ Trie (in-memory)  │◄────────────────────────┘ updates
 │  N logical nodes│  │  per-node top-K   │
 │  ring + TTL     │  └─────────┬─────────┘
 └─────────────────┘            │ built at startup from
                                ▼
                       ┌───────────────────┐
                       │ SQLite (queries)  │  ◄── source of truth
                       │  query,count,seen │
                       └───────────────────┘
```

## Components

**SQLite (`db.js`)** - the source of truth. One row per query: `query, count, last_seen`. The only
writer is the batch flush, inside a single transaction. Everything else is a derived, rebuildable
in-memory view.

**Trie (`trie.js`)** - built from the `queries` table at startup. Every node caches the top-K
completions in its subtree, so a suggestion lookup is "walk the prefix characters, return the
precomputed list" - O(prefix length), independent of dataset size. Counts only ever increase, which
is what makes the incremental top-K maintenance cheap and correct (no subtree recompute per search).

**Consistent-hash ring (`consistentHash.js`)** - maps a prefix to one of N cache nodes. Virtual
nodes (150 per physical node) plus a murmur3-style hash finalizer keep the load even and keep
node-add/remove cheap (only ~1/N of keys move). See the [performance report](performance-report.md)
for the measured numbers.

**Distributed cache (`cache.js`)** - N independent logical nodes, each its own `Map`, addressed via
the ring on the normalized prefix. Values are rendered top-10 lists with a TTL. In a real
deployment each node would be a separate Redis process; in-process keeps the demo single-command and
lets us log exactly where each key lands.

**Trending (`trending.js`)** - an exponentially-decaying per-query activity accumulator. The
suggestion score is `log(1 + allTimeCount) + W * decayedRecentWeight`. The recent term decays to
zero on its own (half-life ~10 min), so a short spike can't permanently over-rank a query.

**Batch writer (`batchWriter.js`)** - `POST /search` only enqueues into an in-memory buffer that
aggregates duplicates. A timer (or a size threshold) flushes the buffer in one transaction, then
updates the trie, the trending window, and invalidates the affected cache prefixes.

## Why reads never hit SQLite

After startup, suggestions are answered by the cache or the trie - both in memory. SQLite is touched
only by (a) the one-time load at boot and (b) batched writes. The benchmark confirms this: 20,000
`/suggest` requests produced **1** DB read total. That's the whole point of the trie+cache layer.

## Failure model

The batch buffer and the trie/trending state are in memory. On a crash:

- **Lost**: searches buffered since the last flush (<= flush interval, default 2s) - popularity
  increments only, never user data.
- **Recovered**: on restart the trie is rebuilt from SQLite, which holds every flushed count. The
  cache simply warms up again. Trending recent-activity resets to empty and rebuilds from live
  traffic, which is the correct behaviour for "what's hot right now".

Hardening would mean an append-only log or durable queue before acking a search - at the cost of the
per-request synchronous write the batching exists to avoid. Out of scope for a single-process demo;
discussed in [REQUIREMENTS.md §7](../REQUIREMENTS.md).
