// Syntone receiver — the timestamped ring buffer.
//
// Decoded frames arrive out of order, late, twice, or never. Each one is placed by its sequence
// number at a fixed position on the stream's sample line (frame k starts at sample k·frameSamples),
// so a missing frame is a hole of silence of exactly its length and whatever follows still plays on
// time. Each frame also keeps its capture stamp (relay µs, from the sender's CaptureStamper): the
// player asks « which stream sample was captured at relay time C? » and the answer comes from the
// stamped frame nearest to C, extended at the nominal rate — between neighbours that is 20 ms of
// audio, so even a sender 500 ppm off is placed within 10 µs.
//
// Pure and allocation-free after construction, so the same code runs in Node tests and in the
// audio thread (AudioWorklet).

const restartMsDefault = 200

/** Signed distance from sequence number b to a, on the uint32 circle. */
export function seqDelta(a, b) { return ((a - b + 0x80000000) >>> 0) - 0x80000000 }

export class FrameRing {
  constructor({ channels = 1, frameSamples = 960, rate = 48000, capacityFrames = 512, restartMs = restartMsDefault } = {}) {
    this.channels = channels
    this.N = frameSamples
    this.rate = rate
    this.cap = capacityFrames
    this.restartUs = restartMs * 1000
    this.pcm = Array.from({ length: channels }, () => new Float32Array(capacityFrames * frameSamples))
    this.slotK = new Float64Array(capacityFrames)       // which frame each slot holds (NaN: none)
    this.stamp = new Float64Array(capacityFrames)       // its capture time, relay µs
    this.restarts = 0
    this.clear()
  }

  /** Forget the stream: the next frame starts a new one at k = 0. */
  clear() {
    this.slotK.fill(NaN)
    this.baseSeq = null     // sequence number of frame k = 0
    this.newestK = -Infinity
    this.floorK = -Infinity // frames below this are behind the reader: too late to be played
  }

  _slot(k) { return ((k % this.cap) + this.cap) % this.cap }

  /** The frame number of a sequence number on this stream. */
  kOf(seq) { return this.baseSeq === null ? 0 : seqDelta(seq >>> 0, this.baseSeq) }

  /**
   * Place one decoded frame. `pcm` is one Float32Array per channel (a mono frame feeds every
   * channel). Returns 'ok', or why it was not kept: 'dup', 'late' (the reader is past it), 'stale'
   * (older than the whole ring), 'bad' — or 'restart' when it opened a new stream: its stamp does
   * not continue the current stream where its sequence number puts it (a new sender took over, or
   * this one restarted), so everything before it is dropped.
   */
  put(seq, captureUs, pcm) {
    if (!Number.isFinite(captureUs) || !pcm || !pcm.length) return 'bad'
    let status = 'ok'
    if (this.baseSeq === null) this.baseSeq = seq >>> 0
    else {
      const k = this.kOf(seq)
      const ref = this._nearest(k)
      // the stamp decides, not the sequence number: a frame of this stream, however late or far
      // ahead, sits where its number says; a new sender's frame does not
      const off = ref === null ? 0 : Math.abs(captureUs - this.stamp[this._slot(ref)] - (k - ref) * this.N * 1e6 / this.rate)
      if (off > this.restartUs) { this.clear(); this.baseSeq = seq >>> 0; this.restarts++; status = 'restart' }
    }
    const k = this.kOf(seq)
    if (k < this.floorK) return 'late'
    if (k <= this.newestK - this.cap) return 'stale'
    const s = this._slot(k)
    if (this.slotK[s] === k) return 'dup'
    const at = s * this.N
    for (let c = 0; c < this.channels; c++) {
      const src = pcm[c] || pcm[0]
      const dst = this.pcm[c]
      const n = Math.min(this.N, src.length)
      for (let i = 0; i < n; i++) dst[at + i] = src[i]
      for (let i = n; i < this.N; i++) dst[at + i] = 0      // a short frame: the rest is silence
    }
    this.slotK[s] = k
    this.stamp[s] = captureUs
    if (k > this.newestK) this.newestK = k
    return status
  }

  has(k) { return this.slotK[this._slot(k)] === k }

  /** The reader has moved past frame k − 1: frames before k are now late, not merely missing. */
  release(k) { if (k > this.floorK) this.floorK = k }

  /** A present frame close to k (searching outward), or null when the ring is empty. */
  _nearest(k) {
    if (this.newestK === -Infinity) return null
    if (k > this.newestK) k = this.newestK
    for (let d = 0; d < this.cap; d++) {
      if (this.has(k - d)) return k - d
      if (d && this.has(k + d) && k + d <= this.newestK) return k + d
    }
    return null
  }

  /**
   * The stream sample (fractional) captured at relay time `captureUs`, or null with no frame yet.
   * First guessed from the newest frame, then taken from the frame nearest to that guess.
   */
  indexAt(captureUs) {
    if (this.newestK === -Infinity) return null
    const usPerSample = 1e6 / this.rate
    const nk = this._nearest(this.newestK)
    const guess = Math.floor(nk + (captureUs - this.stamp[this._slot(nk)]) / usPerSample / this.N)
    const k = this._nearest(guess)
    return k * this.N + (captureUs - this.stamp[this._slot(k)]) / usPerSample
  }

  /** Sample `i` of the stream on channel `c`: 0 where the frame is missing. */
  at(c, i) {
    const k = Math.floor(i / this.N)
    const s = this._slot(k)
    return this.slotK[s] === k ? this.pcm[c][s * this.N + (i - k * this.N)] : 0
  }

  /** Is every sample from i0 to i1 (inclusive) present? */
  covers(i0, i1) {
    for (let k = Math.floor(i0 / this.N), last = Math.floor(i1 / this.N); k <= last; k++) if (!this.has(k)) return false
    return true
  }
}
