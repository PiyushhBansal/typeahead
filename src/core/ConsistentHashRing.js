// Consistent hashing ring.
// We place each cache node at several points on a circle (0 to 2^32). To find
// which node owns a key, we hash the key and walk clockwise to the first node
// point we meet. Using several points per node ("virtual nodes") spreads the
// keys more evenly and means adding/removing a node only moves about 1/N keys.

import { createHash } from 'node:crypto';

export class ConsistentHashRing {
  constructor(nodes = [], vnodes = 100) {
    this.vnodes = vnodes;
    this.points = []; // list of { hash, node } sorted by hash
    this.nodes = [];
    for (const n of nodes) this.addNode(n);
  }

  // Hash a string to a number using md5.
  hash(key) {
    const hex = createHash('md5').update(key).digest('hex');
    return parseInt(hex.slice(0, 8), 16); // use first 8 hex chars
  }

  addNode(node) {
    if (this.nodes.includes(node)) return;
    this.nodes.push(node);
    for (let i = 0; i < this.vnodes; i++) {
      this.points.push({ hash: this.hash(node + '#' + i), node });
    }
    this.points.sort((a, b) => a.hash - b.hash);
  }

  removeNode(node) {
    this.nodes = this.nodes.filter((n) => n !== node);
    this.points = this.points.filter((p) => p.node !== node);
  }

  // Find the node responsible for a key.
  getNode(key) {
    if (this.points.length === 0) return null;
    const h = this.hash(key);
    // walk clockwise to the first point with hash >= h
    for (let i = 0; i < this.points.length; i++) {
      if (this.points[i].hash >= h) return this.points[i].node;
    }
    // wrap around to the start of the circle
    return this.points[0].node;
  }

  // Count how many sample keys land on each node (for the report).
  distribution(keys) {
    const counts = {};
    for (const n of this.nodes) counts[n] = 0;
    for (const k of keys) {
      const node = this.getNode(k);
      if (node) counts[node]++;
    }
    return counts;
  }
}
