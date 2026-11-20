// Syntone relay — v0.
//
// One process: serves the web pages and holds the WebSocket every device connects to.
// It is the reference clock (its own monotonic clock, in ms), keeps the list of who is in a room,
// and relays room state. Audio relay comes next; nothing here knows about audio yet.
//
// Wire protocol v0 — JSON text frames (binary frames are reserved for audio):
//   → {t:'ping', id, t0}                     ← {t:'pong', id, t0, t1, t2}      clock sync, see shared/clock.js
//   → {t:'hello', room, role, name}          ← {t:'welcome', id, slot, room, state}
//   → {t:'report', ...anything}              stored on the peer, shown to the room in the roster
//   → {t:'state', patch:{...}}               merged into the room state, ← {t:'state', state} to everyone
//                                            ← {t:'roster', peers:[{id, slot, role, name, report}]}
import http from 'node:http'
import { readFile } from 'node:fs/promises'
import { extname, join, normalize, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { WebSocketServer } from 'ws'

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)))
const PORT = Number(process.env.PORT || 3700)
const HOST = process.env.HOST || '0.0.0.0'

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

const rooms = new Map()   // name → { peers: Map<id, peer>, state: {} }
let nextId = 1

function roomOf(name) {
  let r = rooms.get(name)
  if (!r) { r = { peers: new Map(), state: {} }; rooms.set(name, r) }
  return r
}
const send = (ws, msg) => { if (ws.readyState === 1) ws.send(JSON.stringify(msg)) }
const broadcast = (room, msg) => { const s = JSON.stringify(msg); for (const p of room.peers.values()) if (p.ws.readyState === 1) p.ws.send(s) }
const roster = (room) => ({
  t: 'roster',
  peers: [...room.peers.values()].map(({ id, slot, role, name, report }) => ({ id, slot, role, name, report })),
})
function freeSlot(room) {
  const used = new Set([...room.peers.values()].map((p) => p.slot))
  let s = 0
  while (used.has(s)) s++
  return s
}
const clean = (v, max = 40) => String(v ?? '').replace(/[^\w .:@-]/g, '').slice(0, max)

function onMessage(ws, peer, raw, isBinary) {
  const t1 = now()
  if (isBinary) return                                  // reserved for audio
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
      peer.slot = freeSlot(room)
      room.peers.set(peer.id, peer)
      send(ws, { t: 'welcome', id: peer.id, slot: peer.slot, room: name, state: room.state })
      broadcast(room, roster(room))
      break
    }
    case 'report':
      if (!peer.room || typeof m.report !== 'object') break
      peer.report = m.report
      peer.dirty = true
      break
    case 'state':
      if (!peer.room || !m.patch || typeof m.patch !== 'object') break
      Object.assign(peer.room.state, m.patch)
      broadcast(peer.room, { t: 'state', state: peer.room.state })
      break
  }
}

function onClose(peer) {
  const room = peer.room
  if (!room) return
  room.peers.delete(peer.id)
  if (room.peers.size === 0) rooms.delete(peer.roomName)
  else broadcast(room, roster(room))
}

// ---------------------------------------------------------------- boot

export function start({ port = PORT, host = HOST } = {}) {
  const server = http.createServer(serveStatic)
  const wss = new WebSocketServer({ server, path: '/ws', maxPayload: 1 << 20, perMessageDeflate: false })
  wss.on('connection', (ws) => {
    ws._socket?.setNoDelay(true)                         // a ping answered late is a wrong clock
    const peer = { id: nextId++, ws, room: null, slot: -1, role: '', name: '', report: null, dirty: false }
    ws.on('message', (raw, isBinary) => onMessage(ws, peer, raw, isBinary))
    ws.on('close', () => onClose(peer))
    ws.on('error', () => {})
  })
  // Reports arrive every couple of seconds from every device: fold them into one roster per second.
  const tick = setInterval(() => {
    for (const room of rooms.values()) {
      let dirty = false
      for (const p of room.peers.values()) if (p.dirty) { dirty = true; p.dirty = false }
      if (dirty) broadcast(room, roster(room))
    }
  }, 1000)
  server.on('close', () => clearInterval(tick))
  return new Promise((ok) => server.listen(port, host, () => ok({ server, wss, port: server.address().port })))
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { port } = await start()
  console.log(`syntone relay on http://${HOST}:${port}  (lab: /lab/)`)
}
