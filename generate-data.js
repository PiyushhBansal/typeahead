import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.join(__dirname, 'data', 'queries.json');
const TARGET = Number(process.env.TARGET) || 120000;

function rand() {
  return Math.random();
}
function pick(arr) {
  return arr[Math.floor(rand() * arr.length)];
}

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

// popular queries have big counts, rare ones small (zipf-like)
function countForRank(rank) {
  const base = 200000;
  return Math.max(1, Math.round(base / Math.pow(rank + 1, 0.9)));
}

const seen = new Set();
const queries = [];

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

while (queries.length < TARGET) {
  let q;
  const r = rand();
  if (r < 0.55) {
    q = pick(brands) + ' ' + pick(products);
    if (rand() < 0.6) q += ' ' + pick(modifiers);
    if (rand() < 0.25) q += ' ' + pick(modifiers);
  } else if (r < 0.8) {
    q = pick(topics);
    if (rand() < 0.5) q += ' ' + pick(modifiers);
  } else {
    q = pick(brands) + ' ' + pick(modifiers);
  }
  q = q.replace(/\s+/g, ' ').trim().toLowerCase();
  if (!seen.has(q)) {
    seen.add(q);
    queries.push(q);
  }
}

// shuffle the non-seed queries so counts are not in generation order
for (let i = queries.length - 1; i > seeds.length; i--) {
  const j = seeds.length + Math.floor(rand() * (i - seeds.length + 1));
  const tmp = queries[i];
  queries[i] = queries[j];
  queries[j] = tmp;
}

const dataset = queries.map((query, rank) => ({ query, count: countForRank(rank) }));

fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, JSON.stringify(dataset));
console.log('wrote ' + dataset.length + ' queries to ' + OUT);
console.log('sample:', dataset.slice(0, 5));
