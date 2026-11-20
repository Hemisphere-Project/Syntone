// node --test — the audio frame: what the sender writes is what every receiver reads.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { encodeFrame, decodeFrame, seqDiff, HEADER_BYTES, MAX_PAYLOAD, FRAME_AUDIO, CODECS, CODEC_OPUS, CODEC_PCM } from '../shared/frame.js'

const bytes = (n, seed = 1) => Uint8Array.from({ length: n }, (_, i) => (i * 31 + seed) & 0xff)

test('round trip: sequence number, capture time, codec and payload come back unchanged', () => {
  const week = 7 * 24 * 3600 * 1e6                          // a relay up for a week, in µs
  for (const [seq, captureUs, codec] of [[0, 0, CODEC_OPUS], [1, 1, CODEC_PCM], [0xffffffff, week, CODEC_OPUS], [123456, -2500, CODEC_PCM], [42, Number.MAX_SAFE_INTEGER, CODEC_OPUS]]) {
    const payload = bytes(160, seq & 0xff)
    const f = encodeFrame({ seq, captureUs, codec, payload })
    assert.equal(f.length, HEADER_BYTES + payload.length)
    const d = decodeFrame(f)
    assert.deepEqual({ type: d.type, seq: d.seq, captureUs: d.captureUs, codec: d.codec }, { type: FRAME_AUDIO, seq, captureUs, codec })
    assert.deepEqual(d.payload, payload)
  }
})

test('the header layout is fixed: type, big-endian µs capture time, big-endian sequence number, codec', () => {
  const f = encodeFrame({ seq: 0x01020304, captureUs: 0x0a0b0c0d, codec: CODEC_PCM, payload: Uint8Array.of(0xee) })
  assert.deepEqual([...f], [1, 0, 0, 0, 0, 0x0a, 0x0b, 0x0c, 0x0d, 1, 2, 3, 4, 2, 0xee])
})

test('the frame names its codec: Opus unless said otherwise, by the ids a room and a device use', () => {
  assert.deepEqual(CODECS, { opus: 1, pcm: 2 })
  assert.equal(decodeFrame(encodeFrame({ seq: 0, captureUs: 0, payload: bytes(4) })).codec, CODECS.opus)
  assert.equal(decodeFrame(encodeFrame({ seq: 0, captureUs: 0, codec: CODECS.pcm, payload: bytes(4) })).codec, CODECS.pcm)
})

test('capture times are whole microseconds', () => {
  assert.equal(decodeFrame(encodeFrame({ seq: 0, captureUs: 1234.6, payload: bytes(4) })).captureUs, 1235)
})

test('decodes a Node Buffer that is a slice of a larger pool, and an ArrayBuffer, without copying', () => {
  const f = encodeFrame({ seq: 7, captureUs: 99, payload: bytes(50) })
  const pool = Buffer.alloc(f.length + 37)
  pool.set(f, 37)
  const d = decodeFrame(pool.subarray(37))
  assert.equal(d.seq, 7); assert.equal(d.captureUs, 99)
  assert.deepEqual([...d.payload], [...bytes(50)])
  assert.equal(d.payload.buffer, pool.buffer, 'the payload is a view, not a copy')
  assert.equal(decodeFrame(f.buffer.slice(0)).seq, 7)
})

test('refuses what is not a frame', () => {
  const ok = encodeFrame({ seq: 1, captureUs: 1, payload: bytes(10) })
  assert.equal(decodeFrame(ok.subarray(0, HEADER_BYTES)), null, 'header without payload')
  assert.equal(decodeFrame(Uint8Array.of(1, 2, 3)), null, 'too short')
  assert.equal(decodeFrame(Uint8Array.of(9, ...ok.subarray(1))), null, 'unknown type')
  for (const codec of [0, 3, 255]) {
    const bad = ok.slice(); bad[13] = codec
    assert.equal(decodeFrame(bad), null, `unknown codec ${codec}`)
  }
  assert.equal(decodeFrame(new Uint8Array(HEADER_BYTES + MAX_PAYLOAD + 1).fill(1, 0, 1)), null, 'too large')
  assert.equal(decodeFrame('a string'), null)
  assert.equal(decodeFrame(null), null)
  assert.ok(decodeFrame(encodeFrame({ seq: 1, captureUs: 1, payload: bytes(MAX_PAYLOAD) })), 'the largest payload passes')
})

test('encode refuses values the header cannot carry', () => {
  assert.throws(() => encodeFrame({ seq: -1, captureUs: 0, payload: bytes(1) }), RangeError)
  assert.throws(() => encodeFrame({ seq: 2 ** 32, captureUs: 0, payload: bytes(1) }), RangeError)
  assert.throws(() => encodeFrame({ seq: 1.5, captureUs: 0, payload: bytes(1) }), RangeError)
  assert.throws(() => encodeFrame({ seq: 0, captureUs: NaN, payload: bytes(1) }), RangeError)
  assert.throws(() => encodeFrame({ seq: 0, captureUs: 0, payload: bytes(MAX_PAYLOAD + 1) }), RangeError)
  assert.throws(() => encodeFrame({ seq: 0, captureUs: 0, payload: [1, 2] }), RangeError)
  assert.throws(() => encodeFrame({ seq: 0, captureUs: 0, codec: 0, payload: bytes(1) }), RangeError)
  assert.throws(() => encodeFrame({ seq: 0, captureUs: 0, codec: 'opus', payload: bytes(1) }), RangeError)
})

test('seqDiff counts across the uint32 wrap', () => {
  assert.equal(seqDiff(5, 3), 2)
  assert.equal(seqDiff(3, 5), -2)
  assert.equal(seqDiff(1, 0xffffffff), 2)
  assert.equal(seqDiff(0xffffffff, 1), -2)
  assert.equal(seqDiff(0, 0), 0)
})
