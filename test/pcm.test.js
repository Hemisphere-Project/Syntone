// node --test — the PCM fallback codec.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { encodePcm, decodePcm } from '../shared/pcm.js'
import { encodeFrame, decodeFrame, CODEC_PCM, MAX_PAYLOAD } from '../shared/frame.js'

test('16-bit little-endian, interleaved, clipped', () => {
  const b = encodePcm([Float32Array.of(0, 1, -1, 2), Float32Array.of(0.5, -0.5, NaN, -2)])
  const dv = new DataView(b.buffer)
  assert.equal(b.length, 16)
  assert.deepEqual([0, 2, 4, 6, 8, 10, 12, 14].map((o) => dv.getInt16(o, true)), [0, 16384, 32767, -16384, -32768, 0, 32767, -32768])
})

test('round trip within one step of 16 bits', () => {
  const len = 960
  const pcm = [0, 1].map((c) => Float32Array.from({ length: len }, (_, i) => 0.8 * Math.sin(i / (7 + c))))
  const back = decodePcm(encodePcm(pcm), 2)
  for (let c = 0; c < 2; c++) for (let i = 0; i < len; i++) assert.ok(Math.abs(back[c][i] - pcm[c][i]) <= 1 / 32768)
})

test('20 ms of 48 kHz stereo fits one frame, and decodes from a view into it', () => {
  const pcm = [new Float32Array(960).fill(0.25), new Float32Array(960).fill(-0.25)]
  const payload = encodePcm(pcm)
  assert.ok(payload.length <= MAX_PAYLOAD)
  const f = decodeFrame(encodeFrame({ seq: 3, captureUs: 1e9, payload, codec: CODEC_PCM }))
  const back = decodePcm(f.payload, 2)
  assert.equal(back[0][959], 0.25)
  assert.equal(back[1][0], -0.25)
})

test('a payload that does not divide into whole samples is refused', () => {
  assert.equal(decodePcm(new Uint8Array(6), 2), null)
  assert.equal(decodePcm(new Uint8Array(4), 0), null)
})
