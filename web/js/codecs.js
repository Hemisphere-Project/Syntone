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

// ---------------------------------------------------------------- decoding (the receiver's side)

export { PcmDecoder } from '/shared/receiver.js'

/** Can this browser decode Opus through WebCodecs? (iOS Safari before 26 cannot: WebAssembly then) */
export async function canDecodeOpus(rate = 48000, channels = 1) {
  if (!('AudioDecoder' in self)) return false
  try { return !!(await AudioDecoder.isConfigSupported({ codec: 'opus', sampleRate: rate, numberOfChannels: channels })).supported } catch { return false }
}

/**
 * Opus through WebCodecs. Each packet goes in with a timestamp made from its sequence number, so the
 * answer — asynchronous, possibly batched — is matched back to its own frame and capture stamp. No OpusHead is given,
 * so nothing trims the encoder's look-ahead: the decoded audio is late by a constant (to be measured
 * on the stream click test, then taken off the stamp here).
 */
export class OpusDecoder {
  constructor({ rate = 48000, channels = 1, onError = () => {} } = {}) {
    this.codec = CODECS.opus
    this.output = null
    this.channels = channels
    this.pending = new Map()      // chunk timestamp → {seq, captureUs}
    this.errors = 0
    this.shifted = 0              // frames matched by order because the decoder re-timed them
    this.dec = new AudioDecoder({
      output: (ad) => {
        // by timestamp; a decoder that re-times its output (Chrome counts from the first packet) still
        // answers one frame per packet, in order: then the oldest frame waiting is this one
        let ts = ad.timestamp
        if (!this.pending.has(ts)) { ts = this.pending.keys().next().value; this.shifted++ }
        const f = this.pending.get(ts)
        for (const k of this.pending.keys()) { this.pending.delete(k); if (k === ts) break }
        if (f) {
          const pcm = []
          for (let c = 0; c < this.channels; c++) {
            const ch = new Float32Array(ad.numberOfFrames)
            ad.copyTo(ch, { planeIndex: Math.min(c, ad.numberOfChannels - 1), format: 'f32-planar' })
            pcm.push(ch)
          }
          this.output?.({ seq: f.seq, captureUs: f.captureUs, pcm })
        }
        ad.close()
      },
      error: (e) => { this.errors++; onError(e) },
    })
    this.dec.configure({ codec: 'opus', sampleRate: rate, numberOfChannels: channels })
  }

  decode({ seq, captureUs, payload }) {
    if (this.dec.state !== 'configured') return false
    const timestamp = seq * 20_000        // 20 ms apart, like the packets: what a re-timing decoder counts
    this.pending.set(timestamp, { seq, captureUs })
    if (this.pending.size > 64) this.pending.delete(this.pending.keys().next().value)
    this.dec.decode(new EncodedAudioChunk({ type: 'key', timestamp, data: payload }))
    return true
  }

  close() { try { this.dec.close() } catch {} }
}

/**
 * The fallback where WebCodecs cannot decode Opus (iOS Safari before 26): libopus compiled to
 * WebAssembly (web/vendor/opus-decoder.min.js, loaded only when asked for). Synchronous: each packet
 * answers at once, with its own stamp. Use `await wasmOpusDecoder(...)`: the module compiles first.
 */
let wasmLib = null
function loadWasmOpus() {
  wasmLib ??= new Promise((ok, no) => {
    if (globalThis['opus-decoder']) return ok(globalThis['opus-decoder'])
    const s = document.createElement('script')
    s.src = '/vendor/opus-decoder.min.js'
    s.onload = () => (globalThis['opus-decoder'] ? ok(globalThis['opus-decoder']) : no(new Error('the WebAssembly Opus decoder did not load')))
    s.onerror = () => { wasmLib = null; no(new Error('the WebAssembly Opus decoder did not load')) }
    document.head.appendChild(s)
  })
  return wasmLib
}

export class WasmOpusDecoder {
  constructor(lib, { rate = 48000, channels = 1 } = {}) {
    this.codec = CODECS.opus
    this.output = null
    this.channels = channels
    this.errors = 0
    this.dec = new lib.OpusDecoder({ channels, sampleRate: rate, preSkip: 0 })
    this.ready = this.dec.ready
  }

  decode({ seq, captureUs, payload }) {
    const r = this.dec.decodeFrame(payload)
    if (!r || !r.samplesDecoded || r.errors?.length) { this.errors++; return false }
    const pcm = []
    for (let c = 0; c < this.channels; c++) pcm.push(r.channelData[Math.min(c, r.channelData.length - 1)].slice(0, r.samplesDecoded))
    this.output?.({ seq, captureUs, pcm })
    return true
  }

  close() { try { this.dec.free() } catch {} }
}

export async function wasmOpusDecoder(o = {}) {
  const d = new WasmOpusDecoder(await loadWasmOpus(), o)
  await d.ready
  return d
}
