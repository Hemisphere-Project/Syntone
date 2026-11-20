// node --test — the sender's framer.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Framer } from '../shared/framer.js'

const ramp = (from, len) => Float32Array.from({ length: len }, (_, i) => (from + i) / 1e5)   // value names its sample

test('blocks of any size come out as whole frames, each named by its first sample', () => {
  const f = new Framer({ frameSamples: 960 })
  const frames = []
  let n = 0
  for (const len of [128, 128, 500, 1000, 37, 2000, 128]) { frames.push(...f.push([ramp(n, len)])); n += len }
  assert.equal(f.n, n)
  assert.equal(frames.length, Math.floor(n / 960))
  frames.forEach((fr, k) => {
    assert.equal(fr.n, k * 960)
    assert.equal(fr.seq, k)
    assert.equal(fr.pcm[0].length, 960)
    assert.equal(fr.pcm[0][0], Math.fround(k * 960 / 1e5))
    assert.equal(fr.pcm[0][959], Math.fround((k * 960 + 959) / 1e5))
  })
})

test('a frame handed out is never written again', () => {
  const f = new Framer({ frameSamples: 4 })
  const [a] = f.push([ramp(0, 4)])
  f.push([ramp(4, 4)])
  assert.deepEqual([...a.pcm[0]], [0, 1, 2, 3].map((v) => Math.fround(v / 1e5)))
})

test('a mono block fills every channel; extra channels are left out', () => {
  const st = new Framer({ channels: 2, frameSamples: 4 })
  const [fr] = st.push([Float32Array.of(1, 2, 3, 4)])
  assert.deepEqual([...fr.pcm[1]], [1, 2, 3, 4])
  const mono = new Framer({ channels: 1, frameSamples: 2 })
  const [m] = mono.push([Float32Array.of(1, 2), Float32Array.of(9, 9)])
  assert.equal(m.pcm.length, 1)
  assert.deepEqual([...m.pcm[0]], [1, 2])
})

test('reset starts a new capture at sample 0', () => {
  const f = new Framer({ frameSamples: 4 })
  f.push([ramp(0, 6)])
  f.reset()
  const [fr] = f.push([ramp(100, 4)])
  assert.equal(fr.n, 0)
  assert.equal(fr.pcm[0][0], Math.fround(100 / 1e5))
  assert.equal(f.push([]).length, 0)
})
