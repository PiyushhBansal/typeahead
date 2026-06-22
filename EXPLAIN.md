# How This Works - Simple Explanation (for the viva)

Read this once and you can explain the whole project in plain English. Each part
also says **WHY** it was built that way, which is what the viva is really checking.

---

## 30-second pitch

> "It's a search autocomplete. As you type, it shows the 10 most popular matching
> queries. Each query is stored with a count. To find matches fast I use a trie
> (prefix tree). To make repeat lookups instant, the finished suggestion lists are
> kept in a cache that is split across 3 cache nodes, and a consistent-hashing
> function decides which node holds which prefix. When you submit a search I don't
> write to the store right away - I collect searches in a buffer and write them in
> batches to cut down writes. Ranking and trending also use a recent-activity
> score from a sliding time window, so a query that was hot for a minute doesn't
> stay on top forever."

That paragraph covers all six things they ask you to explain.

---

## 1. What data I store (data model)

A simple table of `query -> count`. In code it is a `Map`:

```js
this.counts = new Map();   // "iphone" -> 200000
```

**WHY:** A Map gives instant lookup by query and is the simplest "database". The
assignment is about the system design (trie, caching, hashing, batching), not
about which database engine I picked.

---

## 2. How suggestions are found (the trie)

A trie is a tree where each character is a step down. To find everything that
starts with "iph", I walk i -> p -> h, then collect every complete word under
that node, sort by count, and return the top 10.

```js
const node = this.findNode(prefix);   // walk down the tree
this.collectWords(node, words);       // gather everything below it
result.sort((a, b) => b.count - a.count);
return result.slice(0, 10);
```

**WHY a trie:** walking to the prefix is O(length of prefix), not O(120,000). It
goes straight to the matching branch instead of checking every query. (A plain
scan would also work at this size, but the trie is the proper data structure for
prefix search and the cache covers the rest.)

---

## 3. Caching (for speed)

The first time someone types "iph", I compute the top-10 and **save that list in
the cache**. Next time anyone types "iph", I return the saved list instead of
recomputing. Each cached entry expires after 30 seconds (TTL).

- First call: `source: compute` (about 1-2 ms)
- Repeat call: `source: cache` (about 0.04 ms) -> roughly 40x faster.

**WHY:** most people type the same popular prefixes, so caching those answers
makes the common case extremely fast. The TTL means stale data clears itself.

---

## 4. Distributed cache + consistent hashing

Instead of one cache I use **3 cache nodes** (just 3 Maps, pretending to be 3
separate cache servers). A hash decides which node owns a prefix:

```js
const node = nodeForKey(prefix);   // "iph" always goes to the same node
```

I use **consistent hashing**: all nodes are placed on a ring (positions from an
MD5 hash), and each prefix lands on the next node clockwise. Each node also gets
many "virtual nodes" on the ring so the keys spread out evenly.

**WHY consistent hashing (the key point):** if I add or remove a cache node, only
about 1/N of the keys move - not all of them. With plain `hash % 3`, changing the
node count would reshuffle every key and wipe the whole cache. Consistent hashing
avoids that.

You can see it live: `GET /cache/debug?prefix=iph` shows which node owns it and
whether it is a HIT or MISS, and `GET /cache/distribution` shows the spread across
all 3 nodes.

---

## 5. Trending + recency-aware ranking

I keep a list of recent searches, each with a timestamp. Anything older than the
window (5 minutes) is dropped.

- **Trending** = the queries searched most often inside the window right now.
- **Ranking** has two modes on the same `/suggest` API (`mode=basic` or `mode=recency`):
  - `basic` -> sort by all-time count only.
  - `recency` -> `score = log10(1 + count) + weight * recentVelocity`, so a query
    being searched a lot right now gets pushed up.

```js
recentVelocity(query) {
  const cutoff = Date.now() - this.windowMs;
  // count how many recent searches for this query are still inside the window
}
```

**WHY the window:** it stops a query that was popular for only a short burst from
staying on top forever. Once people stop searching it, those searches age out of
the window and the boost disappears, so it drops back to its normal rank. When a
count changes on flush, I clear the affected cached prefixes so the new order
shows up.

**WHY log10 on the count:** all-time counts range from millions down to single
digits. Taking log10 squeezes that range so a realistic burst of recent searches
can actually move the ranking, instead of being buried under the raw count.

**Demo I can show:** I search "iphone 15" several times; under `basic` it is lower
down, but under `recency` it jumps to #1 - then falls back as the window moves on.

---

## 6. Batch writes

When you submit a search I do **not** write to the store right away. I put it in a
buffer. The buffer is flushed (written) either every 1 second **or** once it holds
500 distinct queries, whichever comes first. Repeated queries are merged into one
write before flushing.

```js
buffer.set(query, (buffer.get(query) || 0) + 1);   // collect + merge
// flush(): apply all buffered counts to the store in one batch
```

**WHY:** without batching, every single search = 1 write. With batching, 50
repeated searches became **2 writes** in the demo (about 95% fewer). Fewer writes
= less load on the store.

**The trade-off I must mention:** if the app crashes before a flush, the buffered
searches are lost (at-most-once). That is acceptable here because these are just
popularity counters - being slightly approximate is fine. A durable log or queue
would fix it but adds complexity. On shutdown I flush the buffer to reduce loss.

---

## 7. The APIs

| API | What it does |
|---|---|
| `GET /suggest?q=iph&mode=recency` | top-10 suggestions for a prefix |
| `POST /search {query}` | returns `{"message":"Searched"}` and queues a count update |
| `GET /trending` | most-active queries in the window right now |
| `GET /cache/debug?prefix=iph` | which cache node owns the prefix + HIT/MISS |
| `GET /cache/distribution` | how keys spread across the 3 cache nodes |
| `GET /stats` | cache hit rate, p95 latency, write reduction, DB writes |

---

## 8. Likely viva questions + one-line answers

- **Why a Map and not a real DB?** Simplicity; the focus is the data-system design, and a Map lets me count reads/writes clearly.
- **Why a trie?** Prefix search in O(prefix length) - it jumps to the matching branch instead of scanning all 120k queries.
- **Why consistent hashing?** Adding/removing a cache node only remaps ~1/N keys instead of all of them.
- **What are virtual nodes for?** They place each cache node at many points on the ring so keys spread out evenly.
- **How do you keep the cache fresh?** 30s TTL plus active invalidation: when a count changes on flush, I drop the cached prefixes it affects.
- **How does recency avoid permanent over-ranking?** Recent searches age out of a 5-minute window, so a short burst stops being counted once it is old.
- **What happens if it crashes mid-batch?** Buffered counts are lost (at-most-once); fine for approximate popularity counters.
- **How is it low-latency?** Cache-first: repeat prefixes return in about 0.04 ms; `/stats` reports p95.
- **How does the UI avoid spamming the backend?** The search box is debounced (120 ms) so it only calls `/suggest` after typing pauses.
