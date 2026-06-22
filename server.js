// server.js - Search Typeahead System (everything in one file).
//
// Pieces (all in-process, no external services):
//   * Primary store      -> a Map (treated as "the database"); we count writes.
//   * Trie               -> prefix tree to find queries that start with a prefix.
//   * Distributed cache  -> N in-memory cache nodes chosen by CONSISTENT HASHING.
//   * Batch writes       -> search submissions buffer + aggregate, flush periodically.
//   * Trending + recency -> recent-activity over a sliding time window.
//   * Metrics            -> cache hit rate, write reduction, suggest latency p50/p95/p99.

import express from 'express';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { performance } from 'node:perf_hooks';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------
const PORT = process.env.PORT || 3000;
const DATA_FILE = path.join(__dirname, 'data', 'queries.json');
const MAX_SUGGESTIONS = 10;
const CACHE_NODE_COUNT = Number(process.env.CACHE_NODES) || 3;
const CACHE_TTL_MS = Number(process.env.CACHE_TTL_MS) || 30000;
const VNODES_PER_NODE = 100;
const FLUSH_INTERVAL_MS = Number(process.env.FLUSH_INTERVAL_MS) || 1000;
const MAX_BUFFER_SIZE = Number(process.env.MAX_BUFFER_SIZE) || 500;
const WINDOW_MS = 5 * 60 * 1000; // recency / trending window
const RECENCY_WEIGHT = 2.0;

// ---------------------------------------------------------------------------
// 1) PRIMARY STORE (this is our "database")
// ---------------------------------------------------------------------------
const store = new Map(); // query -> count
let dbReads = 0;
let dbWrites = 0;

// ---------------------------------------------------------------------------
// 2) TRIE (prefix tree for suggestions)
// ---------------------------------------------------------------------------
function makeNode() {
  return { children: {}, isWord: false, word: null };
}
const trieRoot = makeNode();
const trieCounts = {}; // word -> count
let trieSize = 0;

function trieUpsert(word, count) {
  if (!word) return;
  let node = trieRoot;
  for (let i = 0; i < word.length; i++) {
    const ch = word[i];
    if (!node.children[ch]) node.children[ch] = makeNode();
    node = node.children[ch];
  }
  if (!node.isWord) trieSize++;
  node.isWord = true;
  node.word = word;
  trieCounts[word] = count;
}

function trieFindNode(prefix) {
  let node = trieRoot;
  for (let i = 0; i < prefix.length; i++) {
    const ch = prefix[i];
    if (!node.children[ch]) return null;
    node = node.children[ch];
  }
  return node;
}

function trieCollect(node, results) {
  if (node.isWord) results.push(node.word);
  for (const ch in node.children) trieCollect(node.children[ch], results);
}

function trieSuggest(prefix, limit) {
  const node = trieFindNode(prefix);
  if (!node) return [];
  const words = [];
  trieCollect(node, words);
  const result = words.map((w) => ({ query: w, count: trieCounts[w] || 0 }));
  result.sort((a, b) => b.count - a.count);
  return result.slice(0, limit);
}

// ---------------------------------------------------------------------------
// 3) CONSISTENT HASHING + DISTRIBUTED CACHE
// ---------------------------------------------------------------------------
function hash(key) {
  const hex = createHash('md5').update(key).digest('hex');
  return parseInt(hex.slice(0, 8), 16);
}

// Each cache node is its own Map -> simulates a separate cache server.
const cacheNodes = {};
const cacheIds = [];
for (let i = 0; i < CACHE_NODE_COUNT; i++) {
  const id = 'cache-' + i;
  cacheNodes[id] = { id, data: new Map(), hits: 0, misses: 0 };
  cacheIds.push(id);
}

// Build the hash ring: sorted [{ hash, node }] with virtual nodes.
let ring = [];
function buildRing() {
  ring = [];
  for (const id of cacheIds) {
    for (let v = 0; v < VNODES_PER_NODE; v++) {
      ring.push({ hash: hash(id + '#' + v), node: id });
    }
  }
  ring.sort((a, b) => a.hash - b.hash);
}

function nodeForKey(key) {
  if (ring.length === 0) return null;
  const h = hash(key);
  for (let i = 0; i < ring.length; i++) {
    if (ring[i].hash >= h) return ring[i].node;
  }
  return ring[0].node; // wrap around the ring
}

function cacheKey(prefix, mode) {
  return mode + ':' + prefix;
}

function cacheGet(prefix, mode) {
  const id = nodeForKey(cacheKey(prefix, mode));
  const node = cacheNodes[id];
  const entry = node.data.get(cacheKey(prefix, mode));
  if (entry && entry.expires > Date.now()) {
    node.hits++;
    return entry.suggestions;
  }
  if (entry) node.data.delete(cacheKey(prefix, mode)); // expired
  node.misses++;
  return undefined;
}

function cacheSet(prefix, mode, suggestions) {
  const id = nodeForKey(cacheKey(prefix, mode));
  cacheNodes[id].data.set(cacheKey(prefix, mode), {
    suggestions,
    expires: Date.now() + CACHE_TTL_MS,
  });
}

function cacheInvalidate(key) {
  const id = nodeForKey(key);
  return cacheNodes[id].data.delete(key);
}

// remove expired entries from all nodes once in a while
setInterval(() => {
  const now = Date.now();
  for (const id in cacheNodes) {
    for (const [k, entry] of cacheNodes[id].data) {
      if (entry.expires <= now) cacheNodes[id].data.delete(k);
    }
  }
}, CACHE_TTL_MS).unref();

// ---------------------------------------------------------------------------
// 4) TRENDING + RECENCY-AWARE RANKING
// ---------------------------------------------------------------------------
let recent = []; // list of { query, time }

function recordSearch(query) {
  recent.push({ query, time: Date.now() });
  if (recent.length % 1000 === 0) cleanupRecent();
}

function cleanupRecent() {
  const cutoff = Date.now() - WINDOW_MS;
  recent = recent.filter((r) => r.time >= cutoff);
}

function recentVelocity(query) {
  const cutoff = Date.now() - WINDOW_MS;
  let count = 0;
  for (const r of recent) {
    if (r.time >= cutoff && r.query === query) count++;
  }
  return count;
}

function rank(candidates, mode, limit) {
  if (mode === 'basic') {
    return candidates.slice().sort((a, b) => b.count - a.count).slice(0, limit);
  }
  const scored = candidates.map((c) => ({
    query: c.query,
    count: c.count,
    score: Math.log10(1 + c.count) + RECENCY_WEIGHT * recentVelocity(c.query),
  }));
  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, limit).map((s) => ({ query: s.query, count: s.count }));
}

function trending(limit) {
  cleanupRecent();
  const counts = {};
  for (const r of recent) counts[r.query] = (counts[r.query] || 0) + 1;
  const list = Object.keys(counts).map((q) => ({ query: q, recent: counts[q] }));
  list.sort((a, b) => b.recent - a.recent);
  return list.slice(0, limit);
}

// ---------------------------------------------------------------------------
// 5) BATCH WRITES
// ---------------------------------------------------------------------------
let buffer = new Map(); // query -> pending count delta
let searchesReceived = 0;
let writesIssued = 0;
let flushCount = 0;

function enqueueSearch(query) {
  searchesReceived++;
  buffer.set(query, (buffer.get(query) || 0) + 1);
  if (buffer.size >= MAX_BUFFER_SIZE) flush();
}

function flush() {
  if (buffer.size === 0) return;
  const batch = buffer;
  buffer = new Map();
  flushCount++;
  for (const [query, delta] of batch) {
    const newCount = (store.get(query) || 0) + delta;
    store.set(query, newCount); // write to primary store
    dbWrites++;
    writesIssued++;
    trieUpsert(query, newCount); // keep suggestions up to date
    // invalidate cached prefixes this query affects, so rankings refresh
    for (let i = 1; i <= query.length; i++) {
      const p = query.slice(0, i);
      cacheInvalidate(cacheKey(p, 'basic'));
      cacheInvalidate(cacheKey(p, 'recency'));
    }
  }
}
const flushTimer = setInterval(flush, FLUSH_INTERVAL_MS);
flushTimer.unref();

// ---------------------------------------------------------------------------
// 6) METRICS (latency)
// ---------------------------------------------------------------------------
const latencies = [];
function recordLatency(ms) {
  latencies.push(ms);
  if (latencies.length > 50000) latencies.shift();
}
function percentile(arr, p) {
  if (!arr.length) return 0;
  const s = [...arr].sort((a, b) => a - b);
  return Number(s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))].toFixed(3));
}

// ---------------------------------------------------------------------------
// Load dataset
// ---------------------------------------------------------------------------
function loadDataset() {
  if (!fs.existsSync(DATA_FILE)) {
    console.error('dataset not found at ' + DATA_FILE);
    console.error('run `npm run gen-data` first to generate it.');
    process.exit(1);
  }
  const raw = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
  const rows = Array.isArray(raw)
    ? raw
    : Object.entries(raw).map(([query, count]) => ({ query, count }));
  for (const { query, count } of rows) {
    store.set(query, count);
    trieUpsert(query, count);
  }
  console.log('loaded ' + store.size + ' queries into store + trie');
}

// ---------------------------------------------------------------------------
// API
// ---------------------------------------------------------------------------
const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// GET /suggest?q=<prefix>&mode=basic|recency
app.get('/suggest', (req, res) => {
  const start = performance.now();
  const mode = req.query.mode === 'basic' ? 'basic' : 'recency';
  const prefix = (req.query.q || '').toString().trim().toLowerCase();

  if (!prefix) {
    recordLatency(performance.now() - start);
    return res.json({ prefix: '', mode, source: 'empty', node: null, latencyMs: 0, suggestions: [] });
  }

  const node = nodeForKey(cacheKey(prefix, mode));
  let suggestions = cacheGet(prefix, mode);
  let source;
  if (suggestions !== undefined) {
    source = 'cache';
  } else {
    const candidates = trieSuggest(prefix, MAX_SUGGESTIONS * 3);
    suggestions = rank(candidates, mode, MAX_SUGGESTIONS);
    cacheSet(prefix, mode, suggestions);
    source = 'compute';
  }

  const took = performance.now() - start;
  recordLatency(took);
  res.json({ prefix, mode, source, node, latencyMs: Number(took.toFixed(3)), suggestions });
});

// POST /search { query } -> dummy response + queue the count update (batched)
app.post('/search', (req, res) => {
  const query = ((req.body && req.body.query) || req.query.query || '').toString().trim().toLowerCase();
  if (!query) return res.json({ message: 'Searched', query: '', accepted: false });
  recordSearch(query);
  enqueueSearch(query);
  res.json({ message: 'Searched', query, accepted: true });
});

// GET /trending?limit=
app.get('/trending', (req, res) => {
  const limit = Math.min(50, Number(req.query.limit) || 8);
  res.json({ trending: trending(limit) });
});

// GET /cache/debug?prefix=<p>&mode=
app.get('/cache/debug', (req, res) => {
  const mode = req.query.mode === 'basic' ? 'basic' : 'recency';
  const prefix = (req.query.prefix || '').toString().trim().toLowerCase();
  const key = cacheKey(prefix, mode);
  const node = nodeForKey(key);
  const entry = cacheNodes[node].data.get(key);
  const hit = !!(entry && entry.expires > Date.now());
  res.json({
    prefix,
    mode,
    key,
    node,
    status: hit ? 'hit' : 'miss',
    cachedCount: hit ? entry.suggestions.length : 0,
  });
});

// GET /stats -> performance numbers
app.get('/stats', (req, res) => {
  let hits = 0;
  let misses = 0;
  const perNode = {};
  for (const id in cacheNodes) {
    hits += cacheNodes[id].hits;
    misses += cacheNodes[id].misses;
    perNode[id] = { keys: cacheNodes[id].data.size, hits: cacheNodes[id].hits, misses: cacheNodes[id].misses };
  }
  const total = hits + misses;
  const writeReduction = searchesReceived ? 1 - writesIssued / searchesReceived : 0;
  res.json({
    cache: {
      hits,
      misses,
      hitRate: total ? Number((hits / total).toFixed(4)) : 0,
      nodeCount: cacheIds.length,
      perNode,
    },
    batch: {
      enqueued: searchesReceived,
      writesIssued,
      flushes: flushCount,
      pendingInBuffer: buffer.size,
      writeReduction: Number(writeReduction.toFixed(4)),
    },
    store: { distinctQueries: store.size, reads: dbReads, writes: dbWrites },
    latency: {
      samples: latencies.length,
      p50: percentile(latencies, 50),
      p95: percentile(latencies, 95),
      p99: percentile(latencies, 99),
    },
  });
});

// POST /admin/flush -> force a batch flush (handy for demos)
app.post('/admin/flush', (req, res) => {
  const before = writesIssued;
  flush();
  res.json({ flushed: writesIssued - before });
});

// GET /cache/distribution -> how keys spread across the nodes
app.get('/cache/distribution', (req, res) => {
  const counts = {};
  for (const id of cacheIds) counts[id] = 0;
  let i = 0;
  for (const query of store.keys()) {
    if (i++ >= 5000) break;
    counts[nodeForKey(cacheKey(query, 'recency'))]++;
  }
  res.json(counts);
});

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------
loadDataset();
buildRing();
const server = app.listen(PORT, () => {
  console.log('server running on http://localhost:' + PORT);
  console.log('cache nodes: ' + cacheIds.join(', ') + ' (consistent hashing)');
});

function shutdown() {
  console.log('shutting down, flushing buffer...');
  flush();
  server.close(() => process.exit(0));
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
