// Syntone sender — the core between capture and the wire.
//
//   captured block + relay time it reached us
//     → CaptureStamper.observe (n, t)          the line the stamps come from (shared/stamps.js)
//     → Framer                                  20 ms frames, each named by its first sample
//     → stamp = stampOf(n)                      relay µs of the frame's first sample
//     → test mode: the click pattern written by that stamp (shared/streamclicks.js)
//     → encoder.encode({seq, captureUs, pcm})   the codec, behind one method (PCM here, Opus in the page)
//     → encodeFrame → send(bytes)               the transport, behind one function (architecture §6)
//
// No frame leaves before the stamper has a line: a frame with no capture time cannot be placed.
// Pure: the page wires capture, the clock, WebCodecs and the socket to it; Node tests drive it.
import { Framer } from './framer.js'
import { CaptureStamper } from './stamps.js'
import { writeClicks } from './streamclicks.js'
import { encodeFrame, CODECS } from './frame.js'
import { encodePcm } from './pcm.js'

/** The PCM codec as an encoder: synchronous, one payload per frame. */
export class PcmEncoder {
  constructor() { this.codec = CODECS.pcm; this.output = null }
  encode(f) { this.output({ seq: f.seq, captureUs: f.captureUs, payload: encodePcm(f.pcm) }) }
  close() {}
}

export class SenderCore {
  /**
   * @param {object} o
   * @param {number} [o.channels]
   * @param {number} [o.rate]          sample rate of the capture (the frame stream's rate)
   * @param {number} [o.frameSamples]
   * @param {{codec:number, output:Function|null, encode:Function, close?:Function}} o.encoder
   *        calls `output({seq, captureUs, payload})` once per frame, now or later
   * @param {(bytes:Uint8Array)=>boolean|void} o.send   false = the transport skipped it (backed up)
   * @param {number} [o.testSlots]     >0: test mode, the click pattern for slots 0…testSlots−1
   * @param {boolean} [o.testOverInput] test mode: mix the pattern over the input instead of replacing it
   */
  constructor({ channels = 1, rate = 48000, frameSamples = 960, encoder, send, testSlots = 0, testOverInput = false, stamps = {} }) {
    this.rate = rate
    this.framer = new Framer({ channels, frameSamples })
    this.stamper = new CaptureStamper({ rate, ...stamps })
    this.send = send
    this.testSlots = testSlots
    this.testOverInput = testOverInput
    this.counts = { blocks: 0, frames: 0, unstamped: 0, sent: 0, skipped: 0, bytes: 0, maxPayload: 0 }
    this.setEncoder(encoder)
  }

  /**
   * Another codec (the room switched): the next frame goes to the new encoder, the stamps and the
   * sequence run on. The old one is closed; a packet it still hands over keeps its own codec byte.
   */
  setEncoder(encoder) {
    const old = this.encoder
    this.encoder = encoder
    encoder.output = (p) => this._out(p, encoder.codec)
    if (old && old !== encoder) old.close?.()
  }

  /**
   * One captured block, and the relay time (µs) at which it reached the page.
   * @param {Float32Array[]} block
   * @param {number|null} relayUs   null while the clock is not synced: the block still counts
   */
  block(block, relayUs) {
    this.counts.blocks++
    const frames = this.framer.push(block)
    if (relayUs !== null && Number.isFinite(relayUs)) this.stamper.observe(this.framer.n, relayUs)
    for (const f of frames) {
      const captureUs = this.stamper.stampOf(f.n)
      if (captureUs === null) { this.counts.unstamped++; continue }
      if (this.testSlots > 0) writeClicks(f.pcm, captureUs, this.rate, { slots: this.testSlots, add: this.testOverInput })
      this.counts.frames++
      this.encoder.encode({ seq: f.seq, captureUs, pcm: f.pcm, n: f.n })
    }
  }

  _out({ seq, captureUs, payload }, codec) {
    const bytes = encodeFrame({ seq, captureUs, payload, codec })
    if (this.send(bytes) === false) { this.counts.skipped++; return }
    this.counts.sent++
    this.counts.bytes += bytes.length
    if (payload.length > this.counts.maxPayload) this.counts.maxPayload = payload.length
  }

  /** A new capture (source changed, context restarted): sample count and stamps start over. */
  restart() { this.framer.reset(); this.stamper.reset() }

  get stats() { return { ...this.counts, stamps: this.stamper.stats } }
}
