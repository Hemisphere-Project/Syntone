// node --test — the estimator against a simulated network.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { ClockSync } from '../shared/clock.js'

// Deterministic PRNG (mulberry32) so a failing run can be replayed.
function rng(seed) {
  return () => {
    seed |= 0; seed = (seed + 0x6d2b79f5) | 0
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/**
 * Simulate `seconds` of pinging. The client clock runs `skewPpm` fast and starts `offset` ms
 * behind the server. Each leg takes its base delay plus an exponential queueing tail.
 */
function simulate({ seconds, everyMs, offset, skewPpm, up, down, jitterUp, jitterDown, seed = 1 }) {
  const r = rng(seed)
  const tail = (mean) => -Math.log(1 - r()) * mean
  const cs = new ClockSync()
  const serverOf = (tClient) => tClient * (1 - skewPpm * 1e-6) + offset   // true mapping
  for (let t0 = 0; t0 < seconds * 1000; t0 += everyMs) {
    const dUp = up + tail(jitterUp), dDown = down + tail(jitterDown), proc = 0.2
    const t1 = serverOf(t0) + dUp               // server clock at arrival (skew over a few ms ignored)
    const t2 = t1 + proc
    const t3 = t0 + dUp + proc + dDown
    cs.addSample(t0, t1, t2, t3)
  }
  const tNow = seconds * 1000
  return { cs, err: cs.toServer(tNow) - serverOf(tNow), serverOf, tNow }
}

test('symmetric WiFi: sub-millisecond', () => {
  const { err, cs } = simulate({ seconds: 60, everyMs: 500, offset: 123456.7, skewPpm: 20, up: 3, down: 3, jitterUp: 2, jitterDown: 2 })
  assert.ok(Math.abs(err) < 1, `error ${err.toFixed(3)} ms`)
  assert.ok(Math.abs(cs.stats.skewPpm - -20) < 10, `skew ${cs.stats.skewPpm.toFixed(1)} ppm`)
})

test('jittery LTE, symmetric base delay: a few ms despite 30 ms tails', () => {
  const { err } = simulate({ seconds: 90, everyMs: 1000, offset: -5000, skewPpm: -35, up: 25, down: 25, jitterUp: 30, jitterDown: 15, seed: 7 })
  assert.ok(Math.abs(err) < 4, `error ${err.toFixed(3)} ms`)
})

test('structural asymmetry is NOT removable: the error is half of it, and inside the bound', () => {
  // 40 ms up, 20 ms down, no jitter: every exchange lies by exactly (40-20)/2 = 10 ms.
  const { err, cs } = simulate({ seconds: 30, everyMs: 500, offset: 0, skewPpm: 0, up: 40, down: 20, jitterUp: 0, jitterDown: 0 })
  assert.ok(Math.abs(Math.abs(err) - 10) < 0.01, `error ${err.toFixed(3)} ms`)
  assert.ok(Math.abs(err) <= cs.stats.boundMs, 'the published bound must cover it')
})

test('prediction holds between pings: 50 ppm drift, 30 s without a sample', () => {
  const { cs, serverOf, tNow } = simulate({ seconds: 60, everyMs: 500, offset: 42, skewPpm: 50, up: 5, down: 5, jitterUp: 1, jitterDown: 1, seed: 3 })
  const later = tNow + 30_000
  const err = cs.toServer(later) - serverOf(later)
  assert.ok(Math.abs(err) < 1.5, `error ${err.toFixed(3)} ms after 30 s blind (uncorrected drift would be 1.5 ms)`)
})

test('toClient inverts toServer', () => {
  const { cs } = simulate({ seconds: 40, everyMs: 500, offset: 999, skewPpm: 80, up: 4, down: 4, jitterUp: 1, jitterDown: 1 })
  for (const t of [0, 12345.678, 40_000, 90_000]) assert.ok(Math.abs(cs.toClient(cs.toServer(t)) - t) < 1e-6)
})

test('impossible timestamps are rejected', () => {
  const cs = new ClockSync()
  assert.equal(cs.addSample(10, 0, 50, 20), null)   // server held it longer than the whole round trip
  assert.equal(cs.ready, false)
})
