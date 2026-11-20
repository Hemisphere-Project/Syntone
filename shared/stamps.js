// Syntone sender — capture stamps.
//
// Every frame leaves the sender with the relay time at which its first sample was captured
// (plan §2–3). The raw material is one observation per captured block:
//
//   (n, t)   n = samples captured so far,  t = relay time when the block reached us (µs)
//
// `t` is late by the capture path's buffering plus however late the callback ran. That lateness is
// never negative, and most of it is jitter: stamping each frame with its own observation would hand
// every receiver that jitter. So the stamps come from a line through the EARLIEST observations (the
// lower envelope: one minimum per bin) over a sliding window:
//
//   relayUs(n) = t at the envelope, extended at the sender's REAL sample rate
//
// Its slope is the sender's sound card measured in relay time, so stamps advance at the rate the
// audio actually runs; receivers absorb that in their own drift follower. The constant part of the
// lateness (input latency) stays in the stamps: it is measured once per sender and declared as part
// of D (plan §2).
//
// Stamps must not jump when the fit moves, or every receiver hears the jump: the emitted stamps
// follow the fit through a slew bounded in ppm. Only a gap larger than `stepMs` is a jump: the
// capture lost samples, the sender slept, or its clock estimate stepped.
//
// Pure (no I/O, no clock reads): the sender page feeds it, Node tests drive it.

export const DEFAULTS = {
  rate: 48000,          // nominal sample rate of the capture
  binMs: 1000,          // one envelope point (the earliest observation) per bin of this much audio
  windowMs: 60_000,     // bins older than this are forgotten
  minBins: 5,           // fewer complete bins than this: offset only, nominal rate
  minSpanMs: 5_000,     // and they must span this long before a rate is trusted
  maxRatePpm: 1000,     // a sound card off by more than this is a fit gone wrong: nominal rate
  slewPpm: 50,          // emitted stamps converge on the fit at most this fast (50 ppm = 1 ms in 20 s)
  stepMs: 50,           // a complete bin this far from the fit…
  stepBins: 2,          // …this many bins in a row: the timeline stepped, forget what came before
}

export class CaptureStamper {
  constructor(opts = {}) {
    this.o = { ...DEFAULTS, ...opts }
    this.usPerSample = 1e6 / this.o.rate
    this.reset()
  }

  reset() {
    this.bins = []        // complete bins { k, n, x }: k = bin number, x = t − n·usPerSample (lateness at nominal rate)
    this.open = null      // the bin still filling
    this.slope = 0        // last fitted rate (µs per sample beyond nominal); 0 until one is measured
    this.fit = null       // { nRef, xRef, slope } — x(n) = xRef + slope·(n − nRef), slope in µs per sample
    this.last = null      // last emitted stamp { n, t }
    this.lastN = -Infinity
    this.steps = 0        // timeline steps detected
    this.jumps = 0        // emitted stamps that jumped instead of slewing
    this._odd = 0         // consecutive complete bins that contradict the fit
  }

  /** One captured block: `n` samples so far, at relay time `relayUs`. False if refused. */
  observe(n, relayUs) {
    if (!Number.isFinite(n) || !Number.isFinite(relayUs) || n < this.lastN) return false
    this.lastN = n
    const x = relayUs - n * this.usPerSample
    const k = Math.floor(n / (this.o.rate * this.o.binMs / 1000))   // by sample count: relay time jitters, n never goes back
    if (this.open && k !== this.open.k) this._close()
    if (!this.open) this.open = { k, n, x }
    else if (x < this.open.x) { this.open.n = n; this.open.x = x }
    if (!this.bins.length) this._refit()   // warm-up: the first bin's minimum so far is the offset
    return true
  }

  _close() {
    const b = this.open
    this.open = null
    if (this.fit && Math.abs(b.x - this._x(b.n)) > this.o.stepMs * 1000) {
      if (++this._odd >= this.o.stepBins) {
        // keep only the contradicting bins: they are the new timeline
        this.bins = this.bins.slice(this.bins.length - (this.o.stepBins - 1))
        this._odd = 0
        this.steps++
      }
    } else this._odd = 0
    this.bins.push(b)
    const horizon = b.k - Math.ceil(this.o.windowMs / this.o.binMs)
    while (this.bins.length && this.bins[0].k <= horizon) this.bins.shift()
    this._refit()
  }

  _refit() {
    const pts = this.bins.length ? this.bins : this.open ? [this.open] : []
    if (!pts.length) { this.fit = null; return }
    const recent = this._odd ? pts.slice(0, pts.length - this._odd) : pts   // never fit on a suspected step
    const use = recent.length ? recent : pts
    const spanMs = (use[use.length - 1].k - use[0].k) * this.o.binMs
    if (use.length >= this.o.minBins && spanMs >= this.o.minSpanMs) {
      let sn = 0, sx = 0
      for (const p of use) { sn += p.n; sx += p.x }
      const nRef = sn / use.length, xRef = sx / use.length
      let snn = 0, snx = 0
      for (const p of use) { snn += (p.n - nRef) ** 2; snx += (p.n - nRef) * (p.x - xRef) }
      const slope = snn > 0 ? snx / snn : 0
      if (Math.abs(this._ppm(slope)) <= this.o.maxRatePpm) {
        this.slope = slope                 // kept across a step: losing samples does not change the card's rate
        this.fit = { nRef, xRef, slope }
        return
      }
    }
    // Too little to fit a rate: anchor on the newest envelope point, at the last known rate
    const p = use[use.length - 1]
    this.fit = { nRef: p.n, xRef: p.x, slope: this.slope }
  }

  _x(n) { const f = this.fit; return f.xRef + f.slope * (n - f.nRef) }

  // slope = extra µs per sample: a positive slope is a sender running SLOW
  _ppm(slope) { return -slope / (this.usPerSample + slope) * 1e6 }

  /** True once there is something to stamp with. */
  get ready() { return this.fit !== null }

  /** The fitted line at sample `n` (relay µs), without the slew: what the stamps converge on. */
  lineAt(n) { return this.fit ? n * this.usPerSample + this._x(n) : null }

  /**
   * The capture stamp of sample `n` (relay µs) — the first sample of a frame. Call it in frame
   * order: each stamp continues the previous one at the fitted rate, corrected toward the line by
   * at most `slewPpm` of the time elapsed.
   */
  stampOf(n) {
    if (!this.fit) return null
    const target = this.lineAt(n)
    const l = this.last
    let t
    if (!this.bins.length) t = target            // warm-up, first bin still filling: follow its minimum freely
    else if (!l || n <= l.n) { t = target; if (l) this.jumps++ }
    else {
      const dn = n - l.n
      const pred = l.t + dn * (this.usPerSample + this.fit.slope)
      const d = target - pred
      const max = this.o.slewPpm * 1e-6 * dn * this.usPerSample
      if (Math.abs(d) > this.o.stepMs * 1000) { t = target; this.jumps++ }
      else t = pred + Math.max(-max, Math.min(max, d))
    }
    this.last = { n, t }
    return t
  }

  /** What the sender page shows and logs. */
  get stats() {
    const f = this.fit
    return {
      ready: !!f,
      bins: this.bins.length,
      ratePpm: f ? this._ppm(f.slope) : 0,          // sender's sound card vs nominal: + = runs fast
      steps: this.steps,
      jumps: this.jumps,
    }
  }
}
