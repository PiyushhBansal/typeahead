// demo.js - prints a log proving the main behaviours of the system.
// Start the server first (npm start), then run: npm run demo
// The output is printed and also saved to demo-output.log.
//
// It shows the four things the assignment asks to demonstrate with logs:
//   1. cache hit speedup (low latency)
//   2. consistent-hashing routing (which node owns which prefix)
//   3. basic vs recency-aware ranking
//   4. batch writes reducing the number of db writes

import fs from 'node:fs';

const BASE = 'http://localhost:' + (process.env.PORT || 3000);
const lines = [];
function log(s = '') {
  console.log(s);
  lines.push(s);
}

const get = (path) => fetch(BASE + path).then((r) => r.json());
const post = (query) =>
  fetch(BASE + '/search', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ query }),
  }).then((r) => r.json());
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  log('============================================================');
  log('SEARCH TYPEAHEAD - DEMO LOG');
  log('============================================================');

  log('\n[1] CACHE HIT SPEEDUP');
  const cold = await get('/suggest?q=laptop&mode=basic');
  const warm = await get('/suggest?q=laptop&mode=basic');
  log('  1st call -> source: ' + cold.source + '   latency: ' + cold.latencyMs + ' ms');
  log('  2nd call -> source: ' + warm.source + '   latency: ' + warm.latencyMs + ' ms');
  const speed = Math.round(cold.latencyMs / Math.max(warm.latencyMs, 0.001));
  log('  speedup  -> about ' + speed + 'x faster from cache');

  log('\n[2] CONSISTENT HASHING (prefix -> owner cache node)');
  for (const p of ['iphone', 'samsung', 'laptop', 'java', 'python', 'tv']) {
    const d = await get('/cache/debug?prefix=' + p);
    log('  ' + p.padEnd(8) + ' -> ' + d.node + '  (' + d.status + ')');
  }

  log('\n[3] BASIC vs RECENCY RANKING for prefix "iphone"');
  log('    (searching "iphone 15" several times so it is recently active)');
  for (let i = 0; i < 8; i++) await post('iphone 15');
  await sleep(1500); // let the batch flush
  const basic = await get('/suggest?q=iphone&mode=basic');
  const recency = await get('/suggest?q=iphone&mode=recency');
  log('  BASIC   top 5: ' + basic.suggestions.slice(0, 5).map((s) => s.query).join(', '));
  log('  RECENCY top 5: ' + recency.suggestions.slice(0, 5).map((s) => s.query).join(', '));
  log('  -> "iphone 15" jumps up under recency, then fades as its recent score drops.');

  log('\n[4] BATCH WRITES REDUCE DB WRITES');
  const before = await get('/stats');
  log('  submitting 50 searches (many repeated)...');
  for (let i = 0; i < 50; i++) await post(i % 2 === 0 ? 'laptop' : 'headphones');
  await sleep(1500); // let the batch flush
  const after = await get('/stats');
  const submitted = after.batch.enqueued - before.batch.enqueued;
  const writes = after.store.writes - before.store.writes;
  log('  searches submitted : ' + submitted);
  log('  actual db writes   : ' + writes);
  log('  write reduction    : ' + (after.batch.writeReduction * 100).toFixed(1) + '%');

  log('\n[STATS SNAPSHOT]');
  log('  cache hit rate : ' + (after.cache.hitRate * 100).toFixed(1) + '%');
  log('  latency p50/p95/p99 : ' + after.latency.p50 + '/' + after.latency.p95 + '/' + after.latency.p99 + ' ms');
  log('  total db writes : ' + after.store.writes);
  log('============================================================');

  fs.writeFileSync('demo-output.log', lines.join('\n') + '\n');
  log('\nSaved to demo-output.log');
}

main().catch((e) => {
  log('ERROR: is the server running? (npm start)');
  log(String(e));
  process.exit(1);
});
