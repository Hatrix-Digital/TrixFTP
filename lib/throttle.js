'use strict';
// Throttle - Transform stream that limits throughput (bytes/sec).
// Used for speed limiting of transfers. bps <= 0 means unlimited.
const { Transform } = require('stream');

class Throttle extends Transform {
  constructor(bps) {
    super({ highWaterMark: 64 * 1024 });
    this.bps = Math.max(0, Number(bps) || 0);
    this.noLimit = this.bps <= 0;
  }
  _transform(chunk, enc, cb) {
    if (this.noLimit) return cb(null, chunk);
    if (chunk.length === 0) return cb(null, chunk);
    // Delay proportional to chunk length; cap so small chunks don't accumulate latency.
    const delay = Math.min((chunk.length / this.bps) * 1000, 400);
    setTimeout(() => cb(null, chunk), delay);
  }
}

module.exports = { Throttle };
