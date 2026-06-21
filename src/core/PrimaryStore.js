// Primary data store - this stands in for the database. It keeps the all-time
// count for every query. We also count how many reads and writes happen so we
// can show that batching reduces the number of writes.

export class PrimaryStore {
  constructor() {
    this.counts = new Map(); // query -> count
    this.reads = 0;
    this.writes = 0;
  }

  // load the dataset (not counted as app writes)
  load(entries) {
    for (const e of entries) {
      this.counts.set(e.query, e.count);
    }
  }

  getCount(query) {
    this.reads++;
    return this.counts.get(query) || 0;
  }

  // add `delta` to a query's count. This is the only write during normal use
  // and it is called by the batch writer, not on every search.
  applyIncrement(query, delta) {
    this.writes++;
    const newCount = (this.counts.get(query) || 0) + delta;
    this.counts.set(query, newCount);
    return newCount;
  }

  size() {
    return this.counts.size;
  }

  stats() {
    return {
      distinctQueries: this.counts.size,
      reads: this.reads,
      writes: this.writes,
    };
  }
}
