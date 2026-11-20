// Syntone receiver core (plan §4 M1): frames from the relay → decoded → (test mode: this slot only)
// → the player, plus the time base the player needs. Pure, so Node tests run it without a browser;
// web/listen/listen.js wires it to a socket, a decoder and the player worklet.
//
// A decoder is the codec seam (architecture §6), the mirror of the sender's encoder:
//   { codec, output, decode({seq, captureUs, payload}) }   → output({seq, captureUs, pcm: Float32Array[]})
// PcmDecoder lives here; the browser's Opus decoders live in web/js/codecs.js. A decoder may answer
// later and out of call order (WebCodecs is asynchronous): the stamp travels with each frame.
//
// What leaves the device is counts only (policy `reports: counts`, architecture §3): how many frames,
// how many lost, how far off the player is. Nothing that names or locates the device.
import { decodeFrame, CODEC_PCM } from './frame.js'
import { decodePcm } from './pcm.js'
import { gateSlot } from './streamclicks.js'

export class PcmDecoder {
  constructor({ channels = 1 } = {}) {
    this.codec = CODEC_PCM
    this.channels = channels
    this.output = null
  }
  decode({ seq, captureUs, payload }) {
    const pcm = decodePcm(payload, this.channels)
    if (!pcm) return false
    this.output?.({ seq, captureUs, pcm })
    return true
  }
  close() {}
}

export class ReceiverCore {
  /**
   * @param {{decoder: object, post: Function, rate?: number, testSlot?: number}} o
   *   `post(frame)` hands a decoded frame on (to the player worklet's port).
   *   `testSlot` ≥ 0: test mode, only that slot's click bursts are kept (shared/streamclicks.js).
   */
  constructor({ decoder, post, rate = 48000, testSlot = -1 }) {
    this.rate = rate
    this.post = post
    this.testSlot = testSlot
    this.stats = { received: 0, decoded: 0, bad: 0, otherCodec: 0, decodeErrors: 0, lost: 0, reordered: 0 }
    this._last = null           // highest seq seen
    this.setDecoder(decoder)
  }

  setDecoder(decoder) {
    this.decoder?.close?.()
    this.decoder = decoder
    decoder.output = (f) => this._decoded(f)
  }

  /** One binary message from the relay (ArrayBuffer or Uint8Array). */
  frame(bytes) {
    const f = decodeFrame(bytes)
    if (!f) { this.stats.bad++; return }
    if (f.codec !== this.decoder.codec) { this.stats.otherCodec++; return }
    this.stats.received++
    if (this._last === null) this._last = f.seq
    else {
      const d = ((((f.seq - this._last) >>> 0) + 0x80000000) >>> 0) - 0x80000000
      if (d > 0) { this.stats.lost += d - 1; this._last = f.seq }
      else { this.stats.reordered++; if (this.stats.lost > 0) this.stats.lost-- }   // a late one fills its gap
    }
    try { if (this.decoder.decode({ seq: f.seq, captureUs: f.captureUs, payload: f.payload }) === false) this.stats.decodeErrors++ }
    catch { this.stats.decodeErrors++ }
  }

  _decoded({ seq, captureUs, pcm }) {
    this.stats.decoded++
    if (this.testSlot >= 0) gateSlot(pcm, captureUs, this.rate, this.testSlot)
    this.post({ type: 'frame', seq, captureUs, pcm })
  }

  /** A new sender, a reconnect: the sequence starts over. */
  resetSeq() { this._last = null }
}

/**
 * The player's time base as a line (web/js/player-worklet.js `clock` message): context time `ctxMs`
 * is `timelineMs` on the relay clock, and the relay clock runs `rate` ms per context ms.
 * @param {number} ctxMs        a context time (ms), usually the current one
 * @param {number} originPerfMs performance.now() at context time 0 (AudioClock.originRaw())
 * @param {(perfMs:number)=>number} toServer  the relay clock (ClockSync.toServer)
 */
export function clockLine(ctxMs, originPerfMs, toServer) {
  const timelineMs = toServer(originPerfMs + ctxMs)
  const rate = (toServer(originPerfMs + ctxMs + 10_000) - timelineMs) / 10_000
  return { type: 'clock', ctxMs, timelineMs, rate }
}

/** Is the new line far enough from the one the player has to be worth sending? (ms at `ctxMs`) */
export function lineMoved(a, b, ctxMs, thresholdMs = 0.25) {
  if (!a || !b) return true
  const at = (l) => l.timelineMs + (ctxMs - l.ctxMs) * l.rate
  return Math.abs(at(a) - at(b)) > thresholdMs || Math.abs(a.rate - b.rate) > 2e-6
}
