// Syntone lab — click test.
// Every device schedules a short tone burst on the same beats of the relay clock.
//   beat k  is at server time  k * PERIOD  (+ slot * STAGGER in staggered mode)
// Unison mode: same pitch, same instant — two clicks fuse into one below about 5 ms.
// Staggered mode: each slot has its own instant and pitch, so a single microphone recording
// holds every device separately (lab/analyse-clicks.mjs measures them).
// Self-test (?selftest=1): this one device plays ALL eight slots. Whatever the analyser then
// reports is the error of the room and the microphone, not of any device.
import { Link } from '/js/link.js'
import { AudioClock, MODES } from '/js/audioclock.js'
import { planBeats } from '/shared/beats.js'
import { PERIOD_MS, STAGGER_MS, MAX_SLOTS, BURST_MS, slotFreq, ACCENT_EVERY } from '/shared/clicks.js'

const $ = (id) => document.getElementById(id)
const qs = new URLSearchParams(location.search)
const room = qs.get('room') || 'lab'
const selftest = qs.has('selftest')
const store = {
  get(k, d) { try { return localStorage.getItem('syntone.' + k) ?? d } catch { return d } },
  set(k, v) { try { localStorage.setItem('syntone.' + k, v) } catch {} },
}

let ctx, aclock, link
const buffers = new Map()          // freq → AudioBuffer
let lanes = new Map()              // slot → last beat index decided
let queued = []                    // [{src, when}] sources handed to the audio system, not yet played
let visual = []                    // [{perf, k, accent}] beats to flash
let skipped = 0                    // beats that could not be queued in time
let caps = {}

function deviceName() {
  const ua = navigator.userAgent
  const os = /iPhone|iPad/.test(ua) ? 'iOS' : /Android/.test(ua) ? 'Android' : /Mac/.test(ua) ? 'Mac' : /Windows/.test(ua) ? 'Win' : /Linux/.test(ua) ? 'Linux' : '?'
  const br = /Firefox|FxiOS/.test(ua) ? 'Firefox' : /Edg/.test(ua) ? 'Edge' : /SamsungBrowser/.test(ua) ? 'Samsung' : /CriOS|Chrome/.test(ua) ? 'Chrome' : /Safari/.test(ua) ? 'Safari' : '?'
  return `${os} ${br}${selftest ? ' selftest' : ''}`
}

/** What this browser can do for the next milestone — logged now so the first sitting answers it. */
async function capabilities() {
  const c = { outputTimestamp: typeof ctx.getOutputTimestamp === 'function', worklet: !!ctx.audioWorklet, isolated: !!self.crossOriginIsolated, wakeLock: 'wakeLock' in navigator, audioSession: 'audioSession' in navigator }
  const cfg = { codec: 'opus', sampleRate: 48000, numberOfChannels: 2 }
  try { c.opusDecode = 'AudioDecoder' in self ? (await AudioDecoder.isConfigSupported(cfg)).supported : false } catch { c.opusDecode = false }
  try { c.opusEncode = 'AudioEncoder' in self ? (await AudioEncoder.isConfigSupported({ ...cfg, bitrate: 96000 })).supported : false } catch { c.opusEncode = false }
  c.webTransport = 'WebTransport' in self
  return c
}

/** A tone burst with a hard start (the onset is what gets measured) and a short fade-out. */
function burst(freq) {
  let b = buffers.get(freq)
  if (b) return b
  const sr = ctx.sampleRate, n = Math.round((BURST_MS / 1000) * sr)
  b = ctx.createBuffer(1, n, sr)
  const d = b.getChannelData(0), fade = Math.round(n * 0.25)
  for (let i = 0; i < n; i++) {
    const env = i > n - fade ? (n - i) / fade : 1
    d[i] = 0.9 * env * Math.sin((2 * Math.PI * freq * i) / sr)
  }
  buffers.set(freq, b)
  return b
}

/** Drop everything queued but not yet played, and start deciding beats afresh. */
function reset() {
  const t = ctx ? ctx.currentTime : 0
  for (const q of queued) if (q.when > t) { try { q.src.stop() } catch {} }
  queued = []; visual = []
  lanes = new Map()
}

function mySlots(stagger) {
  if (!stagger) return [0]                                      // unison: one lane, no offset
  if (selftest) return Array.from({ length: MAX_SLOTS }, (_, i) => i)
  return link.slot >= 0 && link.slot < MAX_SLOTS ? [link.slot] : []   // no ninth voice: it would land on slot 0's pitch
}

function schedule() {
  if (!ctx || !link?.clock.ready) return
  aclock.sample()
  const st = link.state
  const stagger = !!st.stagger
  const slots = mySlots(stagger)
  $('note').textContent = selftest ? 'Self-test: this device plays all eight slots in staggered mode.'
    : stagger && !slots.length ? `Slot ${link.slot}: no recording slot left (eight per room). This device stays silent in staggered mode.` : ''
  if (st.run === false || ctx.state !== 'running' || !aclock.ready) { if (queued.length) reset(); return }
  const nowS = link.now(), ctxNow = ctx.currentTime
  const whenOf = (serverT) => aclock.contextTimeFor(link.clock.toClient(serverT))
  for (const slot of slots) {
    const r = planBeats({ nowS, lastBeat: lanes.get(slot) ?? -1, period: PERIOD_MS, offset: stagger ? slot * STAGGER_MS : 0, whenOf, ctxNow })
    lanes.set(slot, r.lastBeat)
    skipped += r.skipped
    for (const b of r.beats) {
      const accent = b.k % ACCENT_EVERY === 0
      const src = ctx.createBufferSource()
      src.buffer = burst(stagger ? slotFreq(slot) : accent ? 2400 : 1200)
      src.connect(ctx.destination)
      src.start(b.when)
      queued.push({ src, when: b.when })
      if (slot === slots[0]) visual.push({ perf: link.clock.toClient(b.serverT), k: b.k, accent })
    }
  }
  if (queued.length > 64) queued = queued.filter((q) => q.when > ctxNow - 1)
}

function frame() {
  if (aclock) aclock.sample()
  const p = performance.now()
  while (visual.length && visual[0].perf <= p) {
    const v = visual.shift()
    if (p - v.perf < 150) {
      const f = $('flash')
      f.textContent = String(v.k % ACCENT_EVERY + 1)
      f.classList.add('hit'); f.classList.toggle('accent', v.accent)
      setTimeout(() => f.classList.remove('hit', 'accent'), 90)
    }
  }
  requestAnimationFrame(frame)
}

const fmt = (v, d = 1) => (v === null || v === undefined || Number.isNaN(v) ? '–' : Number(v).toFixed(d))

function refresh() {
  if (!link) return
  const s = link.clock.stats, d = aclock.diagnostics(), pair = link.pairStats
  $('k-bound').textContent = s.ready ? '±' + fmt(s.boundMs) : '–'
  $('k-bound').className = !s.ready ? '' : s.boundMs < 10 ? 'ok' : s.boundMs > 40 ? 'bad' : ''
  $('k-rtt').textContent = fmt(s.minRttMs)
  $('k-skew').textContent = fmt(s.skewPpm)
  const rep = (d.baseLatencyMs ?? 0) + (d.outputLatencyMs ?? 0)
  $('k-out').textContent = d.outputLatencyMs !== null ? fmt(rep) : d.baseLatencyMs !== null ? fmt(rep) + ' (base only)' : 'n/a'
  $('k-tsl').textContent = fmt(d.timestampLatencyMs)
  $('k-sr').textContent = `${d.sampleRate} · ${d.state}`
  link.report({
    ...d, boundMs: s.boundMs, minRttMs: s.minRttMs, skewPpm: s.skewPpm, samples: s.samples, steps: s.steps,
    pairOffsetMs: pair.offsetMs, pairRttMs: pair.rttMs, skipped, reconnects: link.reconnects, resets: link.resets,
    caps, ua: navigator.userAgent,
  })
}

function renderRoster(peers) {
  const tb = $('roster').tBodies[0]
  tb.textContent = ''
  for (const p of [...peers].sort((a, b) => a.slot - b.slot)) {
    const r = p.report || {}
    const tr = tb.insertRow()
    const mode = r.mode ? (r.modeUsed && r.modeUsed !== r.mode ? `${r.mode}→${r.modeUsed}` : r.mode) : '–'
    const cells = [p.slot, (p.name || p.role) + (p.id === link.id ? ' ◀' : ''), fmt(r.boundMs), fmt(r.minRttMs), fmt(r.skewPpm), fmt(r.pairOffsetMs), mode,
      fmt(r.baseLatencyMs), fmt(r.outputLatencyMs), fmt(r.timestampLatencyMs), fmt(r.trimMs, 0), r.skipped ?? '–', r.sampleRate ?? '–',
      fmt(r.errorMs, 2), r.dropouts ?? '–', r.lost ?? '–', r.locked === undefined ? '–' : r.locked ? 'yes' : 'no']
    for (const c of cells) tr.insertCell().textContent = c
  }
}

function renderState(st) {
  $('b-run').textContent = st.run === false ? 'Clicks: off' : 'Clicks: on'
  $('b-unison').classList.toggle('on', !st.stagger)
  $('b-stagger').classList.toggle('on', !!st.stagger)
  // the mapping mode belongs to the room once someone has set it there: one tap changes every device
  if (MODES.includes(st.mode) && aclock) { aclock.mode = st.mode; $('mode').value = st.mode }
  reset(); schedule()
}

function setTrim(v) {
  v = Math.max(-1000, Math.min(2000, Math.round(Number(v) || 0)))
  aclock.trimMs = v
  $('trim').value = v; $('trimN').value = v
  store.set('trim', v)
}

let wake = null
async function keepAwake() {
  // a phone that locks its screen suspends the audio context: a ten-minute run needs the screen on
  try { if ('wakeLock' in navigator && !document.hidden) wake = await navigator.wakeLock.request('screen') } catch {}
}

$('start').addEventListener('click', async () => {
  // iOS: without this the ringer switch mutes Web Audio
  try { if (navigator.audioSession) navigator.audioSession.type = 'playback' } catch {}
  const AC = window.AudioContext || window.webkitAudioContext
  ctx = new AC({ latencyHint: 'interactive' })
  await ctx.resume()
  aclock = new AudioClock(ctx)
  aclock.mode = MODES.includes(store.get('mode')) ? store.get('mode') : 'timestamp'
  $('mode').value = aclock.mode
  setTrim(store.get('trim', 0))
  capabilities().then((c) => { caps = c })
  keepAwake()

  link = new Link({ room, role: 'lab', name: deviceName() })
  link.addEventListener('welcome', () => { $('who').textContent = `— slot ${link.slot}`; $('roomname').textContent = `“${room}”` })
  link.addEventListener('state', (e) => renderState(e.detail))
  link.addEventListener('roster', (e) => renderRoster(e.detail))
  link.addEventListener('close', () => reset())

  $('start').classList.add('hidden'); $('live').classList.remove('hidden')
  setInterval(schedule, 200)
  setInterval(refresh, 2000)
  requestAnimationFrame(frame)
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) return
    keepAwake()
    // iOS suspends the context on interruptions (call, lock): come back when the page does
    if (ctx.state !== 'running') ctx.resume()
  })
  // suspended, interrupted, resumed: the pairing with the audio clock no longer holds
  ctx.onstatechange = () => { aclock.reset(); reset() }
})

$('mode').addEventListener('change', (e) => {
  aclock.mode = e.target.value; store.set('mode', aclock.mode)
  link.setState({ mode: aclock.mode })
  reset()
})
$('trim').addEventListener('input', (e) => setTrim(e.target.value))
$('trimN').addEventListener('change', (e) => setTrim(e.target.value))
$('b-run').addEventListener('click', () => link.setState({ run: link.state.run === false }))
$('b-unison').addEventListener('click', () => link.setState({ stagger: false }))
$('b-stagger').addEventListener('click', () => link.setState({ stagger: true }))
$('b-copy').addEventListener('click', async () => {
  const snap = JSON.stringify({ at: new Date().toISOString(), room, state: link.state, peers: link.peers }, null, 2)
  try { await navigator.clipboard.writeText(snap); $('copied').textContent = 'copied' } catch { $('copied').textContent = 'copy refused by the browser' }
  setTimeout(() => ($('copied').textContent = ''), 2000)
})
