// Syntone receiver — the AudioWorklet processor around the ring buffer and the player.
//
//   const node = new AudioWorkletNode(ctx, 'syntone-player', { outputChannelCount: [2],
//     processorOptions: { channels: 1, delayMs: 150, latencyMs: 0 } })
//
// In through the port:
//   { type: 'frame', seq, captureUs, pcm: [Float32Array per channel] }   a decoded frame
//   { type: 'clock', ctxMs, timelineMs, rate }   the time base, as a line: context time ctxMs (ms)
//        is timelineMs on the room's timeline, and timeline ms per context ms is `rate` (1 ± drift).
//        The page builds it from its AudioClock and ClockSync and resends it when either moves.
//   { type: 'latency', ms }                      L, from the page's latency source
//   { type: 'delay', ms }                        D, the group's delay
// Out through the port, `reportHz` times a second:
//   { type: 'stats', errorMs, smoothedMs, driftPpm, phasePpm, ppm, jumps, dropouts, locked, frames }
//
// Imports are relative so the same file loads in the browser (/js/ → /shared/) and in Node tests.
import { FrameRing } from '../../shared/ring.js'
import { Player } from '../../shared/player.js'

const STATUSES = ['ok', 'dup', 'late', 'stale', 'bad', 'restart']

export class SyntonePlayer extends AudioWorkletProcessor {
  constructor(options = {}) {
    super()
    const o = options.processorOptions || {}
    this.ring = new FrameRing({ channels: o.channels || 1, frameSamples: o.frameSamples || 960, rate: o.streamRate || 48000, capacityFrames: o.capacityFrames || 512 })
    this.line = null
    const line = () => this.line
    this.timeBase = { toTimeline: (ctxMs) => { const l = line(); return l.timelineMs + (ctxMs - l.ctxMs) * l.rate } }
    this.latency = { ms: o.latencyMs || 0 }
    this.player = new Player({ ring: this.ring, rate: sampleRate, timeBase: this.timeBase, latency: this.latency, delayMs: o.delayMs ?? 150 })
    this.frames = Object.fromEntries(STATUSES.map((s) => [s, 0]))
    this.reportBlocks = Math.max(1, Math.round(sampleRate / 128 / (o.reportHz || 4)))
    this.blocks = 0
    this.port.onmessage = (ev) => this.receive(ev.data)
  }

  receive(m) {
    if (!m) return
    if (m.type === 'frame') this.frames[this.ring.put(m.seq, m.captureUs, m.pcm)]++
    else if (m.type === 'clock') this.line = { ctxMs: m.ctxMs, timelineMs: m.timelineMs, rate: m.rate ?? 1 }
    else if (m.type === 'latency') this.latency.ms = m.ms
    else if (m.type === 'delay') this.player.delayMs = m.ms
  }

  process(inputs, outputs) {
    const out = outputs[0]
    if (!out || !out.length) return true
    // `currentTime` is the context time of this block's first sample: the moment it is handed on
    if (this.line) this.player.render(out, currentTime * 1000)
    else for (const ch of out) ch.fill(0)
    if (++this.blocks % this.reportBlocks === 0) {
      const s = this.player.stats
      this.port.postMessage({ type: 'stats', errorMs: s.errorMs, smoothedMs: s.smoothedMs, driftPpm: s.driftPpm, phasePpm: s.phasePpm,
        ppm: s.ppm, jumps: s.jumps, dropouts: s.dropouts, locked: s.locked, frames: { ...this.frames } })
    }
    return true
  }
}

registerProcessor('syntone-player', SyntonePlayer)
