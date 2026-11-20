// node --test — the stream click test: the pattern written by capture stamp, and the receiver's gate.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { writeClicks, gateSlot } from '../shared/streamclicks.js'
import { PERIOD_MS, STAGGER_MS, BURST_MS, MAX_SLOTS } from '../shared/clicks.js'

const RATE = 48000, N = 960
const usPer = 1e6 / RATE

/** Renders `ms` of stream from relay time `startUs`, frame by frame as a sender would. */
function stream(startUs, ms, o) {
  const frames = Math.ceil(ms * RATE / 1000 / N)
  const out = new Float32Array(frames * N)
  for (let k = 0; k < frames; k++) {
    const pcm = [new Float32Array(N)]
    writeClicks(pcm, startUs + k * N * usPer, RATE, o)
    out.set(pcm[0], k * N)
  }
  return out
}
/** Relay times (ms) at which a burst starts: the first non-zero sample after ≥ 50 ms of silence. */
function onsets(x, startUs) {
  const at = []
  let quiet = Infinity
  for (let i = 0; i < x.length; i++) {
    if (x[i] !== 0) { if (quiet >= 50 * RATE / 1000) at.push(startUs / 1000 + i * 1000 / RATE); quiet = 0 } else quiet++
  }
  return at
}

test('each slot starts on k·PERIOD + s·STAGGER of relay time, across frame edges, to the sample', () => {
  const startUs = 7_000_050_123                       // off the pattern's sample grid, between bursts
  const x = stream(startUs, 3000, { slots: MAX_SLOTS })
  const got = onsets(x, startUs)
  const want = []
  for (let k = 7_000; k < 7_003; k++) for (let s = 0; s < MAX_SLOTS; s++) want.push(k * PERIOD_MS + s * STAGGER_MS)
  const firstK = want.findIndex((t) => t >= startUs / 1000)
  const exp = want.slice(firstK).filter((t) => t < startUs / 1000 + x.length * 1000 / RATE - BURST_MS)
  assert.equal(got.length >= exp.length, true)
  exp.forEach((t, i) => assert.ok(got[i] - t >= 0 && got[i] - t < 1000 / RATE, `onset ${i}: ${got[i]} vs ${t}`))
})

test('a burst cut by a frame edge is the same burst as one in a single frame', () => {
  const O = 1_000_000_000 + 300_000                   // slot 3 of beat 1000, relay µs
  const whole = [new Float32Array(N)]
  writeClicks(whole, O - 5000, RATE)                  // onset at sample 240, burst wholly inside
  const a = [new Float32Array(N)], b = [new Float32Array(N)]
  writeClicks(a, O - 17_000, RATE)                    // onset at sample 816: half the burst in each frame
  writeClicks(b, O - 17_000 + N * usPer, RATE)
  const joined = new Float32Array(2 * N); joined.set(a[0]); joined.set(b[0], N)
  const len = BURST_MS * RATE / 1000
  assert.ok(whole[0][241] !== 0)
  for (let i = 0; i < len; i++) assert.ok(Math.abs(whole[0][240 + i] - joined[816 + i]) < 1e-6, `sample ${i}`)
  assert.equal(joined[816 + len], 0)
})

test('slots limits which pitches click; add mixes over the frame', () => {
  const x = stream(5e9, 1000, { slots: 2 })
  assert.equal(onsets(x, 5e9).length, 2)
  const bed = Math.fround(0.05)
  const pcm = [new Float32Array(N).fill(bed)]
  writeClicks(pcm, 5e9 + 500_000, RATE, { add: true })     // 500 ms: slot 5's onset opens the frame
  assert.equal(pcm[0][N - 1], bed)                          // after the burst: the bed, untouched
  assert.notEqual(pcm[0][1], bed)                           // inside it: bed + burst
})

test('the gate keeps only its own slot, whatever the frame edges', () => {
  const startUs = 3e9 + 50_041                       // no burst cut by the start
  for (let slot = 0; slot < MAX_SLOTS; slot++) {
    const frames = Math.ceil(2000 * RATE / 1000 / N)
    const x = new Float32Array(frames * N)
    for (let k = 0; k < frames; k++) {
      const cap = startUs + k * N * usPer
      const pcm = [new Float32Array(N)]
      writeClicks(pcm, cap, RATE)
      gateSlot(pcm, cap, RATE, slot)
      x.set(pcm[0], k * N)
    }
    const got = onsets(x, startUs)
    assert.equal(got.length, 2, `slot ${slot}`)
    for (const t of got) assert.ok(Math.abs((t - slot * STAGGER_MS) % PERIOD_MS) < 1, `slot ${slot} at ${t}`)
  }
})

test('the gate lets an Opus-delayed burst through, and silences the noise between', () => {
  const capUs = 9e9 + 200_000 - 10_000                // a frame 10 ms before slot 2's onset
  const pcm = [new Float32Array(N).fill(0.1)]
  gateSlot(pcm, capUs, RATE, 2)
  const kept = pcm[0].reduce((a, v) => a + (v !== 0), 0)
  assert.equal(kept, N)                               // [−10 ms, +10 ms] is inside [−20, +46]
  const far = [new Float32Array(N).fill(0.1)]
  gateSlot(far, 9e9 + 250_000, RATE, 2)                // 50…70 ms after: shut
  assert.equal(far[0].every((v) => v === 0), true)
  const wrap = [new Float32Array(N).fill(0.1)]
  gateSlot(wrap, 9e9 + 990_000, RATE, 0)              // slot 0's window straddles the second
  assert.equal(wrap[0].every((v) => v !== 0), true)
})
