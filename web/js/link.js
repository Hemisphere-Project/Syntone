// Syntone link — one WebSocket to the relay: clock sync + room membership.
// Client clock = performance.now() (monotonic, ms). Server clock = the relay's monotonic clock.
import { ClockSync } from '/shared/clock.js'

export class Link extends EventTarget {
  /**
   * @param {{room?: string, role?: string, name?: string, url?: string}} o
   */
  constructor(o = {}) {
    super()
    this.o = { room: 'lobby', role: 'receiver', name: '', ...o }
    this.url = o.url || `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws`
    this.clock = new ClockSync()
    this.id = null
    this.slot = -1
    this.state = {}
    this.peers = []
    this._pingId = 0
    this._pending = new Map()
    this._timer = null
    this._closed = false
    this._connect()
  }

  _emit(type, detail) { this.dispatchEvent(new CustomEvent(type, { detail })) }

  _connect() {
    const ws = (this.ws = new WebSocket(this.url))
    ws.onopen = () => {
      // A new connection may be a new network path (WiFi → LTE): old samples would poison the fit.
      this.clock = new ClockSync()
      this._pending.clear()
      ws.send(JSON.stringify({ t: 'hello', room: this.o.room, role: this.o.role, name: this.o.name }))
      this._burst = 16
      this._schedulePing(0)
      this._emit('open')
    }
    ws.onmessage = (e) => {
      const t3 = performance.now()
      if (typeof e.data !== 'string') { this._emit('binary', e.data); return }
      let m
      try { m = JSON.parse(e.data) } catch { return }
      switch (m.t) {
        case 'pong': {
          if (!this._pending.delete(m.id)) return
          const s = this.clock.addSample(m.t0, m.t1, m.t2, t3)
          if (s) this._emit('clock', { sample: s, stats: this.clock.stats })
          break
        }
        case 'welcome':
          this.id = m.id; this.slot = m.slot; this.state = m.state || {}
          this._emit('welcome', m); this._emit('state', this.state)
          break
        case 'state': this.state = m.state || {}; this._emit('state', this.state); break
        case 'roster': this.peers = m.peers || []; this._emit('roster', this.peers); break
      }
    }
    ws.onclose = () => {
      clearTimeout(this._timer)
      this._emit('close')
      if (!this._closed) setTimeout(() => this._connect(), 1000)
    }
    ws.onerror = () => {}
  }

  _schedulePing(delay) {
    clearTimeout(this._timer)
    this._timer = setTimeout(() => {
      if (this.ws.readyState !== 1) return
      const id = ++this._pingId
      // forget pings that never came back, so the map cannot grow
      if (this._pending.size > 32) this._pending.clear()
      this._pending.set(id, true)
      this.ws.send(JSON.stringify({ t: 'ping', id, t0: performance.now() }))
      // a fast burst to converge, then one per second (jittered, so a fleet does not ping in step)
      const next = this._burst-- > 0 ? 150 : 800 + Math.random() * 400
      this._schedulePing(next)
    }, delay)
  }

  /** Server time now, in ms. */
  now() { return this.clock.toServer(performance.now()) }

  setState(patch) { if (this.ws.readyState === 1) this.ws.send(JSON.stringify({ t: 'state', patch })) }
  report(report) { if (this.ws.readyState === 1) this.ws.send(JSON.stringify({ t: 'report', report })) }
  close() { this._closed = true; clearTimeout(this._timer); this.ws.close() }
}
