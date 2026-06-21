// Batch writer. Instead of writing to the store on every search, we collect
// the searches in a buffer and add up repeated queries. Every so often (or
// when the buffer gets big) we flush them all to the store in one go. This
// turns many writes into a few writes.
//
// Failure note: the buffer is in memory, so if the program crashes before a
// flush we lose those counts. That is acceptable here because the counts are
// only used for popularity, not money. We flush on shutdown to reduce the loss.

export class BatchWriter {
  constructor(options = {}) {
    this.flushIntervalMs = options.flushIntervalMs || 1000;
    this.maxBufferSize = options.maxBufferSize || 500;
    this.onFlush = options.onFlush || function () {};
    this.store = options.store;

    this.buffer = new Map(); // query -> total delta waiting to be written

    // numbers for the report
    this.enqueued = 0; // total searches received
    this.writesIssued = 0; // total store writes done
    this.flushes = 0;

    this.timer = setInterval(() => this.flush(), this.flushIntervalMs);
    if (this.timer.unref) this.timer.unref();
  }

  // add one search to the buffer (no store write here)
  enqueue(query) {
    this.enqueued++;
    this.buffer.set(query, (this.buffer.get(query) || 0) + 1);
    if (this.buffer.size >= this.maxBufferSize) this.flush();
  }

  // write the whole buffer to the store in one batch
  flush() {
    if (this.buffer.size === 0) return [];
    const batch = this.buffer;
    this.buffer = new Map();
    this.flushes++;

    const applied = [];
    for (const [query, delta] of batch) {
      const newCount = this.store.applyIncrement(query, delta);
      this.writesIssued++;
      applied.push({ query, delta, newCount });
    }
    this.onFlush(applied);
    return applied;
  }

  stats() {
    let reduction = 0;
    if (this.enqueued > 0) {
      reduction = Number((1 - this.writesIssued / this.enqueued).toFixed(4));
    }
    return {
      enqueued: this.enqueued,
      writesIssued: this.writesIssued,
      flushes: this.flushes,
      pendingInBuffer: this.buffer.size,
      writeReduction: reduction,
      flushIntervalMs: this.flushIntervalMs,
      maxBufferSize: this.maxBufferSize,
    };
  }

  stop() {
    clearInterval(this.timer);
    this.flush();
  }
}
