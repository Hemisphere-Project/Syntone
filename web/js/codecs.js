// Syntone codecs in the browser — what this page can encode, behind the one method the sender core
// calls (shared/sender.js): encode({seq, captureUs, pcm}) → output({seq, captureUs, payload}).
//
// Opus through WebCodecs: 20 ms packets, one per frame. The encoder may hold a few frames before it
// answers (it is asynchronous); each packet is matched back to its frame by timestamp, which is the
// frame's sample index in µs at the stream rate, so a stamp never drifts onto the wrong packet.
import { CODECS } from '/shared/frame.js'
import { PcmEncoder } from '/shared/sender.js'

export { PcmEncoder }

const opusConfig = (rate, channels, bitrate) => ({
  codec: 'opus', sampleRate: rate, numberOfChannels: channels, bitrate,
  opus: { frameDuration: 20_000, complexity: 9, usedtx: false, useinbandfec: false },
})

/** Can this browser encode Opus at this rate and channel count? */
export async function canEncodeOpus(rate = 48000, channels = 1) {
  if (!('AudioEncoder' in self)) return false
  try { return !!(await AudioEncoder.isConfigSupported(opusConfig(rate, channels, 64000))).supported } catch { return false }
}

export class OpusEncoder {
  constructor({ rate = 48000, channels = 1, bitrate = channels > 1 ? 128000 : 64000, onError = () => {} } = {}) {
    this.codec = CODECS.opus
    this.output = null
    this.rate = rate
    this.channels = channels
    this.pending = new Map()      // timestamp µs → {seq, captureUs}
    this.errors = 0
    this.shifted = 0              // packets matched by order because their timestamp was not a frame's
    this.enc = new AudioEncoder({
      output: (chunk) => {
        // by timestamp; if an encoder shifts them (codec delay), packets still come one per frame, in order
        let ts = chunk.timestamp
        if (!this.pending.has(ts)) { ts = this.pending.keys().next().value; this.shifted++ }
        const f = this.pending.get(ts)
        if (!f) return                                   // a packet with no frame: nothing to stamp it with
        for (const k of this.pending.keys()) { this.pending.delete(k); if (k === ts) break }
        const payload = new Uint8Array(chunk.byteLength)
        chunk.copyTo(payload)
        this.output?.({ seq: f.seq, captureUs: f.captureUs, payload })
      },
      error: (e) => { this.errors++; onError(e) },
    })
    this.enc.configure(opusConfig(rate, channels, bitrate))
  }

  encode({ seq, captureUs, pcm, n }) {
    if (this.enc.state !== 'configured') return
    const len = pcm[0].length
    const timestamp = Math.round(n * 1e6 / this.rate)
    const data = new Float32Array(len * this.channels)
    for (let c = 0; c < this.channels; c++) data.set(pcm[c] || pcm[0], c * len)
    const ad = new AudioData({ format: 'f32-planar', sampleRate: this.rate, numberOfFrames: len, numberOfChannels: this.channels, timestamp, data })
    this.pending.set(timestamp, { seq, captureUs })
    if (this.pending.size > 64) this.pending.delete(this.pending.keys().next().value)   // the encoder lost some
    this.enc.encode(ad)
    ad.close()
  }

  close() { try { this.enc.close() } catch {} }
}
