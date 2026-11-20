#!/usr/bin/env node
// Measure a click-test recording: how far apart did the devices really play?
//
//   1. open /lab/ on every device, same room, press « Staggered (record) »
//   2. record ~30 s with ONE microphone, every device at the same distance from it
//      (sound travels 34 cm per millisecond: 10 cm of difference is 0.3 ms of error)
//   3. node lab/analyse-clicks.mjs recording.wav            (any format ffmpeg reads)
//
// Each slot plays its own pitch in its own 100 ms time slot (shared/clicks.js). The script finds
// every burst with a matched filter per pitch, removes the slot's known stagger, and reports each
// device's offset relative to the reference slot. The recorder's clock does not matter: only
// differences inside one second are used.
//
// Options: --ref <slot> (default: lowest slot heard) · --json · --sr <Hz> (default 48000)
import { spawnSync } from 'node:child_process'
import { realpathSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { PERIOD_MS, STAGGER_MS, MAX_SLOTS, BURST_MS, slotFreq } from '../shared/clicks.js'

/** Matched-filter envelope for one pitch: |x ⋆ burst·e^{jωt}|, sampled every `hop` samples. */
export function envelope(x, sr, freq, hop = 4) {
  const n = Math.round((BURST_MS / 1000) * sr)
  const cos = new Float32Array(n), sin = new Float32Array(n)
  for (let i = 0; i < n; i++) { const a = (2 * Math.PI * freq * i) / sr; cos[i] = Math.cos(a); sin[i] = Math.sin(a) }
  const out = new Float32Array(Math.floor((x.length - n) / hop))
  for (let j = 0; j < out.length; j++) {
    const o = j * hop
    let re = 0, im = 0
    for (let i = 0; i < n; i++) { const v = x[o + i]; re += v * cos[i]; im += v * sin[i] }
    out[j] = Math.hypot(re, im) / n
  }
  return out
}

/**
 * Burst start times (seconds) for one slot: local maxima of its envelope above a threshold.
 * A hard-edged 6 ms burst spills into the neighbouring pitches' filters (10–20 % of its level),
 * so a peak only counts for the slot whose filter answers LOUDEST at that instant: `envs` holds
 * every slot's envelope, `slot` is the one being read.
 */
export function onsets(envs, slot, sr, hop = 4) {
  const env = envs[slot]
  const mine = (j) => { for (let o = 0; o < envs.length; o++) if (o !== slot && envs[o][j] > env[j]) return false; return true }
  // loudest instant that belongs to this slot: the threshold must not be set by a neighbour's spill
  let max = 0
  for (let j = 0; j < env.length; j++) if (env[j] > max && mine(j)) max = env[j]
  if (max === 0) return { times: [], peak: 0 }
  const thr = max * 0.35
  const refractory = Math.round((0.4 * PERIOD_MS / 1000) * sr / hop)   // after a click of ours: none for 400 ms
  const burst = Math.round((2 * BURST_MS / 1000) * sr / hop)           // after a neighbour's spill: just step past it
  const times = []
  for (let j = 1; j < env.length - 1; j++) {
    if (env[j] < thr || env[j] < env[j - 1] || env[j] < env[j + 1]) continue
    // the true maximum of this burst
    let best = j
    for (let k = j; k < Math.min(env.length - 1, j + burst); k++) if (env[k] > env[best]) best = k
    if (!mine(best)) { j = best + burst; continue }
    // parabolic interpolation around the peak: sub-hop resolution
    const a = env[best - 1] ?? env[best], b = env[best], c = env[best + 1] ?? env[best]
    const frac = a - 2 * b + c !== 0 ? (0.5 * (a - c)) / (a - 2 * b + c) : 0
    times.push(((best + frac) * hop) / sr)
    j = best + refractory
  }
  return { times, peak: max }
}

const median = (a) => { const s = [...a].sort((p, q) => p - q); const m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2 }
const quantile = (a, q) => { const s = [...a].sort((p, r) => p - r); return s[Math.min(s.length - 1, Math.max(0, Math.round(q * (s.length - 1))))] }

/**
 * @param {Float32Array} x mono samples
 * @returns {{ref:number, slots:Array<{slot,freq,clicks,medianMs,p05Ms,p95Ms,spreadMs,wanderMs,driftMsPerMin}>}}
 */
export function analyse(x, sr, { ref = null } = {}) {
  const heard = []
  let loudest = 0
  const all = [], envs = []
  for (let s = 0; s < MAX_SLOTS; s++) envs.push(envelope(x, sr, slotFreq(s)))
  for (let s = 0; s < MAX_SLOTS; s++) { const o = onsets(envs, s, sr); all.push(o); if (o.peak > loudest) loudest = o.peak }
  // a slot is present if its pitch is clearly there and it clicked at least a few times
  for (let s = 0; s < MAX_SLOTS; s++) if (all[s].peak > loudest * 0.05 && all[s].times.length >= 3) heard.push(s)
  if (!heard.length) return { ref: null, slots: [] }
  if (ref === null || !heard.includes(ref)) ref = heard[0]
  const period = PERIOD_MS / 1000, stagger = STAGGER_MS / 1000
  const refTimes = all[ref].times.map((t) => t - ref * stagger)          // the beat instants, per the reference device
  const slots = []
  for (const s of heard) {
    const offs = [], at = []
    for (const t of all[s].times) {
      const beat = t - s * stagger
      // nearest reference beat
      let best = Infinity
      for (const r of refTimes) { const d = beat - r; if (Math.abs(d) < Math.abs(best)) best = d }
      if (Math.abs(best) < period / 2) { offs.push(best * 1000); at.push(t) }
    }
    if (!offs.length) continue
    // drift of the offset over the recording (least squares), in ms per minute
    let drift = 0
    if (offs.length >= 5) {
      const mt = at.reduce((a, b) => a + b, 0) / at.length, mo = offs.reduce((a, b) => a + b, 0) / offs.length
      let num = 0, den = 0
      for (let i = 0; i < offs.length; i++) { num += (at[i] - mt) * (offs[i] - mo); den += (at[i] - mt) ** 2 }
      drift = den > 0 ? (num / den) * 60 : 0
    }
    const p05 = quantile(offs, 0.05), p95 = quantile(offs, 0.95)
    // how much the offset moves from one click to the next: two copies of one sound whose offset
    // keeps moving sound phasey even when the offset itself stays small
    const steps = []
    for (let i = 1; i < offs.length; i++) steps.push(Math.abs(offs[i] - offs[i - 1]))
    const wander = steps.length ? quantile(steps, 0.95) : 0
    slots.push({ slot: s, freq: slotFreq(s), clicks: offs.length, medianMs: median(offs), p05Ms: p05, p95Ms: p95, spreadMs: p95 - p05, wanderMs: wander, driftMsPerMin: drift })
  }
  return { ref, slots }
}

function decode(file, sr) {
  const r = spawnSync('ffmpeg', ['-v', 'error', '-i', file, '-ac', '1', '-ar', String(sr), '-f', 'f32le', '-'], { maxBuffer: 1 << 30 })
  if (r.error) throw new Error(`ffmpeg not found (${r.error.code}) — install ffmpeg`)
  if (r.status !== 0) throw new Error(`ffmpeg could not read ${file}: ${r.stderr.toString().trim()}`)
  return new Float32Array(r.stdout.buffer, r.stdout.byteOffset, Math.floor(r.stdout.byteLength / 4))
}

const invoked = () => { try { return realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url)) } catch { return false } }
if (process.argv[1] && invoked()) {
  const args = process.argv.slice(2)
  const opt = (name, d) => { const i = args.indexOf('--' + name); if (i < 0) return d; const v = args[i + 1]; args.splice(i, 2); return v }
  const json = args.includes('--json'); if (json) args.splice(args.indexOf('--json'), 1)
  const sr = Number(opt('sr', 48000)), refArg = opt('ref', null)
  const file = args[0]
  if (!file) { console.error('usage: node lab/analyse-clicks.mjs <recording> [--ref <slot>] [--json]'); process.exit(2) }
  let x
  try { x = decode(file, sr) } catch (e) { console.error(e.message); process.exit(1) }
  const res = analyse(x, sr, { ref: refArg === null ? null : Number(refArg) })
  if (json) { console.log(JSON.stringify({ file, seconds: x.length / sr, ...res }, null, 2)); process.exit(0) }
  if (!res.slots.length) { console.error('no click bursts found — was the room in « Staggered (record) » mode?'); process.exit(1) }
  console.log(`${file} — ${(x.length / sr).toFixed(1)} s, ${res.slots.length} device(s) heard, reference = slot ${res.ref}\n`)
  console.log('slot  pitch   clicks   offset vs ref (median)   5%…95%            spread   wander   drift')
  for (const s of res.slots) {
    const sign = (v) => (v >= 0 ? '+' : '') + v.toFixed(2)
    console.log(
      `${String(s.slot).padStart(4)}  ${String(s.freq).padStart(4)} Hz ${String(s.clicks).padStart(6)}   ${(sign(s.medianMs) + ' ms').padStart(22)}   ${(sign(s.p05Ms) + ' … ' + sign(s.p95Ms)).padEnd(17)} ${s.spreadMs.toFixed(2).padStart(6)} ms ${s.wanderMs.toFixed(2).padStart(5)} ms  ${sign(s.driftMsPerMin)} ms/min`
    )
  }
  console.log('\noffset > 0: that device is heard LATER than the reference. Raise its trim by that much (or find out why).')
  console.log('wander: how much the offset moves from one click to the next (95 % of steps stay under it).')
}
