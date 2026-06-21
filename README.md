# Search Typeahead System

A search typeahead (autocomplete) system: suggests popular queries as the user
types, records searches, ranks suggestions by popularity **and recency**, serves
reads from a **distributed cache** routed by **consistent hashing**, and reduces
database write pressure with **batched, aggregated writes**.

Everything runs in a single Node.js process with **one command** — the
"distributed cache" and "database" are modeled as in-memory components so there
is nothing to install beyond `npm install`. The distribution, TTL expiry,
consistent-hash routing, batch flushing, and recency windowing are all real and
observable through the API and logs.

---

## 1. Quick start

```bash
npm install            # install express
npm run gen-data       # generate data/queries.json  (120,000 queries)
npm start              # serve UI + API on http://localhost:3000
```

Open <http://localhost:3000>, start typing (`iph`, `samsung`, `java`…), use
↑/↓ to navigate suggestions and Enter to search. The right-hand panels show
**live trending searches** and **live metrics** (cache hit rate, p95 latency,
DB reads/writes, write reduction).

Run the performance report any time:

```bash
npm run bench
```

Configuration via env vars (all optional):

| Var | Default | Meaning |
|---|---|---|
| `PORT` | `3000` | HTTP port |
| `CACHE_NODES` | `3` | number of logical cache nodes |
| `CACHE_TTL_MS` | `30000` | cache entry TTL |
| `FLUSH_INTERVAL_MS` | `1000` | batch flush cadence |
| `MAX_BUFFER_SIZE` | `500` | flush early at this many buffered distinct queries |

---

## 2. Architecture

```
                ┌──────────────────────────────────────────────────────┐
   Browser UF   │                  TypeaheadService                     │
 ┌───────────┐  │                                                       │
 │ search box│  │  suggest(prefix, mode)                                │
 │ dropdown  │──┼──▶ 1. cache key = "{mode}:{prefix}"                   │
 │ trending  │  │     2. DistributedCache.get(key)  ── consistent hash ─┼─▶ cache-0
 │ metrics   │  │            HIT ─▶ return                              │   cache-1
 └───────────┘  │            MISS ▼                                     │   cache-2 (TTL)
       │        │     3. Trie.suggest(prefix)  -> candidates            │
   debounced    │     4. RankingService.rank(candidates, mode)         │
   GET /suggest │     5. cache.set(key, result)                         │
       │        │                                                       │
   POST /search │  search(query)                                        │
       └────────┼──▶ RankingService.recordSearch(query)  (recency window)
                │     BatchWriter.enqueue(query)  ── buffered, aggregated┼─▶ PrimaryStore
                │            └ periodic / size-triggered flush ──────────┤   (DB, counts)
                │               onFlush: Trie.upsert + cache.invalidate  │
                └──────────────────────────────────────────────────────┘
```

| Component | File | Responsibility |
|---|---|---|
| **Trie** | `src/core/Trie.js` | Prefix → candidate queries. Each node caches its top-K by count for O(prefix) suggestion. |
| **ConsistentHashRing** | `src/core/ConsistentHashRing.js` | Hash ring with virtual nodes; maps a prefix key → owning cache node. |
| **DistributedCache** | `src/core/DistributedCache.js` | N logical cache nodes, per-entry TTL, routed by the ring. Hit/miss stats. |
| **PrimaryStore** | `src/core/PrimaryStore.js` | Source-of-truth counts (simulated DB) + read/write counters. |
| **RankingService** | `src/core/RankingService.js` | Basic (count) vs recency-aware ranking; sliding-window trending. |
| **BatchWriter** | `src/core/BatchWriter.js` | Buffers + aggregates search increments; periodic/size flush. |
| **TypeaheadService** | `src/core/TypeaheadService.js` | Orchestrates the read/write flow above. |
| **server.js** | `src/server.js` | Express API + static UI + latency tracking. |

---

## 3. API

| API | Purpose | Behavior |
|---|---|---|
| `GET /suggest?q=<prefix>&mode=basic\|recency` | Fetch suggestions | Up to 10 prefix-matching suggestions, sorted by the selected ranking. Returns `source` (cache/compute), owning `node`, and `latencyMs`. |
| `POST /search` `{ "query": "..." }` | Submit a search | Returns `{ "message": "Searched", ... }`. Records the search and **enqueues** a batched count update (no synchronous DB write). |
| `GET /trending?limit=` | Trending searches | Top queries by recent velocity in the sliding window. |
| `GET /cache/debug?prefix=<p>&mode=` | Debug cache routing | Which cache node owns the prefix key, and whether it is a hit or miss. |
| `GET /stats` | Metrics | Cache hit rate, DB reads/writes, write reduction, latency p50/p95/p99, per-node cache stats. |
| `GET /cache/distribution` | Consistent-hashing spread | Key count per node over a dataset sample. |
| `POST /admin/flush` | Force a batch flush | Useful for demos. |

The **same `/suggest` API** serves both ranking modes (`mode` query param), as
required: `basic` = all-time count order, `recency` = recency-aware order.

---

## 4. Design choices & trade-offs

### Suggestions — Trie with cached top-K
A trie gives O(prefix length) navigation to the candidate set. Storing a cached
top-K list on each node means a suggestion read is O(prefix + K) instead of
walking the whole subtree. **Trade-off:** writes (count updates) cost O(L·K) to
refresh the caches along the path — acceptable because writes are batched and
far rarer than reads.

### Caching — read-through, distributed, TTL
- Suggestion **results** (not raw counts) are cached, keyed by `{mode}:{prefix}`,
  so a hit returns the final ranked list with zero compute.
- The cache is split across **N logical nodes**; **consistent hashing** with
  virtual nodes decides ownership. Adding/removing a node remaps only ~1/N of
  keys (measured ≈21.5% when going 4→5 nodes; ideal 20%).
- Each entry has a **TTL** (expiry) plus a periodic active sweep, so stale
  suggestions never live forever.
- On a batched count update, affected prefix keys are **invalidated** so the next
  read recomputes with fresh ranking. **Trade-off:** invalidation is per-prefix
  of the changed query (bounded by query length) rather than global — cheap, and
  TTL backstops anything missed.

### Trending / recency — sliding window of time buckets
Recent searches are counted in fixed 30s buckets over a 5-minute window (a ring
buffer). Old buckets are dropped as time advances, so a query's "recent velocity"
**decays automatically** — a spike that ends stops contributing once it ages out
of the window. This is what prevents a briefly-popular query from
**permanently** over-ranking.

Ranking score (recency mode):

```
score = log10(1 + allTimeCount) + RECENCY_WEIGHT * recentVelocity
```

`log10` compresses the huge head/tail spread of all-time counts so a realistic
recent burst can actually move the ranking instead of being buried under
millions of historical hits. `RECENCY_WEIGHT` (default 2.0) tunes the
freshness↔stability trade-off. Demonstrated in `npm run bench` §5: a bursted
query moves from basic rank 4 → recency rank 1, then falls back as its bucket
ages out. Cache entries for affected prefixes are invalidated on flush and via
TTL so rankings stay current.

### Batch writes — buffer + aggregate + flush
Search submissions are buffered in memory and **aggregated by query** (repeated
queries collapse into one increment). The buffer flushes periodically
(`FLUSH_INTERVAL_MS`) or when it reaches `MAX_BUFFER_SIZE` distinct queries. In
the benchmark, **100,000 searches over a hot set become 200 DB writes — a 99.8%
write reduction.**

**Failure trade-off:** the buffer is in memory, so a crash before a flush loses
the unflushed increments — counts undercount slightly but never corrupt. This is
an acceptable trade for a popularity counter (we favor read latency + write
reduction over perfect durability). A production system would make the buffer
durable (append to a WAL or Kafka) before acknowledging so a crash can replay;
on shutdown (`SIGINT`/`SIGTERM`) we flush the buffer to minimize loss.

---

## 5. Performance report (from `npm run bench`, 120k-query dataset)

| Metric | Result |
|---|---|
| Suggest latency (warm) | p50 ≈ 0.002ms, **p95 ≈ 0.002ms**, p99 ≈ 0.004ms |
| Suggest latency (cold) | p50 ≈ 0.002ms, p95 ≈ 0.003ms, p99 ≈ 0.006ms |
| Cache hit rate | **99.7%** on a repeated workload |
| Consistent hashing (4 nodes) | 22.9% / 23.7% / 24.7% / 28.6% per node |
| Remap on adding a 5th node | **21.5%** of keys moved (ideal ≈ 20%) |
| Write reduction (batching) | **99.8%** (100,000 searches → 200 writes) |
| Recency ranking | bursted query: basic rank 4 → **recency rank 1** |

(Latencies are in-process, excluding HTTP; the `/stats` endpoint reports live
HTTP-path latency while the server runs.)

---

## 6. Dataset

`npm run gen-data` writes `data/queries.json` as `[{ "query": "...", "count": N }]`
— 120,000 distinct queries with **Zipf-distributed** counts (realistic
head/tail). The generator is seeded, so the dataset is reproducible. To use a
different size: `TARGET=200000 npm run gen-data`.

To use a **real** open dataset instead, convert it to the same JSON shape
(`[{query, count}]` or `{query: count}`) and drop it at `data/queries.json` —
the server accepts both shapes.

---

## 7. Project layout

```
src/
  core/            data structures + services (one responsibility each)
  server.js        Express API + static hosting
public/            UI (index.html, styles.css, app.js) — no build step
scripts/
  generate-dataset.js
  benchmark.js
data/queries.json  generated dataset
```

---

## 8. Mapping to the assignment requirements

- **10 suggestions, prefix match, count-sorted, graceful empty/no-match** — `/suggest`, Trie + RankingService.
- **UI with debounced typing, dropdown, keyboard nav, trending, response display, loading/error states** — `public/`.
- **Dummy search API returning "Searched"** — `POST /search`.
- **Query-count store + cache before primary store** — PrimaryStore + read-through DistributedCache.
- **Distributed cache, consistent hashing, TTL/invalidation** — DistributedCache + ConsistentHashRing.
- **Trending + recency-aware ranking (same suggest API)** — RankingService, `mode=recency`.
- **Batch writes, aggregation, periodic/size flush, failure discussion** — BatchWriter (see §4).
- **`/cache/debug` routing endpoint, consistent-hashing logs** — `/cache/debug`, `/cache/distribution`, `npm run bench` §3.
- **Latency (incl. p95), cache hit rate, read/write counts** — `/stats`, `npm run bench`.
# typeahead
