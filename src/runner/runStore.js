'use strict';
const crypto = require('crypto');

// Short-lived in-memory cache of rendered results so paging does not re-run the query.
class RunStore {
  constructor({ ttlMinutes = 15, max = 40 } = {}) {
    this.ttl = ttlMinutes * 60 * 1000;
    this.max = max;
    this.runs = new Map();
    this.timer = setInterval(() => this.sweep(), 60 * 1000);
    this.timer.unref();
  }

  put(entry) {
    const id = crypto.randomBytes(16).toString('hex');
    this.runs.set(id, Object.assign({ at: Date.now() }, entry));
    while (this.runs.size > this.max) this.runs.delete(this.runs.keys().next().value);
    return id;
  }

  get(id, userId) {
    const r = this.runs.get(id);
    if (!r || r.userId !== userId || Date.now() - r.at > this.ttl) return null;
    r.at = Date.now();
    return r;
  }

  sweep() {
    const now = Date.now();
    for (const [k, v] of this.runs) if (now - v.at > this.ttl) this.runs.delete(k);
  }
}

module.exports = { RunStore };
