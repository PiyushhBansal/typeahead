// This service ties everything together.
//
// suggest(prefix): first check the cache. If it is there (hit) return it.
// If not (miss), build the suggestions from the trie + ranking, then put them
// in the cache so next time is fast.
//
// search(query): record it for trending and put a count update in the batch
// writer. We do NOT write to the store right away.

import { Trie } from './Trie.js';
import { PrimaryStore } from './PrimaryStore.js';
import { DistributedCache } from './DistributedCache.js';
import { RankingService } from './RankingService.js';
import { BatchWriter } from './BatchWriter.js';

export class TypeaheadService {
  constructor(config = {}) {
    this.config = config;
    this.limit = config.suggestionLimit || 10;

    this.store = new PrimaryStore();
    this.trie = new Trie(this.limit);
    this.cache = new DistributedCache({
      nodeCount: config.cacheNodes || 3,
      ttlMs: config.cacheTtlMs || 30000,
      vnodes: config.vnodes || 100,
    });
    this.ranking = new RankingService({
      windowMs: config.windowMs,
      recencyWeight: config.recencyWeight,
    });
    this.batch = new BatchWriter({
      flushIntervalMs: config.flushIntervalMs || 1000,
      maxBufferSize: config.maxBufferSize || 500,
      store: this.store,
      onFlush: (applied) => this.onBatchFlush(applied),
    });

    this.invalidations = 0;
  }

  // load the dataset into the store and the trie
  load(entries) {
    this.store.load(entries);
    for (const e of entries) {
      this.trie.upsert(e.query, e.count);
    }
  }

  // make a cache key from the mode and prefix
  cacheKey(prefix, mode) {
    return mode + ':' + prefix;
  }

  // clean up the user's input: trim spaces and lowercase
  normalize(prefix) {
    if (typeof prefix !== 'string') return '';
    return prefix.trim().toLowerCase();
  }

  // get suggestions for a prefix
  suggest(rawPrefix, mode = 'recency') {
    const prefix = this.normalize(rawPrefix);
    if (prefix === '') {
      return { suggestions: [], source: 'empty', node: null, mode };
    }

    const key = this.cacheKey(prefix, mode);
    const node = this.cache.routeOf(key);

    // 1. check the cache
    const cached = this.cache.get(key);
    if (cached !== undefined) {
      return { suggestions: cached, source: 'cache', node, mode };
    }

    // 2. cache miss - build from trie + ranking
    const candidates = this.trie.suggest(prefix, this.limit * 3);
    const ranked = this.ranking.rank(candidates, mode, this.limit);
    const result = ranked.map((s) => ({ query: s.query, count: s.count }));

    // 3. save in cache for next time
    this.cache.set(key, result);
    return { suggestions: result, source: 'compute', node, mode };
  }

  // user submitted a search
  search(rawQuery) {
    const query = this.normalize(rawQuery);
    if (query === '') {
      return { message: 'Searched', query: '', accepted: false };
    }
    this.ranking.recordSearch(query); // for trending / recency
    this.batch.enqueue(query); // batched count update (no direct store write)
    return { message: 'Searched', query, accepted: true };
  }

  // called when the batch writer flushes updates to the store
  onBatchFlush(applied) {
    for (const item of applied) {
      // update the count in the trie so suggestions show the new number
      this.trie.upsert(item.query, item.newCount);
      // remove old cached suggestions for this query's prefixes so the next
      // read rebuilds them with the new count
      for (let i = 1; i <= item.query.length; i++) {
        const p = item.query.slice(0, i);
        if (this.cache.invalidate(this.cacheKey(p, 'basic'))) this.invalidations++;
        if (this.cache.invalidate(this.cacheKey(p, 'recency'))) this.invalidations++;
      }
    }
  }

  trending(limit = 10) {
    return this.ranking.trending(limit);
  }

  // debug: where does a prefix go and is it cached?
  cacheDebug(rawPrefix, mode = 'recency') {
    const prefix = this.normalize(rawPrefix);
    const key = this.cacheKey(prefix, mode);
    const node = this.cache.routeOf(key);
    const value = this.cache.get(key);
    return {
      prefix,
      mode,
      key,
      node,
      status: value === undefined ? 'miss' : 'hit',
      cachedCount: value === undefined ? 0 : value.length,
    };
  }

  stats() {
    return {
      store: this.store.stats(),
      cache: this.cache.stats(),
      batch: this.batch.stats(),
      ranking: this.ranking.stats(),
      trie: { distinctQueries: this.trie.size },
      invalidations: this.invalidations,
    };
  }

  flushNow() {
    return this.batch.flush();
  }
}
