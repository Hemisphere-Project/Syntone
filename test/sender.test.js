// node --test — the sender core: capture blocks in, stamped frames out, through a codec and a transport.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { SenderCore, PcmEncoder } from '../shared/sender.js'
import { decodeFrame, CODEC_PCM, CODEC_OPUS } from '../shared/frame.js'
import { decodePcm } from '../shared/pcm.js'
import { PERIOD_MS } from '../shared/clicks.js'

const RATE = 48000, BLOCK = 128
const usPer = 1e6 / RATE

/** Runs `seconds` of capture: blocks reach the page late by 2–9 ms of jitter, the sender 40 ppm fast. */
function run(core, seconds, { t0 = 2e9, ppm = 40, input = () => 0 } = {}) {
  const sent = []
  core.send = (b) => { sent.push(decodeFrame(b)); return true }
  let n = 0
  for (let b = 0; b < seconds * RATE / BLOCK; b++) {
    const block = [Float32Array.from({ length: BLOCK }, (_, i) => input(n + i))]
    n += BLOCK
    const arrive = t0 + n * usPer / (1 + ppm * 1e-6) + 2000 + ((b * 7919) % 7000)
    core.block(block, arrive)
  }
  return sent
}

test('every frame leaves stamped, in order, at the capture rate', () => {
  const core = new SenderCore({ encoder: new PcmEncoder(), send: () => true })
  const sent = run(core, 20)
  assert.equal(core.stats.unstamped, 0)
  assert.equal(sent.length, Math.floor(20 * RATE / 960))
  sent.forEach((f, k) => { assert.equal(f.seq, k); assert.equal(f.codec, CODEC_PCM) })
  // after the warm-up the stamps advance by one frame at the sender's real rate (±1 µs per frame)
  const step = 960 * usPer / (1 + 40e-6)
  for (let k = sent.length - 100; k < sent.length; k++) assert.ok(Math.abs(sent[k].captureUs - sent[k - 1].captureUs - step) < 1.5, `frame ${k}`)
  // and they sit within the jitter of the true capture time (2 ms, the earliest arrivals' lateness)
  const last = sent.at(-1)
  const truth = 2e9 + 960 * last.seq * usPer / (1 + 40e-6)
  assert.ok(Math.abs(last.captureUs - truth - 2000) < 300, `${last.captureUs - truth}`)
})

test('the payload is the captured audio', () => {
  const core = new SenderCore({ encoder: new PcmEncoder(), send: () => true })
  const sent = run(core, 1, { input: (n) => ((n % 960) / 960) - 0.5 })
  const pcm = decodePcm(sent[3].payload, 1)[0]
  assert.ok(Math.abs(pcm[0] + 0.5) < 1e-4 && Math.abs(pcm[480] - 0) < 1e-4)
})

test('no clock yet: nothing leaves, and the sample count still runs', () => {
  const sent = []
  const core = new SenderCore({ encoder: new PcmEncoder(), send: (b) => sent.push(b) })
  for (let b = 0; b < 100; b++) core.block([new Float32Array(BLOCK)], null)
  assert.equal(sent.length, 0)
  assert.equal(core.stats.unstamped, Math.floor(100 * BLOCK / 960))
  core.block([new Float32Array(BLOCK)], 5e9)
  core.block([new Float32Array(BLOCK * 8)], 5e9 + 30_000)
  assert.equal(decodeFrame(sent[0]).seq, Math.floor(101 * BLOCK / 960))
})

test('test mode: the click pattern sits on the frames by their stamps', () => {
  const core = new SenderCore({ encoder: new PcmEncoder(), send: () => true, testSlots: 1 })
  const sent = run(core, 12, { input: () => 0.3 })
  let onsets = 0
  for (const f of sent.slice(-250)) {
    const pcm = decodePcm(f.payload, 1)[0]
    const ms = f.captureUs / 1000
    const startsBeat = Math.floor((ms + 20) / PERIOD_MS) * PERIOD_MS          // a beat inside this frame?
    if (startsBeat < ms || startsBeat >= ms + 20) {
      const tail = ms - Math.floor(ms / PERIOD_MS) * PERIOD_MS < 6          // a burst begun in the frame before
      if (!tail) assert.equal(pcm.every((v) => v === 0), true, `frame ${f.seq}`)
      continue
    }
    onsets++
    const i = Math.ceil((startsBeat - ms) * RATE / 1000)
    assert.equal(pcm[Math.max(0, i - 1)], 0)
    assert.notEqual(pcm[i + 1], 0)
  }
  assert.equal(onsets, 5)
})

test('a transport that is backed up skips frames and counts them', () => {
  let open = true
  const core = new SenderCore({ encoder: new PcmEncoder(), send: () => open })
  run(core, 2)
  core.send = () => (open = false)
  const before = core.stats.sent
  for (let b = 0; b < 20; b++) core.block([new Float32Array(BLOCK)], 2e9 + 3e6 + b * 2667)
  assert.equal(core.stats.sent, before)
  assert.ok(core.stats.skipped >= 2)
})

test('the room switches codec: frames go to the new encoder, sequence and stamps run on', () => {
  // an encoder that answers one frame late, like WebCodecs: its last packet arrives after the switch
  const late = { codec: CODEC_OPUS, output: null, held: null, closed: false,
    encode(f) { if (this.held) this.output(this.held); this.held = { seq: f.seq, captureUs: f.captureUs, payload: new Uint8Array(30) } },
    close() { this.closed = true } }
  const core = new SenderCore({ encoder: late, send: () => true })
  const before = run(core, 1)
  const held = late.held
  core.setEncoder(new PcmEncoder())
  assert.ok(late.closed)
  late.output(held)                                           // a packet the old encoder still hands over
  assert.deepEqual([before.at(-1).seq, before.at(-1).codec], [held.seq, CODEC_OPUS], 'it keeps its own codec byte')
  const after = run(core, 1, { t0: 2e9 + RATE * usPer / (1 + 40e-6) })   // the same capture, one second on
  assert.ok(before.length > 1 && after.length > 0)
  assert.ok(before.every((f) => f.codec === CODEC_OPUS))
  assert.ok(after.every((f) => f.codec === CODEC_PCM))
  assert.equal(after[0].seq, held.seq + 1, 'the sequence runs on')
  const step = 960 * usPer / (1 + 40e-6)
  assert.ok(Math.abs(after[0].captureUs - held.captureUs - step) < 1.5, 'and so do the stamps')
  assert.equal(core.stats.sent, before.length + after.length)
})
