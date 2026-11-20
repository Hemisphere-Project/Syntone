// node --test — the receiver's player, on simulated clocks.
//
// Each test is a vector in the sense of docs/architecture.md §6: these frames (a sender's rate,
// what the network loses or delays), this clock trace (the device's clock against the timeline,
// its jitter), those output positions (where the read head must be, block after block).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { FrameRing } from '../shared/ring.js'
import { Player } from '../shared/player.js'

const N = 960, RS = 48000

/**
 * A sender, a network and a device, all on simulated clocks. The sender's frame k is captured at
 * c0 + k·N/(RS·(1 + senderPpm)) on the timeline (its stamps are taken as exact: stamps.test.js
 * proves those); it arrives `transitMs` later, plus whatever `delayOf(k)` adds; `lost(k)` never
 * arrives. The device hands block j to its audio system at local time j·block/outRate, and its
 * clock reads timeline time as local·(1 + devicePpm·1e-6) + offset (+ jitter, + any step).
 */
function bench({ outRate = 48000, block = 128, delayMs = 150, latencyMs = 30, senderPpm = 0, devicePpm = 0,
  transitMs = 60, lost = () => false, delayOf = () => 0, signal = (s) => s / 2 ** 20, jitterMs = 0, opts = {} } = {}) {
  const ring = new FrameRing({ channels: 1, capacityFrames: 512 })
  const c0 = 1_000_000                                       // timeline ms of frame 0's capture
  const frameMs = N / RS * 1000 / (1 + senderPpm * 1e-6)
  const clock = { offset: c0 + 500, stepMs: 0 }
  let seed = 7
  const noise = () => { seed = (seed * 1103515245 + 12345) >>> 0; return (seed / 2 ** 32 - 0.5) * 2 * jitterMs }
  const timeBase = { toTimeline: (local) => local * (1 + devicePpm * 1e-6) + clock.offset + clock.stepMs + noise() }
  const latency = { ms: latencyMs }
  const player = new Player({ ring, rate: outRate, timeBase, latency, delayMs, ...opts })
  let sent = 0, j = 0, muted = false
  const out = [new Float32Array(block)]
  const trueTimeline = (local) => local * (1 + devicePpm * 1e-6) + clock.offset + clock.stepMs
  return {
    ring, player, latency, clock, out,
    mute() { muted = true },
    /** where the read head must be at block j: the stream sample captured at heard − D */
    expected(local) { return (trueTimeline(local) + latency.ms - player.delayMs - c0) / frameMs * N },
    /** one block: frames that have arrived are put, then the player renders */
    step() {
      const local = j * block / outRate * 1000
      const now = trueTimeline(local)
      for (; !muted;) {
        const k = sent
        const at = c0 + k * frameMs + transitMs
        if (at > now) break
        sent++
        if (lost(k)) continue
        if (delayOf(k)) { pending.push([k, at + delayOf(k)]); continue }
        put(k)
      }
      for (let i = pending.length - 1; i >= 0; i--) if (pending[i][1] <= now) { put(pending[i][0]); pending.splice(i, 1) }
      player.render(out, local)
      j++
      return { local, before: player.blockStart }
    },
    get seconds() { return j * block / outRate },
  }
  function put(k) {
    const pcm = new Float32Array(N)
    for (let i = 0; i < N; i++) pcm[i] = signal(k * N + i)
    statuses.push(ring.put(k, (c0 + k * frameMs) * 1000, [pcm]))
  }
}
const pending = [], statuses = []

test('the read head sits on capture + D − L from the first block, and each sample is the stream at its place', () => {
  const b = bench()
  let worst = 0, checked = 0
  while (b.seconds < 2) {
    const { local, before } = b.step()
    if (!b.player.locked) continue
    const want = b.expected(local)
    worst = Math.max(worst, Math.abs(before - want))
    // the signal is the stream sample number itself: the first output sample says where it read
    if (b.ring.covers(Math.floor(want) - 1, Math.floor(want) + 2)) {
      assert.ok(Math.abs(b.out[0][0] * 2 ** 20 - before) < 0.02, `sample ${b.out[0][0] * 2 ** 20} read at ${before}`)
      checked++
    }
  }
  assert.ok(worst < 0.01, `read head off by ${worst} samples`)
  assert.ok(checked > 600)
  assert.equal(b.player.stats.jumps, 0)
  assert.equal(b.player.stats.dropouts, 0)
})

test('a 44.1 kHz device reads 48 kHz frames at 48000/44100 per output sample, on time', () => {
  const b = bench({ outRate: 44100 })
  let worst = 0
  while (b.seconds < 3) {
    const { local, before } = b.step()
    if (b.player.locked) worst = Math.max(worst, Math.abs(before - b.expected(local)))
  }
  assert.ok(worst < 0.05, `off by ${worst} samples`)
  assert.equal(b.player.stats.dropouts, 0)
})

test('crystals 80 ppm apart are followed gently: the rate learns them, the error stays under a millisecond', () => {
  for (const [devicePpm, senderPpm] of [[80, 0], [-60, 25]]) {
    const b = bench({ devicePpm, senderPpm })
    let worstMs = 0, worstPpm = 0
    while (b.seconds < 120) {
      const { local, before } = b.step()
      const errMs = Math.abs(before - b.expected(local)) / RS * 1000
      worstMs = Math.max(worstMs, errMs)
      if (b.seconds > 10) worstPpm = Math.max(worstPpm, Math.abs(b.player.stats.ppm - (devicePpm + senderPpm)))
    }
    assert.ok(worstMs < 1, `${devicePpm}/${senderPpm} ppm: error reached ${worstMs.toFixed(3)} ms`)
    assert.ok(worstPpm < 20, `${devicePpm}/${senderPpm} ppm: correction strayed ${worstPpm.toFixed(1)} ppm from the drift`)
    assert.ok(Math.abs(b.player.stats.driftPpm - (devicePpm + senderPpm)) < 3, `drift learnt ${b.player.stats.driftPpm.toFixed(2)}`)
    assert.equal(b.player.stats.jumps, 0)
  }
})

test('a jittery time base (±2 ms per block) does not wobble the rate beyond tens of ppm', () => {
  const b = bench({ jitterMs: 2, devicePpm: 40 })
  let worstPpm = 0, worstMs = 0
  while (b.seconds < 90) {
    const { local, before } = b.step()
    if (b.seconds > 15) {
      worstPpm = Math.max(worstPpm, Math.abs(b.player.stats.ppm - 40))
      worstMs = Math.max(worstMs, Math.abs(before - b.expected(local)) / RS * 1000)
    }
  }
  assert.ok(worstPpm < 30, `rate strayed ${worstPpm.toFixed(1)} ppm`)
  assert.ok(worstMs < 1.5, `error ${worstMs.toFixed(2)} ms`)
  assert.equal(b.player.stats.jumps, 0)
})

test('a 10 ms change of D is recovered by slewing, never past ±500 ppm, never a jump; under 2 ms, only gently', () => {
  const b = bench()
  while (b.seconds < 5) b.step()
  b.player.delayMs = 160
  let maxPpm = 0, gentleMax = 0, t2 = null, t1 = null
  while (b.seconds < 135) {
    const { local, before } = b.step()
    const errMs = Math.abs(before - b.expected(local)) / RS * 1000
    maxPpm = Math.max(maxPpm, Math.abs(b.player.stats.ppm))
    if (t2 === null && errMs < 2) t2 = b.seconds - 5
    if (t1 === null && errMs < 1) t1 = b.seconds - 5
    if (t2 !== null && b.seconds - 5 > t2 + 2) gentleMax = Math.max(gentleMax, Math.abs(b.player.stats.ppm))
  }
  assert.ok(maxPpm <= 500 && maxPpm > 400, `peak correction ${maxPpm.toFixed(0)} ppm`)
  assert.ok(t2 !== null && t2 < 40, `within 2 ms after ${t2} s`)
  assert.ok(gentleMax < 15.5, `under 2 ms the correction reached ${gentleMax.toFixed(1)} ppm`)
  assert.ok(t1 !== null && t1 < 120, `within 1 ms after ${t1} s`)
  assert.equal(b.player.stats.jumps, 0)
})

test('a clock step of 50 ms is one crossfaded jump, without a click', () => {
  const tone = (s) => Math.sin(2 * Math.PI * 440 * s / RS) * 0.5
  const b = bench({ signal: tone })
  while (b.seconds < 3) b.step()
  b.clock.stepMs = 50
  let prev = b.out[0][127], worstStep = 0, worst = 0
  while (b.seconds < 4) {
    const { local, before } = b.step()
    for (const v of b.out[0]) { worstStep = Math.max(worstStep, Math.abs(v - prev)); prev = v }
    if (b.seconds > 3.1) worst = Math.max(worst, Math.abs(before - b.expected(local)))
  }
  assert.equal(b.player.stats.jumps, 1)
  assert.ok(worst < 1, `after the jump, off by ${worst} samples`)
  // a 440 Hz tone at 0.5 moves at most 0.029 per sample; a cut would move up to 1
  assert.ok(worstStep < 0.08, `largest sample-to-sample step ${worstStep.toFixed(3)}`)
})

test('lost and late frames play as silence, the read head moves on, and playback resumes exactly on time', () => {
  pending.length = 0; statuses.length = 0
  const lost = (k) => k >= 100 && k < 110
  const delayOf = (k) => (k >= 200 && k < 230 ? 1000 : 0)   // 30 frames arrive a second late
  const b = bench({ lost, delayOf })
  let worst = 0, silent = 0, wrong = 0
  while (b.seconds < 8) {
    const { local, before } = b.step()
    if (!b.player.locked) continue
    worst = Math.max(worst, Math.abs(before - b.expected(local)))
    const k = Math.floor(before / N)
    const hole = lost(k) || (k >= 200 && k < 230)
    if (hole && Math.floor((before + 130) / N) === k && Math.floor(before / N) === Math.floor((before - 2) / N)) {
      if (b.out[0].every((v) => v === 0)) silent++; else wrong++
    }
    if (!hole && b.ring.covers(Math.floor(before) - 1, Math.floor(before) + 130)) {
      if (Math.abs(b.out[0][0] * 2 ** 20 - before) > 0.05) wrong++
    }
  }
  assert.ok(worst < 0.01, `read head off by ${worst} samples`)
  assert.equal(wrong, 0)
  assert.ok(silent > 200, `${silent} silent blocks`)
  assert.equal(b.player.stats.dropouts, 40)
  assert.equal(statuses.filter((s) => s === 'late').length, 30, 'the late frames are refused, not played out of place')
  assert.equal(b.player.stats.jumps, 0)
  pending.length = 0; statuses.length = 0
})

test('a new sender (its stamps do not continue the stream) is one jump onto its timeline', () => {
  const b = bench()
  while (b.seconds < 2) b.step()
  b.mute()
  // the stream restarts: same timeline, new sequence numbers far away, its own frame 0 now
  const ring = b.ring
  const nowMs = 1_000_500 + b.seconds * 1000
  const restartAt = nowMs - 150 + 30 - 100       // captured 100 ms before what is being heard
  for (let k = 0; k < 40; k++) {
    const pcm = new Float32Array(N).fill(0.25)
    ring.put(90_000 + k, (restartAt + k * 20) * 1000, [pcm])
  }
  assert.equal(ring.restarts, 1)
  for (let i = 0; i < 40; i++) b.step()
  assert.equal(b.player.stats.jumps, 1)
  assert.ok(Math.abs(b.out[0][64] - 0.25) < 1e-6, 'playing the new sender')
})
