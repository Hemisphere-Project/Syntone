// Syntone lab — click test.
// Every device schedules a short tone burst on the same beats of the relay clock.
//   beat k  is at server time  k * PERIOD  (+ slot * STAGGER in staggered mode)
// Unison mode: same pitch, same instant — the ear hears a flam above ~10–20 ms.
// Staggered mode: each slot has its own instant and pitch, so a single microphone recording
// holds every device separately (lab/analyse-clicks.mjs measures them).
import { Link } from '/js/link.js'
import { AudioClock } from '/js/audioclock.js'
import { PERIOD_MS, STAGGER_MS, MAX_SLOTS, BURST_MS, slotFreq, ACCENT_EVERY } from '/shared/clicks.js'

const $ = (id) => document.getElementById(id)
const qs = new URLSearchParams(location.search)
const room = qs.get('room') || 'lab'
const store = {
  get(k, d) { try { return localStorage.getItem('syntone.' + k) ?? d } catch { return d } },
  set(k, v) { try { localStorage.setItem('syntone.' + k, v) } catch {} },
}

let ctx, aclock, link
let buffers = new Map()            // freq → AudioBuffer
let lastBeat = -1                  // last beat index already scheduled
let visual = []                    // [{perf, k}] beats to flash

function deviceName() {
  const ua = navigator.userAgent
  const os = /iPhone|iPad/.test(ua) ? 'iOS' : /Android/.test(ua) ? 'Android' : /Mac/.test(ua) ? 'Mac' : /Windows/.test(ua) ? 'Win' : /Linux/.test(ua) ? 'Linux' : '?'
  const br = /Firefox|FxiOS/.test(ua) ? 'Firefox' : /Edg/.test(ua) ? 'Edge' : /SamsungBrowser/.test(ua) ? 'Samsung' : /CriOS|Chrome/.test(ua) ? 'Chrome' : /Safari/.test(ua) ? 'Safari' : '?'
  return `${os} ${br}`
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

function schedule() {
  if (!ctx || !link?.clock.ready) return
  aclock.sample()
  const st = link.state
  if (st.run === false || ctx.state !== 'running') { lastBeat = -1; return }
  const stagger = st.stagger ? STAGGER_MS : 0
  const slot = link.slot % MAX_SLOTS
  const nowS = link.now()
  const first = Math.max(lastBeat + 1, Math.ceil((nowS + 60 - slot * stagger) / PERIOD_MS))
  const horizon = nowS + 700                                   // schedule ~0.7 s ahead, re-run every 200 ms
  for (let k = first; k * PERIOD_MS + slot * stagger <= horizon; k++) {
    const serverT = k * PERIOD_MS + slot * stagger
    const perfT = link.clock.toClient(serverT)
    const when = aclock.contextTimeFor(perfT)
    lastBeat = k
    if (when < ctx.currentTime + 0.005) continue               // too late to be on time: skip, never play late
    const accent = k % ACCENT_EVERY === 0
    const src = ctx.createBufferSource()
    src.buffer = burst(st.stagger ? slotFreq(slot) : accent ? 2400 : 1200)
    src.connect(ctx.destination)
    src.start(when)
    visual.push({ perf: perfT, k, accent })
  }
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
  const s = link.clock.stats, d = aclock.diagnostics()
  $('k-bound').textContent = s.ready ? '±' + fmt(s.boundMs) : '–'
  $('k-bound').className = !s.ready ? '' : s.boundMs < 10 ? 'ok' : s.boundMs > 40 ? 'bad' : ''
  $('k-rtt').textContent = fmt(s.minRttMs)
  $('k-skew').textContent = fmt(s.skewPpm)
  $('k-out').textContent = d.outputLatencyMs !== null ? fmt(d.outputLatencyMs) : d.baseLatencyMs !== null ? fmt(d.baseLatencyMs) + ' (base)' : 'n/a'
  $('k-tsl').textContent = fmt(d.timestampLatencyMs)
  $('k-sr').textContent = `${d.sampleRate} · ${d.state}`
  link.report({ ...d, boundMs: s.boundMs, minRttMs: s.minRttMs, skewPpm: s.skewPpm, samples: s.samples, ua: navigator.userAgent })
}

function renderRoster(peers) {
  const tb = $('roster').tBodies[0]
  tb.textContent = ''
  for (const p of [...peers].sort((a, b) => a.slot - b.slot)) {
    const r = p.report || {}
    const tr = tb.insertRow()
    const cells = [p.slot, p.name + (p.id === link.id ? ' ◀' : ''), fmt(r.boundMs), fmt(r.minRttMs), fmt(r.skewPpm), r.mode ?? '–',
      r.outputLatencyMs != null ? fmt(r.outputLatencyMs) : r.baseLatencyMs != null ? fmt(r.baseLatencyMs) + 'b' : '–', fmt(r.timestampLatencyMs), fmt(r.trimMs, 0), r.sampleRate ?? '–']
    for (const c of cells) tr.insertCell().textContent = c
  }
}

function renderState(st) {
  $('b-run').textContent = st.run === false ? 'Clicks: off' : 'Clicks: on'
  $('b-unison').classList.toggle('on', !st.stagger)
  $('b-stagger').classList.toggle('on', !!st.stagger)
  lastBeat = -1
}

function setTrim(v) {
  v = Math.max(-1000, Math.min(2000, Math.round(Number(v) || 0)))
  aclock.trimMs = v
  $('trim').value = v; $('trimN').value = v
  store.set('trim', v)
}

$('start').addEventListener('click', async () => {
  const AC = window.AudioContext || window.webkitAudioContext
  ctx = new AC({ latencyHint: 'interactive' })
  await ctx.resume()
  aclock = new AudioClock(ctx)
  aclock.mode = store.get('mode', 'timestamp')
  $('mode').value = aclock.mode
  setTrim(store.get('trim', 0))

  link = new Link({ room, role: 'lab', name: deviceName() })
  link.addEventListener('welcome', () => { $('who').textContent = `— slot ${link.slot}`; $('roomname').textContent = `“${room}”` })
  link.addEventListener('state', (e) => renderState(e.detail))
  link.addEventListener('roster', (e) => renderRoster(e.detail))
  link.addEventListener('close', () => { lastBeat = -1 })

  $('start').classList.add('hidden'); $('live').classList.remove('hidden')
  setInterval(schedule, 200)
  setInterval(refresh, 2000)
  requestAnimationFrame(frame)
  // iOS suspends the context on interruptions (call, lock): come back when the page does
  document.addEventListener('visibilitychange', () => { if (!document.hidden && ctx.state !== 'running') ctx.resume() })
  ctx.onstatechange = () => { lastBeat = -1 }
})

$('mode').addEventListener('change', (e) => { aclock.mode = e.target.value; store.set('mode', aclock.mode); lastBeat = -1 })
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
