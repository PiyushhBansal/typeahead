/**
 * Performance benchmark + behavior demonstration. Runs the service in-process
 * (no HTTP overhead) so we measure the system itself.
 *
 * Reports:
 *   - suggest latency p50/p95/p99 (cold vs warm cache)
 *   - cache hit rate
 *   - DB read/write counts and write-reduction from batching
 *   - consistent-hashing key distribution across nodes
 *   - basic vs recency ranking difference (trending demo)
 *
 * Usage: npm run bench
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { performance } from 'node:perf_hooks';
import { TypeaheadService } from '../src/core/TypeaheadService.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA = path.join(__dirname, '..', 'data', 'queries.json');

function pct(arr, p) {
  const s = [...arr].sort((a, b) => a - b);
  return +s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))].toFixed(4);
}
function bar(n, total, width = 28) {
  const filled = Math.round((n / total) * width);
  return '█'.repeat(filled) + '░'.repeat(width - filled);
}
function line(c = '─', n = 60) { return c.repeat(n); }

const entries = JSON.parse(fs.readFileSync(DATA, 'utf8'));
const svc = new TypeaheadService({
  cacheNodes: 4,
  cacheTtlMs: 60_000,
  flushIntervalMs: 100_000, // disable timer; we flush manually for determinism
  maxBufferSize: 10_000_000,
});
svc.load(entries);

console.log(line('═'));
console.log(' SEARCH TYPEAHEAD — PERFORMANCE REPORT');
console.log(line('═'));
console.log(` dataset: ${entries.length.toLocaleString()} distinct queries\n`);

// Build a realistic prefix workload skewed toward popular heads.
const heads = entries.slice(0, 2000).map((e) => e.query);
function randomPrefix() {
  const q = heads[Math.floor(Math.random() * heads.length)];
  const len = 1 + Math.floor(Math.random() * Math.min(5, q.length));
  return q.slice(0, len);
}
const N = 50_000;
const workload = Array.from({ length: N }, randomPrefix);

// ---- Cold pass (caches mostly empty) ----
const cold = [];
for (let i = 0; i < workload.length; i++) {
  const t = performance.now();
  svc.suggest(workload[i], 'recency');
  cold.push(performance.now() - t);
}

// ---- Warm pass (same workload, caches hot) ----
const warm = [];
for (let i = 0; i < workload.length; i++) {
  const t = performance.now();
  svc.suggest(workload[i], 'recency');
  warm.push(performance.now() - t);
}

console.log('1) SUGGEST LATENCY  (' + N.toLocaleString() + ' lookups per pass)');
console.log(line());
console.log(`   cold  p50=${pct(cold, 50)}ms  p95=${pct(cold, 95)}ms  p99=${pct(cold, 99)}ms`);
console.log(`   warm  p50=${pct(warm, 50)}ms  p95=${pct(warm, 95)}ms  p99=${pct(warm, 99)}ms`);

const cacheStats = svc.cache.stats();
console.log('\n2) CACHE');
console.log(line());
console.log(`   hit rate: ${(cacheStats.hitRate * 100).toFixed(1)}%  (${cacheStats.hits.toLocaleString()} hits / ${cacheStats.misses.toLocaleString()} misses)`);
console.log(`   nodes: ${cacheStats.nodeCount}, ttl: ${cacheStats.ttlMs}ms`);

// ---- Consistent-hashing distribution ----
const sampleKeys = entries.slice(0, 20_000).map((e) => `recency:${e.query}`);
const dist = svc.cache.ring.distribution(sampleKeys);
const totalKeys = Object.values(dist).reduce((a, b) => a + b, 0);
console.log('\n3) CONSISTENT-HASHING KEY DISTRIBUTION  (' + totalKeys.toLocaleString() + ' keys)');
console.log(line());
for (const [node, count] of Object.entries(dist)) {
  console.log(`   ${node.padEnd(9)} ${bar(count, totalKeys)} ${((count / totalKeys) * 100).toFixed(1)}%`);
}

// Demonstrate remap stability: add a node, count how many keys move.
const before = {};
for (const k of sampleKeys) before[k] = svc.cache.ring.getNode(k);
svc.cache.addNode('cache-4');
let moved = 0;
for (const k of sampleKeys) if (svc.cache.ring.getNode(k) !== before[k]) moved++;
console.log(`   adding cache-4 remapped ${((moved / sampleKeys.length) * 100).toFixed(1)}% of keys (ideal ≈ ${(100 / 5).toFixed(0)}%)`);

// ---- Batch writes / write reduction ----
console.log('\n4) BATCH WRITES — WRITE REDUCTION');
console.log(line());
const SEARCHES = 100_000;
// Repeated searches over a small hot set — exactly the case batching collapses.
for (let i = 0; i < SEARCHES; i++) svc.search(heads[Math.floor(Math.random() * 200)]);
svc.flushNow('bench');
const b = svc.batch.stats();
console.log(`   search submissions buffered: ${b.enqueued.toLocaleString()}`);
console.log(`   actual DB writes issued:     ${b.writesIssued.toLocaleString()}`);
console.log(`   write reduction:             ${(b.writeReduction * 100).toFixed(1)}%  (vs write-per-search)`);
console.log(`   ${bar(b.writesIssued, b.enqueued)} writes/searches`);

// ---- Trending / ranking difference ----
console.log('\n5) RANKING: basic (all-time) vs recency-aware');
console.log(line());
// Simulate a burst on a normally-mid query under a shared prefix.
const sample = entries.find((e) => e.query.startsWith('samsung ')) || entries[10];
const prefix = sample.query.slice(0, 4);
const burstQuery = svc.trie.suggest(prefix, 30).slice(-1)[0]?.query;
if (burstQuery) {
  for (let i = 0; i < 5000; i++) svc.search(burstQuery);
  svc.flushNow('bench');
  const basic = svc.suggest(prefix, 'basic').suggestions.map((s) => s.query);
  const recency = svc.suggest(prefix, 'recency').suggestions.map((s) => s.query);
  console.log(`   prefix "${prefix}" — bursted query: "${burstQuery}"`);
  console.log(`   basic   top3: ${basic.slice(0, 3).join(' | ')}`);
  console.log(`   recency top3: ${recency.slice(0, 3).join(' | ')}`);
  const rankBasic = basic.indexOf(burstQuery);
  const rankRec = recency.indexOf(burstQuery);
  console.log(`   "${burstQuery}" rank — basic: ${rankBasic === -1 ? '>10' : rankBasic + 1}, recency: ${rankRec === -1 ? '>10' : rankRec + 1}`);
}

console.log('\n6) TRENDING (top by recent velocity)');
console.log(line());
for (const t of svc.trending(5)) console.log(`   ${t.recent.toString().padStart(6)}  ${t.query}`);

console.log('\n7) PRIMARY STORE');
console.log(line());
const st = svc.store.stats();
console.log(`   distinct queries: ${st.distinctQueries.toLocaleString()}`);
console.log(`   total reads: ${st.reads.toLocaleString()}, total writes: ${st.writes.toLocaleString()}`);
console.log('\n' + line('═'));

svc.batch.stop();
process.exit(0);
