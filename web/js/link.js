// Syntone link — one WebSocket to the relay: clock sync + room membership.
// Client clock = performance.now() (monotonic, ms). Server clock = the relay's monotonic clock.
import { ClockSync } from '/shared/clock.js'

/**
 * What a page of this build has, said to the relay on joining (docs/architecture.md §4). The click
 * test's mapping modes and its trim are the first two latency sources (architecture §6). Codecs are
 * empty: a page that plays or sends audio says which it handles, through the `has` option.
 */
export const PAGE_HAS = Object.freeze({ timeBases: ['relay'], transports: ['websocket'], codecs: [], latency: ['reported', 'set'], player: 'browser' })

const PAIR_GAP_MS = 12      // each probe is two pings this far apart
const DEAD_MS = 5000        // no answer for this long on an open socket: the path is dead, reconnect
const PAUSE_MS = 500        // wall clock ran this much further than the monotonic clock: the device slept

const median = (a) => { const s = [...a].sort((x, y) => x - y); const m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2 }

export class Link extends EventTarget {
  /**
   * @param {{room?: string, role?: string, name?: string, url?: string, has?: object}} o
   *   `has` is merged over PAGE_HAS, e.g. {codecs: ['opus']}
   */
  constructor(o = {}) {
    super()
    this.o = { room: 'lobby', role: 'receiver', name: '', ...o, has: { ...PAGE_HAS, ...o.has } }
    this.url = o.url || `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws`
    this.clock = new ClockSync()
    this.id = null
    this.slot = -1
    this.state = {}
    this.uses = null           // what the room uses: {timeBase, transport, codec}
    this.policy = null         // what the room may ask of this device (architecture §3)
    this.group = null          // this device's group, whose delay it plays at
    this.groups = []           // [{id, delayMs}]
    this.peers = []
    this.reconnects = 0
    this.resets = 0            // clock thrown away because the device slept
    this._pingId = 0
    this._pending = new Map()  // ping id → { pair, which }
    this._pairs = new Map()    // pair id → first ping's sample
    this._pairDeltas = []      // recent { offset, rtt } differences, first ping minus second
    this._timer = null
    this._closed = false
    this._connect()
    if (typeof document !== 'undefined') {
      // back in front: converge fast again (timers were throttled, the network may have changed)
      document.addEventListener('visibilitychange', () => { if (!document.hidden && this.ws?.readyState === 1) { this._burst = 8; this._schedulePing(0) } })
    }
  }

  _emit(type, detail) { this.dispatchEvent(new CustomEvent(type, { detail })) }

  _freshClock() {
    this.clock = new ClockSync()
    this._pending.clear(); this._pairs.clear(); this._pairDeltas = []
    this._burst = 16
    this._lastPerf = this._lastWall = null
  }

  _connect() {
    const ws = (this.ws = new WebSocket(this.url))
    ws.binaryType = 'arraybuffer'          // audio frames: read synchronously, no Blob round trip
    ws.onopen = () => {
      if (ws !== this.ws) return
      // A new connection may be a new network path (WiFi → LTE): old samples would poison the fit.
      this._freshClock()
      this._lastPong = performance.now()
      ws.send(JSON.stringify({ t: 'hello', room: this.o.room, role: this.o.role, name: this.o.name, want: this.slot >= 0 ? this.slot : undefined, has: this.o.has }))
      this._schedulePing(0)
      this._emit('open')
    }
    ws.onmessage = (e) => {
      const t3 = performance.now()
      if (ws !== this.ws) return
      if (typeof e.data !== 'string') { this._emit('binary', e.data); return }
      let m
      try { m = JSON.parse(e.data) } catch { return }
      switch (m.t) {
        case 'pong': {
          const p = this._pending.get(m.id)
          if (!p) return
          this._pending.delete(m.id)
          this._lastPong = t3
          const s = this.clock.addSample(m.t0, m.t1, m.t2, t3)
          if (!s) return
          this._pair(p, s)
          this._emit('clock', { sample: s, stats: this.clock.stats })
          break
        }
        case 'welcome':
          this.id = m.id; this.slot = m.slot; this.state = m.state || {}
          this.uses = m.uses || null; this.policy = m.policy || null; this.group = m.group ?? null; this.groups = m.groups || []
          this._emit('welcome', m); this._emit('state', this.state); this._emit('groups', this.groups)
          break
        case 'state': this.state = m.state || {}; this._emit('state', this.state); break
        case 'groups': this.groups = m.groups || []; this._emit('groups', this.groups); break
        case 'roster': this.peers = m.peers || []; this._emit('roster', this.peers); break
      }
    }
    ws.onclose = () => {
      if (ws !== this.ws) return
      clearTimeout(this._timer)
      this._emit('close')
      if (!this._closed) setTimeout(() => { if (ws === this.ws) this._reconnect() }, 1000)
    }
    ws.onerror = () => {}
  }

  _reconnect() {
    const old = this.ws
    this.ws = null                       // the old socket's handlers now ignore themselves
    try { old?.close() } catch {}
    clearTimeout(this._timer)
    this.reconnects++
    if (!this._closed) this._connect()
  }

  /**
   * On LTE a lone uplink packet first has to ask the cell for a slot, which delays the ping but not
   * the pong: every exchange is then biased the same way, and no amount of filtering removes it.
   * The second ping of a pair travels while the radio is still granted. Both feed the estimator
   * (the faster one wins by its round trip); the difference between them is what this measures.
   */
  _pair(p, s) {
    if (p.which === 0) { this._pairs.set(p.pair, s); if (this._pairs.size > 16) this._pairs.delete(this._pairs.keys().next().value); return }
    const first = this._pairs.get(p.pair)
    if (!first) return
    this._pairs.delete(p.pair)
    this._pairDeltas.push({ offset: first.offset - s.offset, rtt: first.rtt - s.rtt })
    if (this._pairDeltas.length > 40) this._pairDeltas.shift()
  }

  /** Median difference between the first and second ping of a pair: the cost of waking the radio. */
  get pairStats() {
    const d = this._pairDeltas
    if (d.length < 5) return { n: d.length, offsetMs: null, rttMs: null }
    return { n: d.length, offsetMs: median(d.map((x) => x.offset)), rttMs: median(d.map((x) => x.rtt)) }
  }

  _ping(pair, which) {
    if (this.ws?.readyState !== 1) return
    const id = ++this._pingId
    this._pending.set(id, { pair, which })
    this.ws.send(JSON.stringify({ t: 'ping', id, t0: performance.now() }))
  }

  _schedulePing(delay) {
    clearTimeout(this._timer)
    this._timer = setTimeout(() => {
      const ws = this.ws
      if (ws?.readyState !== 1) return
      const perf = performance.now(), wall = Date.now()
      // An open socket that stopped answering: do not wait for a close handshake that cannot complete.
      if (perf - this._lastPong > DEAD_MS) { this._emit('close'); this._reconnect(); return }
      // The monotonic clock stops while a phone sleeps, the wall clock does not.
      if (this._lastPerf !== null && (wall - this._lastWall) - (perf - this._lastPerf) > PAUSE_MS) {
        this._freshClock(); this.resets++
        this._lastPong = perf
      }
      this._lastPerf = perf; this._lastWall = wall
      // forget pings that never came back, so the map cannot grow
      if (this._pending.size > 64) this._pending.clear()
      const pair = this._pingId
      this._ping(pair, 0)
      setTimeout(() => { if (ws === this.ws) this._ping(pair, 1) }, PAIR_GAP_MS)
      // a fast burst to converge, then one pair per second (jittered, so a fleet does not ping in step)
      const next = this._burst-- > 0 ? 150 : 800 + Math.random() * 400
      this._schedulePing(next)
    }, delay)
  }

  /** Server time now, in ms. */
  now() { return this.clock.toServer(performance.now()) }

  /** This device's group delay D in ms, null before the welcome. */
  get delayMs() { return this.groups.find((g) => g.id === this.group)?.delayMs ?? null }

  /** Sets D for this device's group (null: back to the relay's default). */
  setDelay(delayMs) { if (this.ws?.readyState === 1) this.ws.send(JSON.stringify({ t: 'delay', delayMs })) }

  /**
   * One audio frame to the relay (the transport seam's `send`, architecture §6). False when the socket
   * is not open or already holds more than `maxBacklog` bytes: a frame queued behind others would
   * reach every receiver late, so it is skipped instead.
   */
  sendFrame(bytes, maxBacklog = 32 * 1024) {
    const ws = this.ws
    if (ws?.readyState !== 1 || ws.bufferedAmount > maxBacklog) return false
    ws.send(bytes)
    return true
  }

  setState(patch) { if (this.ws?.readyState === 1) this.ws.send(JSON.stringify({ t: 'state', patch })) }
  report(report) { if (this.ws?.readyState === 1) this.ws.send(JSON.stringify({ t: 'report', report })) }
  close() { this._closed = true; clearTimeout(this._timer); this.ws?.close() }
}
