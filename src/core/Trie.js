// Trie (prefix tree) to find all queries that start with a given prefix.
// We store the full word at the end node. To get suggestions we go to the
// prefix node and collect every word under it, then sort by count.

class TrieNode {
  constructor() {
    this.children = {}; // character -> TrieNode
    this.isWord = false;
    this.word = null;
  }
}

export class Trie {
  constructor(limit = 10) {
    this.root = new TrieNode();
    this.limit = limit;
    this.counts = {}; // word -> count (kept here so we can sort suggestions)
    this.size = 0;
  }

  // Add a word or update its count.
  upsert(word, count) {
    if (!word) return;
    let node = this.root;
    for (let i = 0; i < word.length; i++) {
      const ch = word[i];
      if (!node.children[ch]) {
        node.children[ch] = new TrieNode();
      }
      node = node.children[ch];
    }
    if (!node.isWord) this.size++;
    node.isWord = true;
    node.word = word;
    this.counts[word] = count;
  }

  // Walk down to the node for the prefix. Returns null if not found.
  findNode(prefix) {
    let node = this.root;
    for (let i = 0; i < prefix.length; i++) {
      const ch = prefix[i];
      if (!node.children[ch]) return null;
      node = node.children[ch];
    }
    return node;
  }

  // Collect all words under a node (depth first search).
  collectWords(node, results) {
    if (node.isWord) {
      results.push(node.word);
    }
    for (const ch in node.children) {
      this.collectWords(node.children[ch], results);
    }
  }

  // Return up to `limit` suggestions for a prefix, sorted by count (high first).
  suggest(prefix, limit = this.limit) {
    const node = this.findNode(prefix);
    if (!node) return [];

    const words = [];
    this.collectWords(node, words);

    // turn words into {query, count} and sort by count descending
    const result = words.map((w) => ({ query: w, count: this.counts[w] || 0 }));
    result.sort((a, b) => b.count - a.count);
    return result.slice(0, limit);
  }
}
