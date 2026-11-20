// Syntone sender page (plan §4 M1): capture → 20 ms frames stamped on the relay clock → Opus → relay.
//
// The room is ?room=<name> (default « lobby »). The page says nothing about who is sending: no name.
// Capture runs in an AudioWorklet (web/js/capture-worklet.js) on a 48 kHz context; each block is
// stamped with the relay time it reached the page, and shared/sender.js does the rest. The codec is
// the one the room uses (welcome.uses.codec): Opus through WebCodecs, or PCM in a PCM room.
import { Link } from '/js/link.js'
import { SenderCore } from '/shared/sender.js'
import { OpusEncoder, PcmEncoder, canEncodeOpus } from '/js/codecs.js'

const $ = (id) => document.getElementById(id)
const q = new URLSearchParams(location.search)
const RATE = 48000
const room = (q.get('room') || 'lobby').slice(0, 32)

let link, ctx, capture, src, mic, core, encoder, wake, timer
let last = { t: 0, bytes: 0 }

const note = (s, bad = false) => { $('note').textContent = s; $('note').className = bad ? 'bad' : 'dim' }
const fmt = (v, d = 1) => (v === null || v === undefined || !Number.isFinite(v) ? '–' : v.toFixed(d))

$('source').addEventListener('change', () => $('filerow').classList.toggle('hidden', $('source').value !== 'file'))

// Join at once (as a sender, sending nothing yet): the clock converges while the operator chooses.
const opus = { 1: await canEncodeOpus(RATE, 1), 2: await canEncodeOpus(RATE, 2) }
link = new Link({ room, role: 'sender', name: '', has: { codecs: opus[1] ? ['opus', 'pcm'] : ['pcm'] } })
link.addEventListener('groups', () => { if (document.activeElement !== $('delay')) $('delay').value = link.delayMs ?? '' })
$('delay').addEventListener('change', () => { const v = Number($('delay').value); if (v >= 10) link.setDelay(v) })
if (!opus[1]) note('This browser cannot encode Opus: it can only send to a PCM room. Use Chrome on a laptop or an Android phone.', true)

const welcomed = () => (link.uses ? Promise.resolve() : new Promise((ok) => link.addEventListener('welcome', ok, { once: true })))

async function start() {
  $('start').disabled = true
  try {
    const channels = Number($('channels').value)
    const source = $('source').value
    await welcomed()
    const codec = link.uses?.codec || 'opus'
    if (codec === 'opus' && !opus[channels]) throw new Error(`this browser cannot encode Opus (${channels} ch)`)
    if (codec !== 'opus' && codec !== 'pcm') throw new Error(`the room uses ${codec}, which this page does not have`)

    ctx = new AudioContext({ sampleRate: RATE, latencyHint: 'interactive' })
    if (ctx.sampleRate !== RATE) throw new Error(`the browser opened a ${ctx.sampleRate} Hz context, not ${RATE}`)
    await ctx.resume()
    await ctx.audioWorklet.addModule('/js/capture-worklet.js')
    capture = new AudioWorkletNode(ctx, 'syntone-capture', {
      numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [1],
      channelCount: channels, channelCountMode: 'explicit', channelInterpretation: 'speakers',
      processorOptions: { channels, blockSamples: 512 },
    })
    const mute = ctx.createGain(); mute.gain.value = 0
    capture.connect(mute).connect(ctx.destination)

    if (source.startsWith('mic')) {
      // no processing: the stream is for loudspeakers, and AGC would pump the test pattern
      mic = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false, channelCount: channels } })
      src = ctx.createMediaStreamSource(mic)
    } else if (source === 'file') {
      const f = $('file').files[0]
      if (!f) throw new Error('choose a file first')
      src = ctx.createBufferSource()
      src.buffer = await ctx.decodeAudioData(await f.arrayBuffer())
      src.loop = true
      src.start()
    }
    if (src) { src.connect(capture); if ($('monitor').checked) src.connect(ctx.destination) }

    encoder = codec === 'opus' ? new OpusEncoder({ rate: RATE, channels, onError: (e) => note(`encoder: ${e.message}`, true) }) : new PcmEncoder()
    const test = source === 'test' || source === 'mic+test'
    core = new SenderCore({
      channels, rate: RATE, encoder, send: (b) => link.sendFrame(b),
      testSlots: test ? Math.max(1, Math.min(8, Number($('slots').value) || 8)) : 0, testOverInput: source === 'mic+test',
    })
    capture.port.onmessage = (e) => {
      const m = e.data
      if (m?.type !== 'block') return
      // the relay time this block reached the page; none until the clock has a fit
      core.block(m.pcm, link.clock.ready ? link.now() * 1000 : null)
    }
    try { wake = await navigator.wakeLock?.request('screen') } catch {}
    $('live').classList.remove('hidden')
    $('roomname').textContent = room
    note(link.clock.ready ? '' : 'waiting for the clock…')
    timer = setInterval(show, 500)
  } catch (e) {
    note(String(e.message || e), true)
    stop()
  }
}

function stop() {
  clearInterval(timer)
  try { capture?.port.postMessage({ type: 'stop' }) } catch {}
  try { src?.disconnect(); src?.stop?.() } catch {}
  mic?.getTracks().forEach((t) => t.stop())
  encoder?.close()
  ctx?.close()
  wake?.release?.()
  ctx = capture = src = mic = core = encoder = wake = null
  $('start').disabled = false
  $('live').classList.add('hidden')
}

function show() {
  if (!core) return
  const s = core.stats, c = link.clock.stats
  const t = performance.now()
  const kbps = last.t ? ((s.bytes - last.bytes) * 8) / (t - last.t) : null
  last = { t, bytes: s.bytes }
  $('k-codec').textContent = `${link.uses?.codec ?? '–'} · ${core.framer.channels}`
  $('k-sent').textContent = `${s.sent} · ${s.skipped}`
  $('k-rate').textContent = fmt(kbps, 0)
  $('k-ppm').textContent = s.stamps.ready ? fmt(s.stamps.ratePpm) : '–'
  $('k-jumps').textContent = `${s.stamps.jumps} · ${s.stamps.steps}`
  $('k-bound').textContent = c.ready ? fmt(c.boundMs, 2) : '–'
  $('k-rx').textContent = String(link.peers.filter((p) => p.role === 'receiver').length)
  $('k-d').textContent = fmt(link.delayMs, 0)
  if (link.clock.ready && $('note').textContent === 'waiting for the clock…') note('')
}

$('start').addEventListener('click', start)
$('stop').addEventListener('click', stop)
document.addEventListener('visibilitychange', async () => {
  if (!document.hidden && core) { try { wake = await navigator.wakeLock?.request('screen') } catch {} }
})
