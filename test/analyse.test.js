// node --test — the click analyser against a synthetic recording with known offsets.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { analyse } from '../lab/analyse-clicks.mjs'
import { PERIOD_MS, STAGGER_MS, BURST_MS, slotFreq } from '../shared/clicks.js'

function synth({ sr = 48000, seconds = 20, devices, noise = 0.02, seed = 5 }) {
  let s = seed
  const rnd = () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296 - 0.5 }
  const x = new Float32Array(sr * seconds)
  for (let i = 0; i < x.length; i++) x[i] = noise * 2 * rnd()
  const n = Math.round((BURST_MS / 1000) * sr), fade = Math.round(n * 0.25)
  for (const d of devices) {
    for (let k = 1; k < seconds - 1; k++) {
      const jitter = (d.jitterMs || 0) * 2 * rnd()
      const drift = (d.driftMsPerMin || 0) * (k / 60)
      const t = (k * PERIOD_MS + d.slot * STAGGER_MS + d.offsetMs + jitter + drift) / 1000 + 0.2345   // recorder started at an arbitrary instant
      const start = Math.round(t * sr)
      for (let i = 0; i < n; i++) {
        const env = i > n - fade ? (n - i) / fade : 1
        x[start + i] += (d.gain ?? 0.5) * env * Math.sin((2 * Math.PI * slotFreq(d.slot) * i) / sr)
      }
    }
  }
  return { x, sr }
}

test('recovers known offsets between three devices', () => {
  const { x, sr } = synth({ devices: [{ slot: 0, offsetMs: 0 }, { slot: 1, offsetMs: 7.5 }, { slot: 3, offsetMs: -22, gain: 0.2 }] })
  const res = analyse(x, sr)
  assert.equal(res.ref, 0)
  assert.deepEqual(res.slots.map((s) => s.slot), [0, 1, 3])
  const by = Object.fromEntries(res.slots.map((s) => [s.slot, s]))
  assert.ok(Math.abs(by[0].medianMs) < 0.05)
  assert.ok(Math.abs(by[1].medianMs - 7.5) < 0.15, `slot 1: ${by[1].medianMs}`)
  assert.ok(Math.abs(by[3].medianMs - -22) < 0.15, `slot 3: ${by[3].medianMs}`)
})

test('reports jitter as spread and a drifting device as drift', () => {
  const { x, sr } = synth({ seconds: 40, devices: [{ slot: 0, offsetMs: 0 }, { slot: 2, offsetMs: 3, jitterMs: 4 }, { slot: 4, offsetMs: 0, driftMsPerMin: 12 }] })
  const by = Object.fromEntries(analyse(x, sr).slots.map((s) => [s.slot, s]))
  assert.ok(by[2].spreadMs > 3 && by[2].spreadMs < 9, `spread ${by[2].spreadMs}`)
  assert.ok(Math.abs(by[4].driftMsPerMin - 12) < 1.5, `drift ${by[4].driftMsPerMin}`)
  assert.ok(Math.abs(by[0].spreadMs) < 0.1)
  assert.ok(by[2].wanderMs > 2 && by[4].wanderMs < 0.6, `wander: jittery ${by[2].wanderMs}, drifting ${by[4].wanderMs}`)
})

test('neighbouring pitches do not create a ghost device (a burst leaks into the next filter)', () => {
  for (const sr of [44100, 48000]) {
    const { x } = synth({ sr, seconds: 30, devices: [{ slot: 0, offsetMs: 0, jitterMs: 0.2 }, { slot: 1, offsetMs: 7.5, jitterMs: 0.6 }, { slot: 2, offsetMs: -3.2, jitterMs: 1.5 }] })
    const res = analyse(x, sr)
    assert.deepEqual(res.slots.map((s) => s.slot), [0, 1, 2], `at ${sr} Hz`)
  }
})

test('a quiet device next to a loud one is still heard', () => {
  const { x, sr } = synth({ devices: [{ slot: 0, offsetMs: 0, gain: 0.8 }, { slot: 1, offsetMs: 4, gain: 0.08 }], noise: 0.005 })
  const by = Object.fromEntries(analyse(x, sr).slots.map((s) => [s.slot, s]))
  assert.ok(by[1] && Math.abs(by[1].medianMs - 4) < 0.3, JSON.stringify(by[1]))
  assert.equal(Object.keys(by).length, 2)
})

test('silence gives no devices rather than a made-up one', () => {
  const res = analyse(new Float32Array(48000 * 3), 48000)
  assert.deepEqual(res.slots, [])
})
