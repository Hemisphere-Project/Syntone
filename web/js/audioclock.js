// Syntone audio clock — when will a sample scheduled at AudioContext time `c` actually be HEARD,
// on the performance.now() timeline?  This mapping is the weak link of browser sync: the network
// clock can be right to a millisecond while the device still plays 5–300 ms late, because of the
// OS mixer, the audio driver buffer and, worst, a Bluetooth link.
//
// Three ways to build the mapping, selectable so each phone can be MEASURED with each:
//
//   'timestamp'  ctx.getOutputTimestamp(): the browser's own pairing (contextTime ↔ performanceTime)
//                of the sample now leaving the device. Supposed to include the output latency.
//   'latency'    ctx.currentTime paired with performance.now(), plus ctx.outputLatency
//                (falls back to baseLatency where outputLatency is missing).
//   'raw'        ctx.currentTime paired with performance.now(), nothing added: the baseline that
//                shows how much the two above actually correct.
//
// On top of any mode, `trimMs` is the manual / calibrated correction for what the device does not
// report (a Bluetooth speaker): positive = this device is heard late, so schedule earlier.

export const MODES = ['timestamp', 'latency', 'raw']

export class AudioClock {
  constructor(ctx) {
    this.ctx = ctx
    this.mode = 'timestamp'
    this.trimMs = 0
    this._pairs = []   // recent (performance.now() - currentTime*1000) readings, for the currentTime pairing
    this.sample()
  }

  /**
   * ctx.currentTime only advances once per audio callback (3 ms on a desktop, 10–40 ms on some
   * phones), so one reading can be stale by a whole buffer. Stale readings make `now - currentTime`
   * too LARGE, never too small: the smallest value seen recently is the freshest pairing.
   * Call this often (every scheduler pass, every animation frame).
   */
  sample() {
    const p = performance.now()
    this._pairs.push({ p, d: p - this.ctx.currentTime * 1000 })
    while (this._pairs.length > 400 || p - this._pairs[0].p > 3000) this._pairs.shift()
  }

  /** performance.now() value at which context time 0 was (or would have been) processed. */
  _originRaw() {
    let d = Infinity
    for (const s of this._pairs) if (s.d < d) d = s.d
    return d
  }

  get outputLatencyMs() {
    const c = this.ctx
    const ol = typeof c.outputLatency === 'number' && c.outputLatency > 0 ? c.outputLatency : null
    return { output: ol === null ? null : ol * 1000, base: typeof c.baseLatency === 'number' ? c.baseLatency * 1000 : null }
  }

  /** The browser's (contextTime, performanceTime) pair, or null where it is missing or still zero. */
  outputTimestamp() {
    if (typeof this.ctx.getOutputTimestamp !== 'function') return null
    const ts = this.ctx.getOutputTimestamp()
    if (!ts || !(ts.performanceTime > 0) || !(ts.contextTime > 0)) return null
    return ts
  }

  /** performance.now() at which a sample at context time 0 is HEARD, per mode (before trim). */
  originFor(mode) {
    if (mode === 'timestamp') {
      const ts = this.outputTimestamp()
      if (ts) return ts.performanceTime - ts.contextTime * 1000
      mode = 'latency'                                   // no usable timestamp: next best
    }
    const raw = this._originRaw()
    if (mode === 'raw') return raw
    const { output, base } = this.outputLatencyMs
    return raw + (output ?? base ?? 0)
  }

  /** Context time to schedule at, so that the sample is heard at performance time `perfMs`. */
  contextTimeFor(perfMs) {
    return (perfMs - this.trimMs - this.originFor(this.mode)) / 1000
  }

  /** Everything worth logging about this device's output path. */
  diagnostics() {
    const { output, base } = this.outputLatencyMs
    const raw = this._originRaw()
    const ts = this.outputTimestamp()
    return {
      mode: this.mode,
      trimMs: this.trimMs,
      sampleRate: this.ctx.sampleRate,
      baseLatencyMs: base,
      outputLatencyMs: output,
      // what getOutputTimestamp implies as output latency: comparable with outputLatencyMs
      timestampLatencyMs: ts ? ts.performanceTime - ts.contextTime * 1000 - raw : null,
      state: this.ctx.state,
    }
  }
}
