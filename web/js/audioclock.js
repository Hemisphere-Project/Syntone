// Syntone audio clock — when will a sample scheduled at AudioContext time `c` actually be HEARD,
// on the performance.now() timeline?  This mapping is the weak link of browser sync: the network
// clock can be right to a millisecond while the device still plays 5–300 ms late, because of the
// OS mixer, the audio driver buffer and, worst, a Bluetooth link.
//
// Three ways to build the mapping, selectable so each phone can be MEASURED with each:
//
//   'timestamp'  ctx.getOutputTimestamp(): the browser's own pairing (contextTime ↔ performanceTime)
//                of the sample now leaving the device. Supposed to include the output latency.
//   'latency'    ctx.currentTime paired with performance.now(), plus what the browser reports for
//                its output path: baseLatency (page → audio system) + outputLatency (audio system
//                → speaker). The two are consecutive stages, so they add.
//   'raw'        ctx.currentTime paired with performance.now(), nothing added: the baseline that
//                shows how much the two above actually correct.
//
// On top of any mode, `trimMs` is the manual / calibrated correction for what the device does not
// report (a Bluetooth speaker): positive = this device is heard late, so schedule earlier.

export const MODES = ['timestamp', 'latency', 'raw']

// What a believable timestamp implies as output latency. Outside this, it is a browser bug
// (some WebKit builds returned a contextTime in the wrong unit), not a measurement.
const TS_MIN_MS = -10, TS_MAX_MS = 1500

export class AudioClock {
  constructor(ctx) {
    this.ctx = ctx
    this.mode = 'timestamp'
    this.trimMs = 0
    this.used = 'timestamp'    // the mapping actually applied on the last call
    this.fallbacks = 0         // times 'timestamp' was asked for and could not be used
    this._pairs = []           // recent (performance.now() - currentTime*1000) readings
    this.sample()
  }

  /** Forget the pairing: after a suspend, an interruption or a route change it no longer holds. */
  reset() { this._pairs = [] }

  /**
   * ctx.currentTime only advances once per audio callback (3 ms on a desktop, 10–40 ms on some
   * phones), so one reading can be stale by a whole buffer. Stale readings make `now - currentTime`
   * too LARGE, never too small: the smallest value seen recently is the freshest pairing.
   * Call this often (every scheduler pass, every animation frame). A context that is not running
   * does not advance at all: its readings would be nothing but stale.
   */
  sample() {
    if (this.ctx.state !== 'running') return
    const p = performance.now()
    this._pairs.push({ p, d: p - this.ctx.currentTime * 1000 })
    while (this._pairs.length > 400 || p - this._pairs[0].p > 3000) this._pairs.shift()
  }

  /** performance.now() value at which context time 0 was (or would have been) processed. */
  originRaw() {
    let d = Infinity
    for (const s of this._pairs) if (s.d < d) d = s.d
    return d
  }

  get ready() { return this._pairs.length > 0 }

  get latencies() {
    const c = this.ctx
    return {
      output: typeof c.outputLatency === 'number' && c.outputLatency > 0 ? c.outputLatency * 1000 : null,
      base: typeof c.baseLatency === 'number' && c.baseLatency > 0 ? c.baseLatency * 1000 : null,
    }
  }

  /** What the browser's timestamp implies as output latency, or null where it is missing or zero. */
  timestampLatency() {
    if (typeof this.ctx.getOutputTimestamp !== 'function') return null
    const ts = this.ctx.getOutputTimestamp()
    if (!ts || !(ts.performanceTime > 0) || !(ts.contextTime > 0)) return null
    return ts.performanceTime - ts.contextTime * 1000 - this.originRaw()
  }

  /** How many ms after the raw pairing a sample is heard, per mode (before trim). */
  correctionFor(mode) {
    if (mode === 'timestamp') {
      const l = this.timestampLatency()
      if (l !== null && l >= TS_MIN_MS && l <= TS_MAX_MS) { this.used = 'timestamp'; return l }
      this.fallbacks++
      mode = 'latency'                                   // no believable timestamp: next best
    }
    this.used = mode
    if (mode === 'raw') return 0
    const { output, base } = this.latencies
    return (output ?? 0) + (base ?? 0)
  }

  /** Total ms the device needs a sample ahead of the moment it should be heard. */
  get leadMs() { return this.correctionFor(this.mode) + this.trimMs }

  /** Context time to schedule at, so that the sample is heard at performance time `perfMs`. */
  contextTimeFor(perfMs) {
    return (perfMs - this.trimMs - this.originRaw() - this.correctionFor(this.mode)) / 1000
  }

  /** Everything worth logging about this device's output path. */
  diagnostics() {
    const { output, base } = this.latencies
    return {
      mode: this.mode,
      modeUsed: this.used,
      fallbacks: this.fallbacks,
      trimMs: this.trimMs,
      sampleRate: this.ctx.sampleRate,
      baseLatencyMs: base,
      outputLatencyMs: output,
      timestampLatencyMs: this.ready ? this.timestampLatency() : null,   // comparable with base + output
      state: this.ctx.state,
    }
  }
}
