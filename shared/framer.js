// Syntone sender — the framer.
//
// Capture hands over blocks of whatever size its callback runs at (128 samples in an AudioWorklet,
// more on some phones); the wire wants frames of exactly 20 ms (960 samples at 48 kHz, plan §3).
// The framer cuts the one into the other and gives every frame the index of its first sample since
// capture started — the `n` the sender's CaptureStamper turns into a relay time, and the frame's
// sequence number (n / frameSamples) the receiver's ring places it by.
//
// A block with fewer channels than the stream repeats its first channel; extra channels are left out.
// Pure (no I/O, no clock reads): the sender page feeds it, Node tests drive it.

export class Framer {
  constructor({ channels = 1, frameSamples = 960 } = {}) {
    this.channels = channels
    this.N = frameSamples
    this.reset()
  }

  /** Drop the partial frame and start counting again from sample 0 (a new capture). */
  reset() {
    this.n = 0              // samples pushed so far
    this.k = 0              // frames completed so far: frame k starts at sample k·N
    this.fill = 0           // samples already in the open frame
    this.open = this._alloc()
  }

  _alloc() { return Array.from({ length: this.channels }, () => new Float32Array(this.N)) }

  /**
   * One captured block.
   * @param {Float32Array[]} block  one array per channel, all the same length
   * @returns {Array<{n:number, seq:number, pcm:Float32Array[]}>} the frames this block completed, in order
   */
  push(block) {
    const out = []
    const len = block?.[0]?.length ?? 0
    let i = 0
    while (i < len) {
      const take = Math.min(len - i, this.N - this.fill)
      for (let c = 0; c < this.channels; c++) {
        const src = block[c] ?? block[0]
        this.open[c].set(src.subarray(i, i + take), this.fill)
      }
      this.fill += take; i += take
      if (this.fill === this.N) {
        out.push({ n: this.k * this.N, seq: this.k % 0x100000000, pcm: this.open })
        this.k++
        this.open = this._alloc()
        this.fill = 0
      }
    }
    this.n += len
    return out
  }
}
