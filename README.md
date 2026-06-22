# Search Typeahead System

A search typeahead (autocomplete) system: it suggests popular queries as you
type, records searches, ranks suggestions by popularity **and recency**, serves
reads from a **distributed cache** routed by **consistent hashing**, and reduces
database write pressure with **batched, aggregated writes**.

Everything runs in a single Node.js process with one command. The "distributed
cache" and "database" are modeled in-memory, so there is nothing to install
beyond Express.

---

## Quick start

```bash
npm install            # installs express
npm run gen-data       # builds data/queries.json (120,000 queries) - run once
npm start              # serves the UI + API on http://localhost:3000
```

Open <http://localhost:3000>, start typing (`iph`, `samsung`, `java`), use
up/down to navigate suggestions and Enter to search. The panels on the right show
live trending searches and live metrics (cache hit rate, p95 latency, DB writes,
write reduction).

Run the demo (start the server first, then in another terminal):

```bash
npm run demo           # prints the proof log and saves demo-output.log
```

Optional config via env vars: `PORT` (3000), `CACHE_NODES` (3), `CACHE_TTL_MS`
(30000), `FLUSH_INTERVAL_MS` (1000), `MAX_BUFFER_SIZE` (500).

---

## What's in the project

```
server.js          all backend logic + API in one file (store, trie, cache,
                   consistent hashing, ranking, batching, metrics)
generate-data.js   dataset generator (120,000 queries)
demo.js            runnable proof log
public/            UI: index.html, styles.css, app.js (no build step)
data/queries.json  generated dataset
demo-output.log    saved demo run
screenshots/       UI screenshots
```

## APIs

| API | Purpose |
|---|---|
| `GET /suggest?q=<prefix>&mode=basic\|recency` | up to 10 prefix-matching suggestions |
| `POST /search` `{ "query": "..." }` | returns `{"message":"Searched"}` and queues a batched count update |
| `GET /trending?limit=` | top queries by recent activity |
| `GET /cache/debug?prefix=<p>&mode=` | which cache node owns the prefix, and hit/miss |
| `GET /cache/distribution` | how keys spread across the cache nodes |
| `GET /stats` | cache hit rate, write reduction, latency p50/p95/p99, DB writes |

---

## More docs

- **[REPORT.md](REPORT.md)** - full report: architecture diagram, dataset, API
  docs, design choices and trade-offs, performance table.
- **[EXPLAIN.md](EXPLAIN.md)** - plain-English walkthrough for the viva, with a
  short pitch and likely questions + answers.
- **[demo-output.log](demo-output.log)** - raw measurement log.
- **[screenshots/](screenshots/)** - UI screenshots.
