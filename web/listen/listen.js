// Syntone receiver page (plan §4 M1): one tap, nothing to set, nothing that names the device.
//
// The room is ?room=<name> (default « lobby »); ?test plays the stream click test, this phone's slot
// only (the lab's roster shows which). Opus is decoded by the browser (WebCodecs), else by libopus in
// WebAssembly; ?decoder=wasm forces the second, to check it on a browser that has both. The tap opens the audio context (a browser plays nothing
// before a gesture), joins the room and feeds the player worklet: decoded frames, the time base as
// a line (context time → relay time, through AudioClock and the link's ClockSync), the device's
// output latency L and the room's delay D. Back to the relay go counts only (policy reports: counts).
// When the room switches codec (Opus ↔ PCM, the sender's choice), the page swaps its decoder: nothing to tap.
import { Link } from '/js/link.js'
import { AudioClock } from '/js/audioclock.js'
import { OpusDecoder, PcmDecoder, WasmOpusDecoder, canDecodeOpus, wasmOpusDecoder } from '/js/codecs.js'
import { ReceiverCore, clockLine, lineMoved } from '/shared/receiver.js'
import { CODECS } from '/shared/frame.js'

const $ = (id) => document.getElementById(id)
const q = new URLSearchParams(location.search)
const RATE = 48000
const room = (q.get('room') || 'lobby').slice(0, 32)
const test = q.has('test')
const forceWasm = q.get('decoder') === 'wasm'

let link, ctx, clock, node, core, wake, timers = [], line = null, stats = null, sentL = null, sentD = null

const note = (s, bad = false) => { $('note').textContent = s; $('note').className = bad ? 'bad' : 'dim' }
const fmt = (v, d = 1) => (v === null || v === undefined || !Number.isFinite(v) ? '–' : v.toFixed(d))
const welcomed = () => (link.uses ? Promise.resolve() : new Promise((ok) => link.addEventListener('welcome', ok, { once: true })))

async function decoderFor(codec, channels) {
  if (codec === 'pcm') return new PcmDecoder({ channels })
  if (codec !== 'opus') throw new Error(`the room uses ${codec}, which this page does not have`)
  if (!forceWasm && (await canDecodeOpus(RATE, channels))) return new OpusDecoder({ rate: RATE, channels, onError: (e) => note(`decoder: ${e.message}`, true) })
  return wasmOpusDecoder({ rate: RATE, channels })
}

async function go() {
  $('go').disabled = true
  try {
    // the context first, inside the tap: a phone browser refuses to start one later
    ctx = new AudioContext({ latencyHint: 'playback' })
    await ctx.resume()
    clock = new AudioClock(ctx)
    await ctx.audioWorklet.addModule('/js/player-worklet.js')
    const channels = 1
    node = new AudioWorkletNode(ctx, 'syntone-player', {
      numberOfInputs: 0, numberOfOutputs: 1, outputChannelCount: [2],
      processorOptions: { channels, streamRate: RATE, delayMs: 500, latencyMs: 0 },
    })
    node.connect(ctx.destination)
    node.port.onmessage = (e) => { if (e.data?.type === 'stats') stats = e.data }

    link = new Link({ room, role: 'receiver', name: '', has: { codecs: ['opus', 'pcm'] } })      // Opus always: WebAssembly where the browser lacks it
    await welcomed()
    core = new ReceiverCore({
      decoder: await decoderFor(link.uses?.codec || 'opus', channels),
      post: (m) => node.port.postMessage(m, m.pcm.map((c) => c.buffer)),
      rate: RATE, testSlot: test ? link.slot : -1,
    })
    link.addEventListener('binary', (e) => core.frame(e.detail))
    link.addEventListener('welcome', () => { core.resetSeq(); if (test) core.testSlot = link.slot; follow(channels) })
    link.addEventListener('groups', () => feed())
    link.addEventListener('uses', () => follow(channels))

    timers.push(setInterval(() => clock.sample(), 50))
    timers.push(setInterval(feed, 250))
    timers.push(setInterval(show, 500))
    timers.push(setInterval(report, 2000))
    try { wake = await navigator.wakeLock?.request('screen') } catch {}
    $('go').classList.add('hidden')
    $('live').classList.remove('hidden')
    note(test ? `click test: this phone is slot ${link.slot}` : '')
  } catch (e) {
    note(String(e.message || e), true)
    stop()
  }
}

/** The room switched codec: decode the new one from its next frame on. One swap at a time, the last word wins. */
let swapping = 0
async function follow(channels) {
  const codec = link?.uses?.codec
  if (!core || !codec || CODECS[codec] === core.decoder.codec) return
  const mine = ++swapping
  try {
    const d = await decoderFor(codec, channels)
    if (mine !== swapping || !core || link?.uses?.codec !== codec) { d.close?.(); return }
    core.setDecoder(d)
  } catch (e) { note(String(e.message || e), true) }
}

/** The player's inputs that move: the time base, L, D. Sent only when they change. */
function feed() {
  if (!node || !clock?.ready || !link.clock.ready) return
  const ctxMs = ctx.currentTime * 1000
  const next = clockLine(ctxMs, clock.originRaw(), (p) => link.clock.toServer(p))
  if (lineMoved(line, next, ctxMs)) { line = next; node.port.postMessage(line) }
  const L = clock.leadMs
  if (sentL === null || Math.abs(L - sentL) > 0.5) { sentL = L; node.port.postMessage({ type: 'latency', ms: L }) }
  const D = link.delayMs
  if (D !== null && D !== sentD) { sentD = D; node.port.postMessage({ type: 'delay', ms: D }) }
}

function stop() {
  timers.forEach(clearInterval); timers = []
  core?.decoder?.close?.()
  link?.close()
  ctx?.close()
  wake?.release?.()
  link = ctx = clock = node = core = wake = line = stats = sentL = sentD = null
  $('go').disabled = false
  $('go').classList.remove('hidden')
  $('live').classList.add('hidden')
}

/** Counts only: nothing that names, locates or fingerprints the device. */
function report() {
  if (!link || !core) return
  const s = core.stats
  link.report({
    frames: s.decoded, lost: s.lost, late: stats?.frames?.late ?? 0,
    dropouts: stats?.dropouts ?? 0, jumps: stats?.jumps ?? 0,
    errorMs: Number.isFinite(stats?.smoothedMs) ? Math.round(stats.smoothedMs * 100) / 100 : null, locked: !!stats?.locked,
  })
}

function show() {
  if (!core) return
  const s = core.stats
  $('k-state').textContent = !link.clock.ready ? 'clock…' : !s.decoded ? 'waiting' : stats?.locked ? 'in sync' : 'locking'
  $('k-err').textContent = fmt(stats?.smoothedMs, 2)
  $('k-frames').textContent = `${s.decoded} · ${s.lost}${s.received - s.decoded > 8 ? ` (${s.received - s.decoded} undecoded)` : ''}`
  $('k-drop').textContent = String(stats?.dropouts ?? '–')
  $('k-codec').textContent = core.decoder instanceof PcmDecoder ? 'pcm' : core.decoder instanceof WasmOpusDecoder ? 'opus (wasm)' : 'opus (browser)'
  $('k-d').textContent = fmt(link.delayMs, 0)
}

$('go').addEventListener('click', go)
$('stop').addEventListener('click', stop)
document.addEventListener('visibilitychange', async () => {
  if (!document.hidden && core) { clock?.reset(); try { wake = await navigator.wakeLock?.request('screen') } catch {} }
})
