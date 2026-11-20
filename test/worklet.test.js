// node --test — the AudioWorklet processor, smoke-tested with the worklet globals stubbed.
import { test } from 'node:test'
import assert from 'node:assert/strict'

const registered = {}
globalThis.sampleRate = 48000
globalThis.currentTime = 0
globalThis.AudioWorkletProcessor = class { constructor() { this.port = { sent: [], postMessage(m) { this.sent.push(m) } } } }
globalThis.registerProcessor = (name, cls) => { registered[name] = cls }
await import('../web/js/player-worklet.js')

test('frames in through the port, the stream out on time, stats back', () => {
  const Proc = registered['syntone-player']
  assert.ok(Proc, 'registered as syntone-player')
  const p = new Proc({ processorOptions: { channels: 1, delayMs: 150, latencyMs: 30 } })
  const send = (data) => p.port.onmessage({ data })
  const out = [new Float32Array(128), new Float32Array(128)]
  p.process([], [out])
  assert.ok(out[0].every((v) => v === 0), 'silence before any time base')

  // context time 0 is timeline 10 000 ms; frames captured from timeline 9 800 ms, 20 ms each
  send({ type: 'clock', ctxMs: 0, timelineMs: 10_000, rate: 1 })
  for (let k = 0; k < 50; k++) {
    const pcm = new Float32Array(960)
    for (let i = 0; i < 960; i++) pcm[i] = (k * 960 + i) / 2 ** 20
    send({ type: 'frame', seq: 7000 + k, captureUs: (9_800 + k * 20) * 1000, pcm: [pcm] })
  }
  send({ type: 'frame', seq: 7003, captureUs: 9_860_000, pcm: [new Float32Array(960)] })
  assert.equal(p.frames.ok, 50)
  assert.equal(p.frames.dup, 1)

  for (let b = 0; b < 300; b++) {
    globalThis.currentTime = b * 128 / 48000
    p.process([], [out])
    // heard at timeline 10 000 + t + 30, playing capture 10 000 + t + 30 − 150 = 9 880 + t: stream sample (80 + t)·48
    const want = (80 + currentTime * 1000) * 48
    assert.ok(Math.abs(out[0][0] * 2 ** 20 - want) < 0.05, `block ${b}: read ${out[0][0] * 2 ** 20}, want ${want}`)
    assert.equal(out[1][0], out[0][0], 'a mono stream feeds both outputs')
  }
  const stats = p.port.sent.filter((m) => m.type === 'stats')
  assert.equal(stats.length, 3, "four a second")
  const last = stats.at(-1)
  assert.equal(last.locked, true)
  assert.equal(last.jumps, 0)
  assert.ok(Math.abs(last.errorMs) < 0.01)

  // D and L come in through the port too: 50 ms more of D is one jump back by 50 ms
  send({ type: 'delay', ms: 200 })
  for (let b = 300; b < 310; b++) { globalThis.currentTime = b * 128 / 48000; p.process([], [out]) }
  assert.equal(p.player.stats.jumps, 1)
  assert.ok(Math.abs(p.player.blockStart - (30 + currentTime * 1000) * 48) < 0.05)
})
