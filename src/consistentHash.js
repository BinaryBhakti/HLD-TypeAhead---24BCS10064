'use strict';

// Consistent-hash ring with virtual nodes.
//
// Why this and not `hash(key) % N`: with modulo, changing N remaps almost every
// key. On the ring, adding/removing one node only moves the keys that sat between
// the new/removed node and its predecessor — about 1/N of them. Virtual nodes
// (many ring positions per physical node) keep the load even; with one position
// each, a 3-node ring splits traffic very unequally. See REQUIREMENTS §5.

// FNV-1a (32-bit) for the byte mixing, followed by a murmur3-style finalizer.
// The finalizer matters: FNV alone has weak avalanche, so "cache-1#0", "cache-1#1", …
// hash to nearby ring positions — all of a node's virtual nodes clump together and
// the ring stops balancing. The finalizer scatters them, which is the whole point of
// having virtual nodes. (Verified: 100k keys land ~33/33/33 across 3 nodes.)
function fnv1a(str) {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  // murmur3 finalizer
  h ^= h >>> 16;
  h = Math.imul(h, 0x85ebca6b);
  h ^= h >>> 13;
  h = Math.imul(h, 0xc2b2ae35);
  h ^= h >>> 16;
  return h >>> 0; // unsigned
}

class ConsistentHashRing {
  constructor(nodeIds, vnodes = 150) {
    this.vnodes = vnodes;
    this.ring = [];        // sorted array of { hash, nodeId }
    this.nodeIds = new Set();
    for (const id of nodeIds) this.addNode(id, /*resort*/ false);
    this._sort();
  }

  _sort() {
    this.ring.sort((a, b) => a.hash - b.hash);
  }

  addNode(nodeId, resort = true) {
    if (this.nodeIds.has(nodeId)) return;
    this.nodeIds.add(nodeId);
    for (let v = 0; v < this.vnodes; v++) {
      this.ring.push({ hash: fnv1a(`${nodeId}#${v}`), nodeId });
    }
    if (resort) this._sort();
  }

  removeNode(nodeId) {
    if (!this.nodeIds.has(nodeId)) return;
    this.nodeIds.delete(nodeId);
    this.ring = this.ring.filter((e) => e.nodeId !== nodeId);
  }

  // First vnode clockwise from the key's hash; wrap to the first vnode at the end.
  getNode(key) {
    if (this.ring.length === 0) return null;
    const h = fnv1a(key);
    let lo = 0;
    let hi = this.ring.length - 1;
    if (h > this.ring[hi].hash) return this.ring[0].nodeId; // wrap around
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (this.ring[mid].hash < h) lo = mid + 1;
      else hi = mid;
    }
    return this.ring[lo].nodeId;
  }

  nodes() {
    return [...this.nodeIds];
  }
}

module.exports = { ConsistentHashRing, fnv1a };
