// node --test — the receiver core: frames from the relay → decoder → (test gate) → the player's port.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { ReceiverCore, PcmDecoder, clockLine, lineMoved } from '../shared/receiver.js'
import { encodeFrame, CODEC_OPUS, CODEC_PCM } from '../shared/frame.js'
import { encodePcm } from '../shared/pcm.js'
import { writeClicks } from '../shared/streamclicks.js'

const RATE = 48000, N = 960
const frameAt = (seq, captureUs, pcm, codec = CODEC_PCM) => encodeFrame({ seq, captureUs, codec, payload: encodePcm(pcm) })

test('PCM frames reach the player with their stamp, and gaps are counted', () => {
  const posted = []
  const core = new ReceiverCore({ decoder: new PcmDecoder({ channels: 1 }), post: (m) => posted.push(m) })
  for (const seq of [10, 11, 14, 12, 15]) core.frame(frameAt(seq, seq * 20_000, [new Float32Array(N).fill(0.5)]).buffer)
  assert.equal(posted.length, 5)
  assert.deepEqual(posted.map((m) => m.seq), [10, 11, 14, 12, 15])
  assert.equal(posted[2].captureUs, 280_000)
  assert.ok(Math.abs(posted[0].pcm[0][5] - 0.5) < 1e-4)
  assert.equal(core.stats.received, 5)
  assert.equal(core.stats.lost, 1)          // 13; 12 came late and filled its own gap
  assert.equal(core.stats.reordered, 1)
})

test('frames of another codec and garbage are refused, not decoded', () => {
  const posted = []
  const core = new ReceiverCore({ decoder: new PcmDecoder(), post: (m) => posted.push(m) })
  core.frame(encodeFrame({ seq: 1, captureUs: 0, codec: CODEC_OPUS, payload: new Uint8Array(40) }))
  core.frame(new Uint8Array([9, 9, 9]))
  core.frame(encodeFrame({ seq: 2, captureUs: 0, codec: CODEC_PCM, payload: new Uint8Array(3) }))   // odd length: not PCM
  assert.equal(posted.length, 0)
  assert.equal(core.stats.otherCodec, 1)
  assert.equal(core.stats.bad, 1)
  assert.equal(core.stats.decodeErrors, 1)
})

test('a decoder that answers later still hands each frame its own stamp', () => {
  const posted = [], queue = []
  const late = { codec: CODEC_OPUS, output: null, decode(f) { queue.push(f) } }
  const core = new ReceiverCore({ decoder: late, post: (m) => posted.push(m) })
  for (let s = 0; s < 3; s++) core.frame(encodeFrame({ seq: s, captureUs: 1e6 + s * 20_000, codec: CODEC_OPUS, payload: new Uint8Array(60) }))
  assert.equal(posted.length, 0)
  for (const f of queue) late.output({ seq: f.seq, captureUs: f.captureUs, pcm: [new Float32Array(N)] })
  assert.deepEqual(posted.map((m) => m.captureUs), [1e6, 1.02e6, 1.04e6])
})

test('test mode keeps only this receiver\'s slot of the stream click pattern', () => {
  const run = (slot) => {
    const posted = []
    const core = new ReceiverCore({ decoder: new PcmDecoder(), post: (m) => posted.push(m), testSlot: slot })
    const t0 = 5_000_000_000                           // µs on the relay clock: a whole second
    for (let k = 0; k < 50; k++) {                     // one second: every slot's burst once
      const pcm = [new Float32Array(N)]
      writeClicks(pcm, t0 + k * 20_000, RATE, { slots: 8 })
      core.frame(frameAt(k, t0 + k * 20_000, pcm))
    }
    // where is there sound, in ms after the second began?
    const loud = []
    for (const m of posted) m.pcm[0].forEach((v, i) => { if (Math.abs(v) > 0.01) loud.push((m.captureUs - t0) / 1000 + i * 1000 / RATE) })
    return loud
  }
  const s0 = run(0), s3 = run(3)
  assert.ok(s0.length > 0 && s3.length > 0)
  assert.ok(Math.min(...s0) < 20 && Math.max(...s0) < 100, `slot 0 sounds at ${Math.min(...s0)}…${Math.max(...s0)} ms`)
  assert.ok(Math.min(...s3) >= 280 && Math.max(...s3) < 400, `slot 3 sounds at ${Math.min(...s3)}…${Math.max(...s3)} ms`)
})

test('clockLine: the relay clock as a line on context time, rate included', () => {
  const skew = 35e-6, offset = 1234.5
  const toServer = (p) => p * (1 + skew) + offset
  const l = clockLine(2000, 10_000, toServer)
  assert.equal(l.type, 'clock')
  assert.ok(Math.abs(l.timelineMs - toServer(12_000)) < 1e-6)
  assert.ok(Math.abs(l.rate - (1 + skew)) < 1e-9)
  const at = (ctx) => l.timelineMs + (ctx - l.ctxMs) * l.rate
  assert.ok(Math.abs(at(9000) - toServer(19_000)) < 1e-6)
  assert.equal(lineMoved(l, l, 5000), false)
  assert.equal(lineMoved(l, { ...l, timelineMs: l.timelineMs + 1 }, 5000), true)
  assert.equal(lineMoved(null, l, 0), true)
})
