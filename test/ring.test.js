// node --test — the receiver's timestamped ring buffer.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { FrameRing, seqDelta } from '../shared/ring.js'

const N = 960, frameUs = N * 1e6 / 48000
const frame = (k, n = N) => [Float32Array.from({ length: n }, (_, i) => k + i / 10000)]   // sample value names its frame
const f32 = Math.fround

test('frames land at k·N, in any order; a missing one is a hole of exactly its length', () => {
  const r = new FrameRing({ capacityFrames: 64 })
  const t0 = 5e9
  for (const k of [0, 2, 1, 4]) assert.equal(r.put(100 + k, t0 + k * frameUs, frame(k)), 'ok')
  assert.equal(r.at(0, 0), 0)
  assert.equal(r.at(0, 2 * N + 5), f32(2 + 5 / 10000))
  assert.equal(r.has(3), false)
  assert.equal(r.at(0, 3 * N + 7), 0)
  assert.equal(r.at(0, 4 * N), 4)
  assert.equal(r.covers(0, 3 * N - 1), true)
  assert.equal(r.covers(2 * N, 3 * N), false)
})

test('the capture stamp maps to a stream sample, through the nearest frame', () => {
  const r = new FrameRing({ capacityFrames: 64 })
  const fast = frameUs * (1 - 400e-6)       // a sender running 400 ppm fast: its frames come quicker
  for (let k = 0; k < 50; k++) if (k !== 20) r.put(k, 1e9 + k * fast, frame(k))
  assert.equal(r.indexAt(1e9), 0)
  assert.equal(r.indexAt(1e9 + 30 * fast), 30 * N)
  assert.ok(Math.abs(r.indexAt(1e9 + 20 * fast + 5000) - (20 * N + 5000 / fast * N)) < 1, 'inside a missing frame, from its neighbour')
  assert.ok(Math.abs(r.indexAt(1e9 + 49 * fast + 30_000) - (49 * N + 30_000 * 48000 / 1e6)) < 1, 'past the newest frame')
  assert.equal(new FrameRing().indexAt(1e9), null)
})

test('duplicates, late frames and frames older than the ring are refused', () => {
  const r = new FrameRing({ capacityFrames: 8 })
  for (let k = 0; k < 6; k++) r.put(k, k * frameUs, frame(k))
  assert.equal(r.put(3, 3 * frameUs, frame(3)), 'dup')
  r.release(4)
  assert.equal(r.put(7, 7 * frameUs, frame(7)), 'ok')
  assert.equal(r.put(6, 6 * frameUs, frame(6)), 'ok')
  r.release(7)
  for (let k = 8; k < 20; k++) r.put(k, k * frameUs, frame(k))
  assert.equal(r.has(5), false, 'overwritten by the ring')
  assert.equal(r.at(0, 5 * N), 0)
  assert.equal(r.put(15, 15 * frameUs, frame(15)), 'dup')
  assert.equal(r.put(11, 11 * frameUs, frame(11)), 'stale', 'its slot holds frame 19 now')
  assert.equal(r.put(1, frameUs, frame(1)), 'late')
  assert.equal(r.put(20, NaN, frame(20)), 'bad')
})

test('sequence numbers wrap at 2^32 without a seam', () => {
  assert.equal(seqDelta(2, 0xfffffffe), 4)
  assert.equal(seqDelta(0xfffffffe, 2), -4)
  const r = new FrameRing({ capacityFrames: 16 })
  for (let j = 0; j < 8; j++) assert.equal(r.put((0xfffffffc + j) >>> 0, j * frameUs, frame(j)), 'ok')
  assert.equal(r.at(0, 7 * N), 7)
  assert.equal(r.indexAt(6 * frameUs), 6 * N)
})

test('a new sender (sequence or stamps that do not continue) restarts the stream', () => {
  const r = new FrameRing({ capacityFrames: 16 })
  for (let k = 0; k < 5; k++) r.put(k, k * frameUs, frame(k))
  assert.equal(r.put(5, 5 * frameUs + 10e6, frame(9)), 'restart')     // seq continues, but 10 s later
  assert.equal(r.restarts, 1)
  assert.equal(r.has(0), true)                                          // the new frame is frame 0 now
  assert.equal(r.at(0, 0), 9)
  assert.equal(r.indexAt(5 * frameUs + 10e6), 0)
  assert.equal(r.put(777_777, 11e6, frame(1)), 'restart')               // seq jumps far
  assert.equal(r.restarts, 2)
  assert.equal(r.put(777_778, 11e6 + frameUs + 150, frame(2)), 'ok')    // a little jitter on a stamp is not a restart
})

test('a short frame is padded with silence; a mono frame feeds every channel', () => {
  const r = new FrameRing({ channels: 2, capacityFrames: 4 })
  r.put(0, 0, frame(1, 100))
  assert.equal(r.at(1, 50), f32(1 + 50 / 10000))
  assert.equal(r.at(0, 500), 0)
})
