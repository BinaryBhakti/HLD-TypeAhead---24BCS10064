# API Reference

Base URL: `http://localhost:3000`

---

### `GET /suggest?q=<prefix>`

Up to 10 prefix-matching suggestions, ranked by all-time count (or recency-aware score when
`RANK_MODE=trending`, the default).

Query params:
- `q` - the typed prefix. Empty/missing returns the trending list instead of an error.

Behaviour: normalized (trimmed, whitespace-collapsed, lowercased), so `JaVa` and `java` are the
same. Unknown prefix -> empty `suggestions`, HTTP 200.

```bash
curl "http://localhost:3000/suggest?q=ip"
```
```json
{
  "prefix": "ip",
  "suggestions": [
    { "query": "iphone", "count": 100000, "score": 11.51 },
    { "query": "iphone 15", "count": 85000, "score": 11.35 }
  ],
  "cached": false,
  "nodeId": "cache-1",
  "source": "trie"
}
```
- `score` is present only in trending mode.
- `cached` - whether this came from the cache. `nodeId` - the cache node that owns this prefix.
- `source` - `cache` | `trie` | `trending` (the last for empty `q`).

---

### `POST /search`

Records a search and returns the dummy response. Does **not** write to the database synchronously -
the query is buffered for the next batch flush.

Body: `{ "query": "<text>" }`. Missing/blank query -> HTTP 400.

```bash
curl -X POST http://localhost:3000/search \
  -H "Content-Type: application/json" \
  -d '{"query":"ipl 2024"}'
```
```json
{ "message": "Searched" }
```

The count update becomes visible in `/suggest` and `/trending` after the next flush (<= 2s by default).

---

### `GET /trending?limit=<n>`

Current trending queries, ordered by decayed recent activity. Falls back to all-time top queries
when nothing has been searched yet, so the panel is never empty.

```bash
curl "http://localhost:3000/trending"
```
```json
{
  "trending": [
    { "query": "ipl 2024", "count": 47041, "recentWeight": 40.85 }
  ],
  "rankMode": "trending"
}
```

---

### `GET /cache/debug?prefix=<prefix>`

Which cache node owns a prefix, and whether it's currently cached. Demonstrates consistent-hash
routing.

```bash
curl "http://localhost:3000/cache/debug?prefix=ip"
```
```json
{ "prefix": "ip", "node": "cache-1", "hit": true, "ttlRemainingMs": 29759 }
```
This call does **not** count as a hit/miss (it peeks), so it won't skew `/stats`.

---

### `GET /stats`

Live counters for the performance report.

```bash
curl "http://localhost:3000/stats"
```
```json
{
  "rankMode": "trending",
  "dataset": { "queries": 149803 },
  "cache": {
    "backend": "redis",
    "nodes": 3,
    "hits": 19972,
    "misses": 28,
    "hitRate": 0.9986,
    "keysPerNode": { "cache-0": 3, "cache-1": 20, "cache-2": 6 }
  },
  "db": { "reads": 1, "writes": 2 },
  "batch": {
    "enqueued": 41,
    "rowsWritten": 2,
    "flushes": 2,
    "bufferDepth": 0,
    "writeReduction": 20.5
  }
}
```
- `writeReduction` = raw searches enqueued ÷ rows actually written to SQLite.

---

### `GET /health`

```json
{ "ok": true }
```
