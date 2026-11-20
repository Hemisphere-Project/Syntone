// Syntone receiver — the player: holds the playout rule on the frames in a FrameRing.
//
// The rule (docs/architecture.md §1): a sample captured at C is handed to the audio system at
// C + D − L, so that it is heard at C + D. D belongs to the group, L to this device.
//
// Each block, the caller says WHEN (on its own clock) the block's first sample is handed to the
// audio system. Through the time base that becomes room-timeline time; plus L it is the time the
// block is heard; minus D it is the capture time that must be playing. The ring turns that capture
// time into a stream sample, the TARGET; the read head should sit on it.
//
//   - Drift: the target moves a little faster or slower than the nominal ratio (stream rate over
//     output rate, 48000/44100 on many phones), because no two crystals agree. A line fitted
//     through (output time, target) over the last ~30 s gives that rate; the read head follows it.
//   - Phase: what is left of the error (read head − target), smoothed over ~1 s, is corrected by a
//     few ppm more: never beyond ±15 ppm while it is under 2 ms (inaudible, and immune to the
//     time base's jitter), and up to ±500 ppm to recover from more.
//   - Beyond 20 ms, held for a few blocks (a clock step, a new sender, a changed D): no slewing,
//     a jump to the target, crossfaded over 5 ms so it does not click.
//   - Late data: a frame that is not there plays as silence, and the read head moves on at the
//     same pace, so playback resumes exactly on time when frames come back (skip-ahead). Frames
//     behind the read head are released: arriving later, they are refused as late.
//
// Seams: the player takes a time base ({ toTimeline(localMs) → timeline ms }; ClockSync's
// `toServer` is one) and a latency source ({ ms }, read every block: the browser's report, an
// operator's trim, a measurement), never a socket or a setting.
//
// Pure and allocation-free after construction: the same code runs in Node tests on simulated
// clocks and in the audio thread — web/js/player-worklet.js wraps it with a FrameRing, takes
// frames, the time base, L and D through its port, and reports `stats`.

export const DEFAULTS = {
  delayMs: 150,           // D: the group's delay
  filterMs: 1000,         // the error is smoothed over about this long before it steers
  gainPpmPerMs: 15,       // phase correction per ms of smoothed error…
  gentleMs: 2,            // …held within ±gentlePpm while the error is under gentleMs
  gentlePpm: 15,
  recoverPpmPerMs: 250,   // beyond gentleMs it grows this much per further ms…
  maxPpm: 500,            // …up to this; drift + phase never exceed it either
  jumpMs: 20,             // an error beyond this…
  jumpBlocks: 4,          // …in this many blocks running is fixed by a jump
  fadeMs: 5,              // crossfade of a jump
  driftTauS: 30,          // memory of the drift fit
  driftMinS: 5,           // span the fit needs before it is trusted
}

export class Player {
  /**
   * @param ring      FrameRing holding the decoded frames
   * @param rate      output sample rate (the AudioContext's)
   * @param timeBase  { toTimeline(localMs) } — this device's clock → room timeline, ms
   * @param latency   { ms } — L, this device's output latency, read every block
   */
  constructor({ ring, rate = 48000, timeBase, latency, ...opts }) {
    this.ring = ring
    this.rate = rate
    this.timeBase = timeBase
    this.latency = latency
    this.o = { ...DEFAULTS, ...opts }
    this.nominal = ring.rate / rate        // stream samples per output sample, before drift
    this.stats = { locked: false, errorMs: 0, smoothedMs: 0, driftPpm: 0, phasePpm: 0, ppm: 0, jumps: 0, dropouts: 0 }
    this.reset()
  }

  /** Forget the lock: the next block with frames starts on the target. */
  reset() {
    this.locked = false
    this.pos = 0                 // read head, fractional stream sample
    this.eF = 0                  // smoothed error, ms
    this.far = 0                 // blocks in a row beyond jumpMs
    this.fadeLeft = 0            // samples of crossfade still to play…
    this.fadePos = 0             // …from this old read head
    this.k = null                // frame the read head was last in
    this.restarts = this.ring.restarts
    this.stats.locked = false
    this._fitReset()
  }

  /** D, the group's delay (ms). A change beyond jumpMs is a jump; under it, a slew. */
  set delayMs(ms) { if (ms !== this.o.delayMs) { this.o.delayMs = ms; this._fitReset() } }   // the target steps: not drift
  get delayMs() { return this.o.delayMs }

  /**
   * Fill `outs` (one Float32Array per output channel, all the same length) with the block whose
   * first sample is handed to the audio system at `localMs` on this device's clock.
   */
  render(outs, localMs) {
    const o = this.o, ring = this.ring, st = this.stats
    const n = outs[0].length
    const blockS = n / this.rate
    const heardMs = this.timeBase.toTimeline(localMs) + this.latency.ms
    const target = ring.indexAt((heardMs - o.delayMs) * 1000)
    if (target === null) {
      for (const out of outs) out.fill(0)
      if (this.locked) this.reset()
      return
    }

    let jump = false
    if (ring.restarts !== this.restarts) { this.restarts = ring.restarts; jump = this.locked }   // a new stream
    if (!this.locked) {
      this.locked = st.locked = true
      this.pos = target
      this._fitReset()
    }

    let e = (this.pos - target) / ring.rate * 1000            // ms; positive = the read head is ahead
    st.errorMs = e
    if (Math.abs(e) > o.jumpMs) { if (++this.far >= o.jumpBlocks) jump = true } else this.far = 0
    if (jump) {
      if (this.fadeLeft === 0) this.fadePos = this.pos        // a jump inside a fade fades from where it fades from
      this.fadeLeft = Math.max(1, Math.round(o.fadeMs / 1000 * this.rate))
      this.fadeN = this.fadeLeft
      this.pos = target
      e = 0; this.eF = 0; this.far = 0
      st.jumps++
      this._fitReset()                                        // the target stepped: the old points lie
    }

    // drift: how fast the target really moves, per output second
    this._fitAdd(target / ring.rate, blockS)
    // phase: the smoothed error, corrected gently
    this.eF += (e - this.eF) * Math.min(1, blockS * 1000 / o.filterMs)
    const a = Math.abs(this.eF)
    const ph = a <= o.gentleMs ? Math.min(o.gentlePpm, o.gainPpmPerMs * a) : Math.min(o.maxPpm, o.gentlePpm + o.recoverPpmPerMs * (a - o.gentleMs))
    st.phasePpm = this.eF > 0 ? -ph : ph
    st.driftPpm = this.drift
    st.ppm = Math.max(-o.maxPpm, Math.min(o.maxPpm, st.driftPpm + st.phasePpm))
    st.smoothedMs = this.eF
    const step = this.nominal * (1 + st.ppm * 1e-6)

    const N = ring.N, chans = ring.channels
    this.blockStart = this.pos                                // where this block reads from: the vectors' output position
    for (let j = 0; j < n; j++) {
      const k = Math.floor(this.pos / N)
      if (k !== this.k) { this.k = k; if (!ring.has(k)) st.dropouts++ }
      for (let c = 0; c < outs.length; c++) {
        const rc = c < chans ? c : chans - 1
        let v = this._read(rc, this.pos)
        if (this.fadeLeft > 0) {
          const g = this.fadeLeft / this.fadeN
          v = v * (1 - g) + this._read(rc, this.fadePos) * g
        }
        outs[c][j] = v
      }
      if (this.fadeLeft > 0) { this.fadePos += step; this.fadeLeft-- }
      this.pos += step
    }
    // the interpolator still needs the sample before the read head; frames before it are past
    const keep = Math.floor(this.pos) - 1
    ring.release(Math.floor((this.fadeLeft > 0 ? Math.min(keep, Math.floor(this.fadePos) - 1) : keep) / N))
  }

  /** Catmull-Rom between samples i and i+1 of channel c (4 taps): exact on lines, smooth on audio. */
  _read(c, x) {
    const r = this.ring, i = Math.floor(x), f = x - i
    const p0 = r.at(c, i - 1), p1 = r.at(c, i), p2 = r.at(c, i + 1), p3 = r.at(c, i + 2)
    return p1 + 0.5 * f * (p2 - p0 + f * (2 * p0 - 5 * p1 + 4 * p2 - p3 + f * (3 * (p1 - p2) + p3 - p0)))
  }

  // An exponentially weighted line through (output time, target − output time), kept around t = 0
  // (every point moves back by each block's length) so the sums stay small for hours.
  _fitReset() {
    this.fw = 0; this.ft = 0; this.fy = 0; this.ftt = 0; this.fty = 0
    this.fSpan = 0; this.fOut = 0; this.fY0 = null
    if (this.drift === undefined) this.drift = 0              // kept across a reset: the crystals did not change
  }

  _fitAdd(targetS, blockS) {
    const o = this.o
    const y0 = targetS - this.fOut                            // how far the target is from output time
    if (this.fY0 === null) this.fY0 = y0
    const y = y0 - this.fY0
    this.fOut += blockS
    const l = Math.exp(-blockS / o.driftTauS), d = blockS
    // age the old points by one block (t → t − d), then decay them
    this.ftt = (this.ftt - 2 * d * this.ft + d * d * this.fw) * l
    this.fty = (this.fty - d * this.fy) * l
    this.ft = (this.ft - d * this.fw) * l
    this.fy *= l
    this.fw = this.fw * l + 1
    this.fy += y
    if (this.fSpan === 0) { this.fSpan = 1e-9; return }       // the first point measures no span
    this.fSpan += d
    if (this.fSpan < o.driftMinS) return
    const den = this.fw * this.ftt - this.ft * this.ft
    if (den > 0) this.drift = Math.max(-o.maxPpm, Math.min(o.maxPpm, (this.fw * this.fty - this.ft * this.fy) / den * 1e6))
  }
}
