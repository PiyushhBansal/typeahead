// Distributed cache made of several cache nodes. Each node is just a Map that
// stores suggestion results with an expiry time (TTL). We use the consistent
// hash ring to decide which node a prefix key belongs to, so the same key
// always goes to the same node.

import { ConsistentHashRing } from './ConsistentHashRing.js';

export class DistributedCache {
  constructor(options = {}) {
    this.nodeCount = options.nodeCount || 3;
    this.ttlMs = options.ttlMs || 30000;

    // each node: { id, data: Map(key -> {value, expiresAt}), hits, misses }
    this.nodes = {};
    const ids = [];
    for (let i = 0; i < this.nodeCount; i++) {
      const id = 'cache-' + i;
      this.nodes[id] = { id, data: new Map(), hits: 0, misses: 0 };
      ids.push(id);
    }

    this.ring = new ConsistentHashRing(ids, options.vnodes || 100);

    // every so often, remove expired entries from all nodes
    this.timer = setInterval(() => this.removeExpired(), this.ttlMs);
    if (this.timer.unref) this.timer.unref();
  }

  // which node owns this key
  routeOf(key) {
    return this.ring.getNode(key);
  }

  nodeFor(key) {
    return this.nodes[this.routeOf(key)];
  }

  get(key) {
    const node = this.nodeFor(key);
    if (!node) return undefined;

    const entry = node.data.get(key);
    if (!entry) {
      node.misses++;
      return undefined;
    }
    if (entry.expiresAt <= Date.now()) {
      // expired, delete it and treat as a miss
      node.data.delete(key);
      node.misses++;
      return undefined;
    }
    node.hits++;
    return entry.value;
  }

  set(key, value) {
    const node = this.nodeFor(key);
    if (!node) return;
    node.data.set(key, { value, expiresAt: Date.now() + this.ttlMs });
  }

  // remove a single key (used when its data changed and is now stale)
  invalidate(key) {
    const node = this.nodeFor(key);
    if (!node) return false;
    return node.data.delete(key);
  }

  removeExpired() {
    const now = Date.now();
    for (const id in this.nodes) {
      const node = this.nodes[id];
      for (const [key, entry] of node.data) {
        if (entry.expiresAt <= now) node.data.delete(key);
      }
    }
  }

  addNode(id) {
    if (this.nodes[id]) return;
    this.nodes[id] = { id, data: new Map(), hits: 0, misses: 0 };
    this.ring.addNode(id);
  }

  removeNode(id) {
    if (!this.nodes[id]) return;
    delete this.nodes[id];
    this.ring.removeNode(id);
  }

  stats() {
    let hits = 0;
    let misses = 0;
    const perNode = {};
    for (const id in this.nodes) {
      const node = this.nodes[id];
      hits += node.hits;
      misses += node.misses;
      perNode[id] = { keys: node.data.size, hits: node.hits, misses: node.misses };
    }
    const total = hits + misses;
    return {
      nodeCount: Object.keys(this.nodes).length,
      ttlMs: this.ttlMs,
      hits,
      misses,
      hitRate: total === 0 ? 0 : Number((hits / total).toFixed(4)),
      perNode,
    };
  }
}
