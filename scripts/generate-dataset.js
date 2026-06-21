/**
 * Generate a synthetic search-query dataset (>= 100,000 distinct queries).
 *
 * Each query gets a count drawn from a Zipf-like distribution: a few head
 * queries have very high counts and a long tail has small counts — which is
 * how real search traffic looks and makes the ranking/caching behavior
 * meaningful.
 *
 * Output: data/queries.json  as [{ "query": "...", "count": N }, ...]
 *
 * Deterministic (seeded PRNG) so the dataset is reproducible.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.join(__dirname, '..', 'data', 'queries.json');
const TARGET = Number(process.env.TARGET) || 120_000;

// Seeded PRNG (mulberry32) so runs are reproducible.
function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const rand = mulberry32(42);
const pick = (arr) => arr[Math.floor(rand() * arr.length)];

const brands = [
  'iphone', 'samsung', 'galaxy', 'pixel', 'oneplus', 'xiaomi', 'redmi', 'oppo',
  'vivo', 'realme', 'motorola', 'nokia', 'sony', 'lg', 'huawei', 'asus', 'acer',
  'dell', 'hp', 'lenovo', 'msi', 'apple', 'macbook', 'ipad', 'kindle', 'bose',
  'jbl', 'logitech', 'razer', 'corsair', 'nvidia', 'amd', 'intel', 'canon',
  'nikon', 'gopro', 'dji', 'fitbit', 'garmin', 'nintendo', 'playstation', 'xbox',
];
const products = [
  'phone', 'laptop', 'tablet', 'headphones', 'earbuds', 'charger', 'cable',
  'case', 'cover', 'screen protector', 'smartwatch', 'monitor', 'keyboard',
  'mouse', 'webcam', 'speaker', 'router', 'ssd', 'hard drive', 'graphics card',
  'processor', 'ram', 'power bank', 'adapter', 'camera', 'lens', 'tripod',
  'drone', 'console', 'controller', 'tv', 'soundbar', 'projector',
];
const modifiers = [
  'pro', 'max', 'ultra', 'plus', 'mini', 'lite', 'air', 'se', '2024', '2025',
  '128gb', '256gb', '512gb', '1tb', 'wireless', 'bluetooth', 'usb c', '4k',
  'gaming', 'budget', 'best', 'cheap', 'review', 'price', 'deals', 'refurbished',
];
const topics = [
  'java tutorial', 'python tutorial', 'javascript', 'react', 'node js',
  'system design', 'data structures', 'algorithms', 'machine learning',
  'docker', 'kubernetes', 'aws', 'sql', 'mongodb', 'redis', 'graphql',
  'rust', 'golang', 'typescript', 'leetcode', 'interview questions',
  'recipe', 'weather', 'news', 'movies', 'music', 'flights', 'hotels',
  'restaurants near me', 'stock price', 'bitcoin', 'football scores',
];

function zipfCount(rank) {
  // count ~ 1/rank^s scaled. s ~0.9 gives a realistic head/tail spread.
  const s = 0.9;
  const base = 200_000;
  return Math.max(1, Math.round(base / Math.pow(rank + 1, s)));
}

function main() {
  const seen = new Set();
  const queries = [];

  // Seed with a few "famous" head queries so the head looks realistic.
  const seeds = [
    'iphone', 'iphone 15', 'iphone charger', 'java tutorial', 'python tutorial',
    'samsung galaxy', 'macbook pro', 'best laptop 2025', 'wireless earbuds',
    'system design interview',
  ];
  for (const q of seeds) {
    if (!seen.has(q)) {
      seen.add(q);
      queries.push(q);
    }
  }

  // Combinatorial generation: brand + product (+ modifier), and topics (+ modifier).
  while (queries.length < TARGET) {
    let q;
    const r = rand();
    if (r < 0.55) {
      q = `${pick(brands)} ${pick(products)}`;
      if (rand() < 0.6) q += ` ${pick(modifiers)}`;
      if (rand() < 0.25) q += ` ${pick(modifiers)}`;
    } else if (r < 0.8) {
      q = pick(topics);
      if (rand() < 0.5) q += ` ${pick(modifiers)}`;
    } else {
      // brand + modifier only
      q = `${pick(brands)} ${pick(modifiers)}`;
    }
    q = q.replace(/\s+/g, ' ').trim().toLowerCase();
    if (!seen.has(q)) {
      seen.add(q);
      queries.push(q);
    }
  }

  // Shuffle then assign Zipf counts by rank (so head isn't only the seeds).
  // Light shuffle: keep seeds near the top, randomize the rest's ranks.
  for (let i = queries.length - 1; i > seeds.length; i--) {
    const j = seeds.length + Math.floor(rand() * (i - seeds.length + 1));
    [queries[i], queries[j]] = [queries[j], queries[i]];
  }

  const dataset = queries.map((query, rank) => ({ query, count: zipfCount(rank) }));

  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, JSON.stringify(dataset));
  const totalCount = dataset.reduce((a, d) => a + d.count, 0);
  console.log(`[gen] wrote ${dataset.length.toLocaleString()} queries to ${OUT}`);
  console.log(`[gen] total summed count = ${totalCount.toLocaleString()}`);
  console.log(`[gen] sample head:`, dataset.slice(0, 5));
}

main();
