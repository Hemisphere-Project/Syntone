// Syntone stream click test (plan §4 M1) — the M0 click pattern, carried by the audio stream itself.
//
// The sender writes the staggered pattern into each frame BY ITS CAPTURE STAMP: slot s's burst
// starts exactly at relay time k·PERIOD + s·STAGGER. Every receiver plays the frame at
// capture + D − L, so it is heard at k·PERIOD + s·STAGGER + D, and the one-microphone analyser
// measures the whole path (stamp, relay, decode, player, speaker) with the M0 method.
//
// In test mode a receiver lets through only its own slot (`gateSlot`), so each phone in the
// recording is one pitch at one place in the second, exactly as on the M0 click page.
//
// Same burst as the click page (web/lab/lab.js): a hard onset — what gets measured — then a fade
// over the last quarter. Pure: Node tests drive it.
import { PERIOD_MS, STAGGER_MS, MAX_SLOTS, BURST_MS, slotFreq } from './clicks.js'

const AMP = 0.9

/**
 * Writes the pattern into one frame, over what is already there (sum, clipped to ±1).
 * @param {Float32Array[]} pcm  the frame, one array per channel; every channel gets the pattern
 * @param {number} captureUs    relay time of the frame's first sample (µs)
 * @param {number} rate         samples per second of the frame
 * @param {{slots?:number, add?:boolean}} [o]  slots 0…slots−1 click; add=false replaces the frame
 */
export function writeClicks(pcm, captureUs, rate, { slots = MAX_SLOTS, add = false } = {}) {
  const len = pcm[0].length
  const t0 = captureUs / 1000                         // ms
  const msPer = 1000 / rate
  if (!add) for (const ch of pcm) ch.fill(0)
  const fade = BURST_MS * 0.25
  for (let s = 0; s < Math.min(slots, MAX_SLOTS); s++) {
    const off = s * STAGGER_MS
    const w = 2 * Math.PI * slotFreq(s) / 1000      // rad per ms
    // the bursts of this slot that overlap [t0 − BURST_MS, t0 + frame length]
    const first = Math.ceil((t0 - BURST_MS - off) / PERIOD_MS)
    const last = Math.floor((t0 + len * msPer - off) / PERIOD_MS)
    for (let k = first; k <= last; k++) {
      const onset = k * PERIOD_MS + off
      const i0 = Math.max(0, Math.ceil((onset - t0) / msPer))
      const i1 = Math.min(len, Math.ceil((onset + BURST_MS - t0) / msPer))
      for (let i = i0; i < i1; i++) {
        const dt = t0 + i * msPer - onset                // ms into the burst, sub-sample exact
        if (dt < 0 || dt >= BURST_MS) continue
        const env = dt > BURST_MS - fade ? (BURST_MS - dt) / fade : 1
        const v = AMP * env * Math.sin(w * dt)
        for (const ch of pcm) ch[i] = Math.max(-1, Math.min(1, ch[i] + v))
      }
    }
  }
  return pcm
}

/** The window a receiver keeps around its own slot's onset, in ms. Wide enough for Opus's own
 *  delay (about 6.5 ms of encoder look-ahead) and a stamp offset; narrow enough that the next
 *  slot, 100 ms away, never gets through. */
export const GATE = Object.freeze({ beforeMs: 20, afterMs: 40 })

/**
 * Test mode on a receiver: silence everything but this slot's bursts, in place.
 * @param {Float32Array[]} pcm  a decoded frame
 * @param {number} captureUs    its capture stamp (relay µs)
 * @param {number} rate
 * @param {number} slot         the receiver's slot (0…MAX_SLOTS−1, wrapped)
 */
export function gateSlot(pcm, captureUs, rate, slot, { beforeMs = GATE.beforeMs, afterMs = GATE.afterMs } = {}) {
  const len = pcm[0].length
  const t0 = captureUs / 1000, msPer = 1000 / rate
  const off = (((slot % MAX_SLOTS) + MAX_SLOTS) % MAX_SLOTS) * STAGGER_MS
  const keepTo = BURST_MS + afterMs
  for (let i = 0; i < len; i++) {
    const m = (((t0 + i * msPer - off) % PERIOD_MS) + PERIOD_MS) % PERIOD_MS   // ms after this slot's onset
    if (m < keepTo || m >= PERIOD_MS - beforeMs) continue
    for (const ch of pcm) ch[i] = 0
  }
  return pcm
}
