// Syntone relay — v1.
//
// One process: serves the web pages and holds the WebSocket every device connects to.
// It is the reference clock (its own monotonic clock, in ms), keeps the list of who is in a room,
// relays room state and fans audio frames out. It reads a frame's header, never its audio.
//
// Wire protocol v1 — JSON text frames for control, binary frames for audio:
//   → {t:'ping', id, t0}                     ← {t:'pong', id, t0, t1, t2}      clock sync, see shared/clock.js
//   → {t:'hello', room, role, name, want}    ← {t:'welcome', id, slot, room, state}
//                                            `want` = the slot held before a reconnect; given back if free
//   → {t:'report', report:{...}}             stored on the peer, shown to the room in the roster
//   → {t:'state', patch:{...}}               merged into the room state, ← {t:'state', state} to everyone
//                                            (flat, small values only: see cleanPatch)
//                                            ← {t:'roster', peers:[{id, slot, role, name, report, drops}]}
//   → binary audio frame (shared/frame.js)   ← the same bytes, to every receiver in the room
//
// Audio: one sender per room at a time (role 'sender'). Its frames go, byte for byte, to every peer
// of the room whose role is 'receiver'; nobody else gets them, the sender included. Another sender
// takes the room over once the current one has sent no audio for SENDER_IDLE_MS (a sender that
// reconnects on a new path is back within that time). A receiver whose socket cannot keep up has
// frames skipped rather than queued: a frame that arrives after its play time is worth nothing, and
// a growing queue would make every later frame late too. `drops` in the roster counts them.
//
// Group delay D: the room state always holds `delayMs`, the room's delay in ms. Every receiver plays
// a frame so that it is heard at captureUs / 1000 + delayMs on the relay clock (plan §2). It starts
// at DELAY_MS, any peer may set it within [MIN_DELAY_MS, MAX_DELAY_MS], and null puts the default back.
//
// A peer that sends nothing for SILENT_MS is dropped: its path died without saying so (WiFi → LTE),
// and it must not keep its slot. Clients ping about once per second.
import http from 'node:http'
import { readFile } from 'node:fs/promises'
import { extname, join, normalize, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { WebSocketServer } from 'ws'
import { decodeFrame } from '../shared/frame.js'

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)))
const PORT = Number(process.env.PORT || 3700)
const HOST = process.env.HOST || '0.0.0.0'
const SILENT_MS = 10_000
// LTE over WebSocket with 20 ms frames, the M1 set-up: the « LTE safe » preset is 400–600 ms (plan §2)
// and the M1 pass mark wants D at or under 500 ms.
const DELAY_MS = Number(process.env.DELAY_MS || 500)
const MIN_DELAY_MS = 10
const MAX_DELAY_MS = 30_000            // buffered mode runs D at several seconds
const SENDER_IDLE_MS = 1000
const MAX_BACKLOG = 64 * 1024          // bytes waiting on one receiver's socket before frames are skipped

/** The reference clock: monotonic, immune to NTP steps on the server. Epoch = process start. */
export const now = () => performance.now()

// ---------------------------------------------------------------- static files

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.svg': 'image/svg+xml', '.wasm': 'application/wasm',
  '.png': 'image/png', '.ico': 'image/x-icon', '.webmanifest': 'application/manifest+json',
}
// URL prefix → folder. Only these two folders are ever served.
const MOUNTS = [['/shared/', join(ROOT, 'shared')], ['/', join(ROOT, 'web')]]

async function serveStatic(req, res) {
  let path
  try { path = decodeURIComponent(new URL(req.url, 'http://x').pathname) } catch { res.writeHead(400).end(); return }
  if (path.endsWith('/')) path += 'index.html'
  for (const [prefix, dir] of MOUNTS) {
    if (!path.startsWith(prefix)) continue
    const file = normalize(join(dir, path.slice(prefix.length)))
    if (file !== dir && !file.startsWith(dir + sep)) break                // path traversal
    try {
      const body = await readFile(file)
      res.writeHead(200, {
        'content-type': MIME[extname(file)] || 'application/octet-stream',
        'cache-control': 'no-store',                                       // research build: always the latest page
        // cross-origin isolation, so pages may use SharedArrayBuffer with AudioWorklet later
        'cross-origin-opener-policy': 'same-origin',
        'cross-origin-embedder-policy': 'require-corp',
      })
      res.end(body)
      return
    } catch { /* try the next mount */ }
  }
  res.writeHead(404, { 'content-type': 'text/plain' }).end('not found')
}

// ---------------------------------------------------------------- rooms

const rooms = new Map()   // name → { peers: Map<id, peer>, state: {}, sender: peer id | null, senderAt: ms }
let nextId = 1
const cfg = { delayMs: DELAY_MS, senderIdleMs: SENDER_IDLE_MS }

function roomOf(name) {
  let r = rooms.get(name)
  if (!r) { r = { peers: new Map(), state: { delayMs: cfg.delayMs }, sender: null, senderAt: 0 }; rooms.set(name, r) }
  return r
}
const send = (ws, msg) => { if (ws.readyState === 1) ws.send(JSON.stringify(msg)) }
const broadcast = (room, msg) => { const s = JSON.stringify(msg); for (const p of room.peers.values()) if (p.ws.readyState === 1) p.ws.send(s) }
const roster = (room) => ({
  t: 'roster',
  peers: [...room.peers.values()].map(({ id, slot, role, name, report, drops }) => ({ id, slot, role, name, report, drops })),
})
function freeSlot(room, want) {
  const used = new Set([...room.peers.values()].map((p) => p.slot))
  if (Number.isInteger(want) && want >= 0 && want < 4096 && !used.has(want)) return want
  let s = 0
  while (used.has(s)) s++
  return s
}
const clean = (v, max = 40) => String(v ?? '').replace(/[^\w .:@-]/g, '').slice(0, max)

/** Room state is shared by everyone and lives as long as the room: keep it flat, small and bounded. */
const STATE_KEYS = 24
function cleanPatch(patch, state) {
  const out = {}
  for (const [k, v] of Object.entries(patch)) {
    if (!/^[a-z][a-zA-Z0-9]{0,23}$/.test(k)) continue
    if (k === 'delayMs') {                               // always present, always a usable delay
      if (v === null) out.delayMs = cfg.delayMs
      else if (typeof v === 'number' && v >= MIN_DELAY_MS && v <= MAX_DELAY_MS) out.delayMs = v
      continue
    }
    if (typeof v === 'boolean' || (typeof v === 'number' && Number.isFinite(v)) || (typeof v === 'string' && v.length <= 64)) out[k] = v
    else if (v === null) out[k] = null
  }
  const keys = new Set([...Object.keys(state), ...Object.keys(out)])
  return keys.size <= STATE_KEYS ? out : null
}

/**
 * Sends one frame to every receiver of a room, except those whose socket is backed up.
 * @param {Iterable<{role:string, drops:number, ws:{readyState:number, bufferedAmount:number, send:Function}}>} peers
 * @param {Uint8Array} data  the frame as it arrived: the same bytes go to everyone
 * @returns {{sent:number, dropped:number}}
 */
export function fanOut(peers, data, maxBacklog = MAX_BACKLOG) {
  let sent = 0, dropped = 0
  for (const p of peers) {
    if (p.role !== 'receiver' || p.ws.readyState !== 1) continue
    if (p.ws.bufferedAmount > maxBacklog) { p.drops++; p.dirty = true; dropped++; continue }
    p.ws.send(data, { binary: true })
    sent++
  }
  return { sent, dropped }
}

function onAudio(peer, raw, t) {
  const room = peer.room
  if (!room || peer.role !== 'sender' || !decodeFrame(raw)) return
  if (room.sender !== peer.id) {
    const current = room.sender !== null && room.peers.get(room.sender)
    if (current && t - room.senderAt < cfg.senderIdleMs) return     // the room has a live sender
    room.sender = peer.id
  }
  room.senderAt = t
  fanOut(room.peers.values(), raw)
}

function onMessage(ws, peer, raw, isBinary) {
  const t1 = now()
  peer.lastSeen = t1
  if (isBinary) { onAudio(peer, raw, t1); return }
  if (raw.length > 16_384) return
  let m
  try { m = JSON.parse(raw) } catch { return }
  if (!m || typeof m !== 'object') return
  switch (m.t) {
    case 'ping':
      send(ws, { t: 'pong', id: m.id, t0: m.t0, t1, t2: now() })
      break
    case 'hello': {
      if (peer.room) break
      const name = clean(m.room, 32) || 'lobby'
      const room = roomOf(name)
      peer.room = room; peer.roomName = name
      peer.role = clean(m.role, 16) || 'receiver'
      peer.name = clean(m.name)
      peer.slot = freeSlot(room, m.want)
      room.peers.set(peer.id, peer)
      send(ws, { t: 'welcome', id: peer.id, slot: peer.slot, room: name, state: room.state })
      broadcast(room, roster(room))
      break
    }
    case 'report':
      if (!peer.room || !m.report || typeof m.report !== 'object') break
      peer.report = m.report
      peer.dirty = true
      break
    case 'state': {
      if (!peer.room || !m.patch || typeof m.patch !== 'object') break
      const patch = cleanPatch(m.patch, peer.room.state)
      if (!patch) break
      for (const [k, v] of Object.entries(patch)) { if (v === null) delete peer.room.state[k]; else peer.room.state[k] = v }
      broadcast(peer.room, { t: 'state', state: peer.room.state })
      break
    }
  }
}

function onClose(peer) {
  const room = peer.room
  if (!room || !room.peers.has(peer.id)) return
  peer.room = null
  room.peers.delete(peer.id)
  if (room.sender === peer.id) room.sender = null
  if (room.peers.size === 0) rooms.delete(peer.roomName)
  else broadcast(room, roster(room))
}

// ---------------------------------------------------------------- boot

export function start({ port = PORT, host = HOST, silentMs = SILENT_MS, delayMs = DELAY_MS, senderIdleMs = SENDER_IDLE_MS } = {}) {
  if (!(delayMs >= MIN_DELAY_MS && delayMs <= MAX_DELAY_MS)) throw new RangeError(`delayMs ${delayMs}: ${MIN_DELAY_MS}…${MAX_DELAY_MS}`)
  cfg.delayMs = delayMs; cfg.senderIdleMs = senderIdleMs
  const server = http.createServer(serveStatic)
  const wss = new WebSocketServer({ server, path: '/ws', maxPayload: 1 << 20, perMessageDeflate: false })
  wss.on('connection', (ws) => {
    ws._socket?.setNoDelay(true)                         // a ping answered late is a wrong clock
    const peer = { id: nextId++, ws, room: null, slot: -1, role: '', name: '', report: null, drops: 0, dirty: false, lastSeen: now() }
    ws.peer = peer
    ws.on('message', (raw, isBinary) => onMessage(ws, peer, raw, isBinary))
    ws.on('close', () => onClose(peer))
    ws.on('error', () => {})
  })
  // Reports arrive every couple of seconds from every device: fold them into one roster per second.
  const tick = setInterval(() => {
    const deadline = now() - silentMs
    for (const ws of wss.clients) {
      // terminate() does not wait for a close handshake the dead path would never complete
      if (ws.peer && ws.peer.lastSeen < deadline) { onClose(ws.peer); ws.terminate() }
    }
    for (const room of rooms.values()) {
      let dirty = false
      for (const p of room.peers.values()) if (p.dirty) { dirty = true; p.dirty = false }
      if (dirty) broadcast(room, roster(room))
    }
  }, 1000)
  server.on('close', () => clearInterval(tick))
  return new Promise((ok) => server.listen(port, host, () => ok({ server, wss, port: server.address().port })))
}
