// node --test — the scheduler's planning, run like the page runs it: one pass every 200 ms.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { planBeats } from '../shared/beats.js'

/** Run `seconds` of passes with perfect clocks and a device heard `corrMs` late. */
function run({ corrMs, seconds = 60, passMs = 200, period = 1000, offset = 0, jitter = 0 }) {
  // relay time == perf time; context time 0 at perf 5000; the device needs samples corrMs early
  const whenOf = (serverT) => (serverT - corrMs - 5000) / 1000
  let lastBeat = -1, skipped = 0
  const played = new Map()
  for (let now = 10_000, i = 0; now < 10_000 + seconds * 1000; now += passMs + ((i++ * 37) % (jitter + 1))) {
    const r = planBeats({ nowS: now, lastBeat, period, offset, whenOf, ctxNow: (now - 5000) / 1000 })
    lastBeat = r.lastBeat; skipped += r.skipped
    for (const b of r.beats) {
      assert.ok(!played.has(b.k), `beat ${b.k} queued twice`)
      assert.ok(b.when >= (now - 5000) / 1000 + 0.005, `beat ${b.k} queued too late`)
      played.set(b.k, b)
    }
  }
  return { played: played.size, skipped }
}

test('every beat is queued exactly once, whatever the output latency', () => {
  for (const corrMs of [0, 20, 250, 495, 500, 650, 700, 800, 1500, 2000]) {
    const { played, skipped } = run({ corrMs })
    assert.ok(played >= 58, `corr ${corrMs} ms: only ${played} beats of ~60`)
    assert.equal(skipped, 0, `corr ${corrMs} ms: ${skipped} skipped`)
  }
})

test('a negative trim (device heard early) still plays every beat', () => {
  for (const corrMs of [-50, -300, -900]) assert.ok(run({ corrMs }).played >= 58, `corr ${corrMs}`)
})

test('slot offsets and uneven passes change nothing', () => {
  for (const offset of [0, 100, 700]) assert.ok(run({ corrMs: 300, offset, jitter: 90 }).played >= 58)
})

test('a beat that cannot be on time is skipped and counted, never played late', () => {
  const whenOf = (serverT) => (serverT - 5000) / 1000
  // first pass, 0.4 s after beat 10: it reaches 0.7 s ahead; then the page stalls for 2.6 s
  let r = planBeats({ nowS: 10_400, lastBeat: -1, period: 1000, offset: 0, whenOf, ctxNow: 5.4 })
  assert.deepEqual(r.beats.map((b) => b.k), [11])   // 10 has gone by: not counted as a skip after a reset
  assert.equal(r.skipped, 0)
  r = planBeats({ nowS: 13_050, lastBeat: r.lastBeat, period: 1000, offset: 0, whenOf, ctxNow: 8.05 })
  assert.equal(r.skipped, 2)                        // 12 and 13 went by during the stall
  assert.deepEqual(r.beats.map((b) => b.k), [])     // 14 is still beyond the lead
})

test('a clock that is not ready (NaN) queues nothing and does not loop', () => {
  const r = planBeats({ nowS: NaN, lastBeat: -1, period: 1000, offset: 0, whenOf: () => NaN, ctxNow: 1 })
  assert.deepEqual(r.beats, [])
})
