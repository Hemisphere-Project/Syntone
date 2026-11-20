// Syntone PCM — the last-resort codec (plan §4 M1: « if Opus fails on a phone in hand, plain PCM is
// the fallback codec »). The payload of a frame with codec 2 (shared/frame.js): 16-bit signed
// samples, little-endian, channels interleaved. 20 ms of 48 kHz stereo is 3840 bytes, inside the
// frame's MAX_PAYLOAD; mono is half that. Heavy for LTE (768 kbit/s stereo), fine for a lab.
//
// Same code in the browser and in Node: only typed arrays and DataView.

/**
 * @param {Float32Array[]} pcm  one array per channel, all the same length, values in [-1, 1]
 * @returns {Uint8Array}
 */
export function encodePcm(pcm) {
  const ch = pcm.length, len = pcm[0].length
  const out = new Uint8Array(len * ch * 2)
  const dv = new DataView(out.buffer)
  for (let i = 0, o = 0; i < len; i++) {
    for (let c = 0; c < ch; c++, o += 2) {
      const v = pcm[c][i]
      const s = v >= 1 ? 32767 : v <= -1 ? -32768 : Math.round(v * 32768) || 0   // NaN → 0
      dv.setInt16(o, Math.min(32767, s), true)
    }
  }
  return out
}

/**
 * @param {Uint8Array} bytes   a frame's payload (may be a view into a larger buffer)
 * @param {number} channels    how many channels are interleaved in it
 * @returns {Float32Array[] | null}  one array per channel; null if the length does not divide
 */
export function decodePcm(bytes, channels) {
  if (!(channels >= 1) || bytes.length % (2 * channels)) return null
  const len = bytes.length / (2 * channels)
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const out = Array.from({ length: channels }, () => new Float32Array(len))
  for (let i = 0, o = 0; i < len; i++) {
    for (let c = 0; c < channels; c++, o += 2) out[c][i] = dv.getInt16(o, true) / 32768
  }
  return out
}
