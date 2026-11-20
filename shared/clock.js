// Syntone clock sync — the estimator.
//
// Isomorphic (browser, Node, and simple enough to port to an ESP32): no I/O in here.
// The caller sends pings and feeds the four timestamps of each exchange to `addSample`.
//
//   t0  client send      (client clock, ms)
//   t1  server receive   (server clock, ms)
//   t2  server send      (server clock, ms)
//   t3  client receive   (client clock, ms)
//
//   rtt    = (t3 - t0) - (t2 - t1)          time spent on the network, both ways
//   offset = ((t1 - t0) + (t2 - t3)) / 2    server clock minus client clock, IF both ways took equally long
//
// A single exchange is wrong by up to rtt/2 when the path is asymmetric or one leg queued.
// So the estimator keeps a sliding window and trusts only the exchanges with the smallest rtt
// (a packet that was not queued either way), then fits a line through them:
//
//   serverTime(clientTime) = clientTime + offset0 + skew * (clientTime - tRef)
//
// `skew` is the rate difference between the two clocks (crystal drift, tens of ppm), which is
// what lets the estimate stay right between pings.

export const DEFAULTS = {
  windowMs: 120_000,   // samples older than this are forgotten
  maxSamples: 240,     // hard cap on the window
  keepRatio: 0.3,      // fit on this fraction of the window: the lowest-rtt samples
  minForSkew: 8,       // fewer selected samples than this: no skew, offset only
  minSpanMs: 15_000,   // selected samples must span this long before a skew is trusted
  maxSkewPpm: 500,     // a fitted skew beyond this is a fit gone wrong, not a crystal
}

export class ClockSync {
  constructor(opts = {}) {
    this.o = { ...DEFAULTS, ...opts }
    this.samples = []            // { t: client time at mid-exchange, offset, rtt }
    this.fit = null              // { tRef, offset0, skew, n, minRtt, spanMs }
  }

  /** Feed one ping/pong exchange. Returns the sample, or null if the timestamps are impossible. */
  addSample(t0, t1, t2, t3) {
    const rtt = (t3 - t0) - (t2 - t1)
    if (!(rtt >= 0) || !Number.isFinite(rtt)) return null
    const s = { t: (t0 + t3) / 2, offset: ((t1 - t0) + (t2 - t3)) / 2, rtt }
    this.samples.push(s)
    const horizon = s.t - this.o.windowMs
    while (this.samples.length > this.o.maxSamples || this.samples[0].t < horizon) this.samples.shift()
    this._refit()
    return s
  }

  _refit() {
    const all = this.samples
    if (!all.length) { this.fit = null; return }
    const keep = Math.max(1, Math.ceil(all.length * this.o.keepRatio))
    const best = [...all].sort((a, b) => a.rtt - b.rtt).slice(0, keep)
    const minRtt = best[0].rtt
    let tMin = Infinity, tMax = -Infinity
    for (const s of best) { if (s.t < tMin) tMin = s.t; if (s.t > tMax) tMax = s.t }
    const spanMs = tMax - tMin

    // Weighted least squares, weight = 1 / (rtt/2 + 0.5 ms)^2 : a tighter exchange counts more.
    let sw = 0, st = 0, so = 0
    for (const s of best) { const w = 1 / (s.rtt / 2 + 0.5) ** 2; sw += w; st += w * s.t; so += w * s.offset }
    const tRef = st / sw, oMean = so / sw
    let skew = 0
    if (best.length >= this.o.minForSkew && spanMs >= this.o.minSpanMs) {
      let stt = 0, sto = 0
      for (const s of best) { const w = 1 / (s.rtt / 2 + 0.5) ** 2; const dt = s.t - tRef; stt += w * dt * dt; sto += w * dt * (s.offset - oMean) }
      if (stt > 0) skew = sto / stt
      if (Math.abs(skew) * 1e6 > this.o.maxSkewPpm) skew = 0
    }
    this.fit = { tRef, offset0: oMean, skew, n: best.length, minRtt, spanMs }
  }

  /** True once at least one exchange has been accepted. */
  get ready() { return this.fit !== null }

  /** Server clock minus client clock, in ms, at client time `tClient`. */
  offsetAt(tClient) {
    const f = this.fit
    if (!f) return 0
    return f.offset0 + f.skew * (tClient - f.tRef)
  }

  toServer(tClient) { return tClient + this.offsetAt(tClient) }

  toClient(tServer) {
    const f = this.fit
    if (!f) return tServer
    // invert tServer = t + offset0 + skew * (t - tRef)
    return (tServer - f.offset0 + f.skew * f.tRef) / (1 + f.skew)
  }

  /** What the UI shows. `boundMs` is the honest worst case: half the best round trip. */
  get stats() {
    const f = this.fit
    if (!f) return { ready: false, samples: 0 }
    return {
      ready: true,
      samples: this.samples.length,
      used: f.n,
      offsetMs: f.offset0,
      skewPpm: f.skew * 1e6,
      minRttMs: f.minRtt,
      boundMs: f.minRtt / 2,
      spanMs: f.spanMs,
    }
  }
}
