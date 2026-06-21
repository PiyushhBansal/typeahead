/**
 * HTTP server exposing the typeahead APIs and serving the UI.
 *
 * Endpoints
 *   GET  /suggest?q=<prefix>&mode=basic|recency   -> suggestions
 *   POST /search   { query }                       -> { message: "Searched" }
 *   GET  /trending?limit=                          -> trending searches
 *   GET  /cache/debug?prefix=<p>&mode=             -> routing + hit/miss
 *   GET  /stats                                    -> cache hit rate, writes, etc.
 *   POST /admin/flush                              -> force a batch flush (demo)
 *
 * Latency is measured per /suggest request and aggregated for p95 reporting.
 */

import express from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';
import { performance } from 'node:perf_hooks';
import { TypeaheadService } from './core/TypeaheadService.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const DATA_FILE = path.join(ROOT, 'data', 'queries.json');
const PORT = process.env.PORT || 3000;

// ---- Latency tracking for /suggest (for the perf report) ----
const latencies = []; // ms samples (capped ring)
const MAX_SAMPLES = 50_000;
function recordLatency(ms) {
  if (latencies.length >= MAX_SAMPLES) latencies.shift();
  latencies.push(ms);
}
function percentile(arr, p) {
  if (arr.length === 0) return 0;
  const sorted = [...arr].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length));
  return +sorted[idx].toFixed(3);
}

// ---- Load dataset ----
function loadDataset() {
  if (!fs.existsSync(DATA_FILE)) {
    console.error(
      `\n[fatal] dataset not found at ${DATA_FILE}\n` +
        `        run \`npm run gen-data\` first to generate it.\n`
    );
    process.exit(1);
  }
  const raw = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
  // Accept either [{query,count}] or {query:count}.
  const entries = Array.isArray(raw)
    ? raw
    : Object.entries(raw).map(([query, count]) => ({ query, count }));
  return entries;
}

const entries = loadDataset();
const service = new TypeaheadService({
  cacheNodes: Number(process.env.CACHE_NODES) || 3,
  cacheTtlMs: Number(process.env.CACHE_TTL_MS) || 30_000,
  flushIntervalMs: Number(process.env.FLUSH_INTERVAL_MS) || 1000,
  maxBufferSize: Number(process.env.MAX_BUFFER_SIZE) || 500,
});
service.load(entries);
console.log(`[init] loaded ${entries.length.toLocaleString()} queries into store + trie`);

const app = express();
app.use(express.json());
app.use(express.static(path.join(ROOT, 'public')));

// GET /suggest?q=<prefix>&mode=basic|recency
app.get('/suggest', (req, res) => {
  const q = req.query.q ?? '';
  const mode = req.query.mode === 'basic' ? 'basic' : 'recency';
  const t0 = performance.now();
  const result = service.suggest(q, mode);
  const took = performance.now() - t0;
  recordLatency(took);
  res.json({
    prefix: q,
    mode,
    source: result.source, // 'cache' | 'compute' | 'empty'
    node: result.node, // cache node that owns this prefix
    latencyMs: +took.toFixed(3),
    suggestions: result.suggestions,
  });
});

// POST /search  { query }
app.post('/search', (req, res) => {
  const query = req.body?.query ?? req.query.query ?? '';
  const result = service.search(query);
  res.json(result); // { message: "Searched", query, accepted }
});

// GET /trending?limit=
app.get('/trending', (req, res) => {
  const limit = Math.min(50, Number(req.query.limit) || 8);
  res.json({ trending: service.trending(limit) });
});

// GET /cache/debug?prefix=<p>&mode=
app.get('/cache/debug', (req, res) => {
  const prefix = req.query.prefix ?? '';
  const mode = req.query.mode === 'basic' ? 'basic' : 'recency';
  res.json(service.cacheDebug(prefix, mode));
});

// GET /stats — cache hit rate, db read/write counts, write reduction, latency
app.get('/stats', (req, res) => {
  const s = service.stats();
  res.json({
    ...s,
    latency: {
      samples: latencies.length,
      p50: percentile(latencies, 50),
      p95: percentile(latencies, 95),
      p99: percentile(latencies, 99),
      max: latencies.length ? +Math.max(...latencies).toFixed(3) : 0,
    },
  });
});

// POST /admin/flush — force a batch flush (handy for demos)
app.post('/admin/flush', (req, res) => {
  const applied = service.flushNow('admin');
  res.json({ flushed: applied.length });
});

// GET /cache/distribution — show consistent-hashing spread across nodes
app.get('/cache/distribution', (req, res) => {
  const sample = [];
  for (const { query } of entries.slice(0, 5000)) sample.push(`recency:${query}`);
  res.json(service.cache.ring.distribution(sample));
});

const server = app.listen(PORT, () => {
  console.log(`[ready] http://localhost:${PORT}`);
});

// Flush the batch buffer on shutdown so we don't lose buffered counts.
function shutdown() {
  console.log('\n[shutdown] flushing batch buffer...');
  service.batch.stop();
  server.close(() => process.exit(0));
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
