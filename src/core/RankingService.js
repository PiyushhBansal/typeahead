// Ranking and trending.
//
// Two ways to rank suggestions (both use the same /suggest API):
//   "basic"   -> just sort by all-time count.
//   "recency" -> mix all-time count with how many times the query was searched
//                recently, so things that are popular right now get a boost.
//
// For recency we keep a list of recent searches with their time. Anything
// older than the window (default 5 minutes) is ignored, so old popularity
// fades away on its own and a short spike does not stay on top forever.

export class RankingService {
  constructor(options = {}) {
    this.windowMs = options.windowMs || 5 * 60 * 1000; // 5 minutes
    this.recencyWeight = options.recencyWeight || 2.0;
    this.recent = []; // list of { query, time }
  }

  // record one search
  recordSearch(query) {
    this.recent.push({ query, time: Date.now() });
    this.cleanup();
  }

  // drop searches that are older than the window
  cleanup() {
    const cutoff = Date.now() - this.windowMs;
    // keep only recent ones
    this.recent = this.recent.filter((r) => r.time >= cutoff);
  }

  // how many times this query was searched inside the window
  recentVelocity(query) {
    const cutoff = Date.now() - this.windowMs;
    let count = 0;
    for (const r of this.recent) {
      if (r.time >= cutoff && r.query === query) count++;
    }
    return count;
  }

  // score for recency mode
  score(query, allTimeCount) {
    // log10 keeps the huge counts from completely hiding the recent boost
    const base = Math.log10(1 + allTimeCount);
    return base + this.recencyWeight * this.recentVelocity(query);
  }

  // rank a list of {query, count}. mode is "basic" or "recency".
  rank(candidates, mode = 'recency', limit = 10) {
    if (mode === 'basic') {
      const copy = candidates.slice();
      copy.sort((a, b) => b.count - a.count);
      return copy.slice(0, limit);
    }

    const scored = candidates.map((c) => ({
      query: c.query,
      count: c.count,
      recent: this.recentVelocity(c.query),
      score: this.score(c.query, c.count),
    }));
    scored.sort((a, b) => b.score - a.score);
    return scored.slice(0, limit);
  }

  // top trending queries = most searched in the window
  trending(limit = 10) {
    this.cleanup();
    const counts = {};
    for (const r of this.recent) {
      counts[r.query] = (counts[r.query] || 0) + 1;
    }
    const list = Object.keys(counts).map((q) => ({ query: q, recent: counts[q] }));
    list.sort((a, b) => b.recent - a.recent);
    return list.slice(0, limit);
  }

  stats() {
    return {
      windowMs: this.windowMs,
      recencyWeight: this.recencyWeight,
      recentSearches: this.recent.length,
    };
  }
}
