// node --test — capture stamps against a simulated sender.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { CaptureStamper } from '../shared/stamps.js'

function rng(seed) {
  return () => {
    seed |= 0; seed = (seed + 0x6d2b79f5) | 0
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/**
 * A sender whose sound card runs `ppm` fast, capturing 128-sample blocks. Each block is seen
 * `floorMs` + an exponential tail late, with a rare long stall. Frames of 960 samples are stamped
 * as they complete. Returns every frame's stamp next to its truth (capture time + floor).
 */
function simulate({ seconds, ppm, floorMs = 5, jitterMs = 2, stallEvery = 0.002, startUs = 7_000_000_000, seed = 1, loseAt = Infinity, lose = 0, opts = {} }) {
  const r = rng(seed)
  const st = new CaptureStamper(opts)
  const usPer = 1e6 / (48000 * (1 + ppm * 1e-6))
  const frames = []
  let captured = 0, stamped = 0, lost = 0
  for (let block = 0; captured < seconds * 48000; block++) {
    captured += 128
    const t = startUs + captured * usPer                      // relay time sample n = captured (the next one) enters
    if (t - startUs >= loseAt * 1e6 && !lost) { lost = lose }  // the capture path dropped samples
    const late = floorMs * 1000 + -Math.log(1 - r()) * jitterMs * 1000 + (r() < stallEvery ? 40_000 : 0)
    st.observe(captured - lost, t + late)
    while (stamped + 960 <= captured - lost) {
      const s = st.stampOf(stamped)
      const truth = startUs + (stamped + lost) * usPer + floorMs * 1000
      frames.push({ n: stamped, s, truth, t: t - startUs })
      stamped += 960
    }
  }
  return { st, frames, usPer }
}

test('stamps land on the capture timeline, not on the callback jitter', () => {
  const { frames } = simulate({ seconds: 60, ppm: 0 })
  const settled = frames.filter((f) => f.t > 5e6)
  const worst = Math.max(...settled.map((f) => Math.abs(f.s - f.truth)))
  assert.ok(worst < 300, `worst stamp error ${worst.toFixed(0)} µs`)
})

test("the sender's real rate is measured, and the stamps advance at it", () => {
  for (const ppm of [-400, 120, 416]) {
    const { st, frames, usPer } = simulate({ seconds: 90, ppm, seed: 3 })
    assert.ok(Math.abs(st.stats.ratePpm - ppm) < 10, `${ppm}: measured ${st.stats.ratePpm.toFixed(1)} ppm`)
    const late = frames.filter((f) => f.t > 60e6)
    const worst = Math.max(...late.map((f) => Math.abs(f.s - f.truth)))
    assert.ok(worst < 300, `${ppm}: worst stamp error ${worst.toFixed(0)} µs`)
    // frame to frame, the stamps run at the real rate; a refit is absorbed at no more than the slew (50 ppm)
    const off = Math.max(...late.slice(1).map((f, i) => Math.abs((f.s - late[i].s) / (960 * usPer) - 1) * 1e6))
    assert.ok(off <= 51, `${ppm}: frame to frame up to ${off.toFixed(1)} ppm off the real rate`)
  }
})

test('after the first second, stamps never jump while the fit settles: every frame within the slew of the last', () => {
  const { st, frames } = simulate({ seconds: 60, ppm: 250, jitterMs: 6, seed: 9 })
  const frameUs = 960 * 1e6 / 48000
  const run = frames.filter((f) => f.t > 1.1e6)     // the first bin is a warm-up: stamps follow its minimum freely
  const worst = Math.max(...run.slice(1).map((f, i) => Math.abs((f.s - run[i].s) / frameUs - 1) * 1e6))
  assert.ok(worst < 250 + 50 + 10, `worst frame-to-frame rate ${worst.toFixed(0)} ppm off nominal`)   // its real rate + the slew
  assert.equal(st.stats.jumps, 0)
})

test('lost capture samples are a step: detected within a few seconds, then the stamps rejoin', () => {
  const { st, frames } = simulate({ seconds: 60, ppm: 50, loseAt: 30, lose: 4800, seed: 5 })
  assert.equal(st.stats.steps, 1)
  assert.equal(st.stats.jumps, 1)
  const after = frames.filter((f) => f.t > 35e6)
  const worst = Math.max(...after.map((f) => Math.abs(f.s - f.truth)))
  assert.ok(worst < 500, `after the step: worst ${worst.toFixed(0)} µs`)
})

test('refuses what cannot be a capture', () => {
  const st = new CaptureStamper()
  assert.equal(st.ready, false)
  assert.equal(st.stampOf(0), null)
  assert.equal(st.observe(NaN, 1), false)
  assert.equal(st.observe(1000, Infinity), false)
  assert.equal(st.observe(1000, 5_000_000), true)
  assert.equal(st.observe(500, 5_010_000), false)            // the count went backwards
  assert.equal(st.ready, true)
  assert.ok(Math.abs(st.stampOf(1000) - 5_000_000) < 1)       // one observation: an offset, nominal rate
})
