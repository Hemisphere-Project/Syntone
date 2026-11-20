// node --test — the relay over a real WebSocket on localhost.
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import WebSocket from 'ws'
import { start, fanOut } from '../server/index.js'
import { ClockSync } from '../shared/clock.js'
import { encodeFrame, decodeFrame } from '../shared/frame.js'

const D = 450                                               // the test relay's default group delay, ms
let srv, base
before(async () => { srv = await start({ port: 0, host: '127.0.0.1', silentMs: 1500, delayMs: D, senderIdleMs: 500 }); base = `127.0.0.1:${srv.port}` })
after(() => { for (const c of srv.wss.clients) c.terminate(); srv.wss.close(); srv.server.close() })

function client() {
  const ws = new WebSocket(`ws://${base}/ws`)
  const queue = [], waiters = [], frames = []
  ws.on('message', (raw, isBinary) => {
    if (isBinary) { frames.push(raw); return }
    const m = JSON.parse(raw); const i = waiters.findIndex((w) => w.t === m.t); if (i >= 0) waiters.splice(i, 1)[0].ok(m); else queue.push(m)
  })
  const next = (t) => new Promise((ok, ko) => {
    const i = queue.findIndex((m) => m.t === t)
    if (i >= 0) return ok(queue.splice(i, 1)[0])
    waiters.push({ t, ok }); setTimeout(() => ko(new Error(`timeout waiting for ${t}`)), 4000)
  })
  const send = (m) => ws.send(JSON.stringify(m))
  return { ws, next, send, frames, open: new Promise((ok) => ws.on('open', ok)) }
}

/** Joins a room and waits for the welcome. */
async function join(room, role, name) {
  const c = client(); await c.open
  c.send({ t: 'hello', room, role, name })
  c.welcome = await c.next('welcome')
  return c
}
const frame = (seq, captureUs = seq * 20_000) => encodeFrame({ seq, captureUs, payload: Uint8Array.from({ length: 80 }, (_, i) => (seq + i) & 0xff) })
const seqs = (c) => c.frames.map((f) => decodeFrame(f).seq)
/** Every message sent before this has been handled by the relay and its answers have arrived. */
async function settle(...cs) {
  for (const c of cs) { c.send({ t: 'ping', id: -1, t0: 0 }); await c.next('pong') }
  await new Promise((ok) => setTimeout(ok, 30))
}

test('serves the lab page and the shared module, refuses traversal', async () => {
  const lab = await fetch(`http://${base}/lab/`)
  assert.equal(lab.status, 200)
  assert.match(await lab.text(), /Syntone lab/)
  assert.equal((await fetch(`http://${base}/shared/clock.js`)).status, 200)
  assert.equal((await fetch(`http://${base}/shared/%2e%2e/package.json`)).status, 404)
  assert.equal((await fetch(`http://${base}/..%2fpackage.json`)).status, 404)
})

test('ping/pong syncs a client clock on loopback to well under a millisecond', async () => {
  const c = client(); await c.open
  const cs = new ClockSync()
  for (let i = 0; i < 12; i++) {
    c.send({ t: 'ping', id: i, t0: performance.now() })
    const m = await c.next('pong')
    assert.equal(m.id, i)
    assert.ok(m.t2 >= m.t1)
    cs.addSample(m.t0, m.t1, m.t2, performance.now())
  }
  assert.ok(cs.stats.boundMs < 1, `bound ${cs.stats.boundMs}`)
  c.ws.close()
})

test('rooms: slots are the lowest free, roster and state reach everyone, a slot is reused', async () => {
  const a = client(), b = client(); await Promise.all([a.open, b.open])
  a.send({ t: 'hello', room: 'r1', role: 'lab', name: 'A' })
  const wa = await a.next('welcome'); assert.equal(wa.slot, 0)
  b.send({ t: 'hello', room: 'r1', role: 'lab', name: 'B<script>' })
  const wb = await b.next('welcome'); assert.equal(wb.slot, 1)
  let r = await a.next('roster'); if (r.peers.length < 2) r = await a.next('roster')
  assert.deepEqual(r.peers.map((p) => p.name), ['A', 'Bscript'])

  b.send({ t: 'state', patch: { stagger: true } })
  assert.deepEqual((await a.next('state')).state, { delayMs: D, stagger: true })

  a.ws.close()
  await new Promise((ok) => setTimeout(ok, 100))
  const c = client(); await c.open
  c.send({ t: 'hello', room: 'r1', role: 'lab', name: 'C' })
  const wc = await c.next('welcome')
  assert.equal(wc.slot, 0, 'the freed slot is taken again')
  assert.deepEqual(wc.state, { delayMs: D, stagger: true }, 'a newcomer gets the room state')
  b.ws.close(); c.ws.close()
})

test('a reconnecting device gets its old slot back when it asks and the slot is free', async () => {
  const a = client(), b = client(); await Promise.all([a.open, b.open])
  a.send({ t: 'hello', room: 'r2', name: 'A' }); assert.equal((await a.next('welcome')).slot, 0)
  b.send({ t: 'hello', room: 'r2', name: 'B' }); assert.equal((await b.next('welcome')).slot, 1)
  a.ws.close(); await new Promise((ok) => setTimeout(ok, 100))
  const b2 = client(); await b2.open                      // B's new connection, old one still open: slot 1 is taken
  b2.send({ t: 'hello', room: 'r2', name: 'B', want: 1 }); assert.equal((await b2.next('welcome')).slot, 0)
  b.ws.close(); await new Promise((ok) => setTimeout(ok, 100))
  const b3 = client(); await b3.open
  b3.send({ t: 'hello', room: 'r2', name: 'B', want: 1 }); assert.equal((await b3.next('welcome')).slot, 1)
  b2.ws.close(); b3.ws.close()
})

test('room state accepts only small flat values and stays bounded', async () => {
  const a = client(); await a.open
  a.send({ t: 'hello', room: 'r3', name: 'A' }); await a.next('welcome')
  a.send({ t: 'state', patch: { mode: 'raw', run: false, big: 'x'.repeat(5000), nested: { a: 1 }, '__proto__x': 1, 'bad key': 1, n: 3 } })
  assert.deepEqual((await a.next('state')).state, { delayMs: D, mode: 'raw', run: false, n: 3 })
  const many = Object.fromEntries(Array.from({ length: 40 }, (_, i) => ['k' + i, i]))
  a.send({ t: 'state', patch: many })                      // too many keys: refused whole
  a.send({ t: 'state', patch: { n: null } })               // null removes a key
  assert.deepEqual((await a.next('state')).state, { delayMs: D, mode: 'raw', run: false })
  a.ws.close()
})

test('a silent peer is dropped and its slot freed', async () => {
  const a = client(), b = client(); await Promise.all([a.open, b.open])
  a.send({ t: 'hello', room: 'r4', name: 'A' }); await a.next('welcome')
  b.send({ t: 'hello', room: 'r4', name: 'B' }); await b.next('welcome')
  const closed = new Promise((ok) => a.ws.on('close', ok))
  const keep = setInterval(() => b.send({ t: 'ping', id: 0, t0: 0 }), 300)   // B keeps talking, A goes quiet
  await closed
  clearInterval(keep)
  let r = await b.next('roster'); while (r.peers.length > 1) r = await b.next('roster')
  assert.deepEqual(r.peers.map((p) => p.name), ['B'])
  b.ws.close()
})

test('garbage does not kill the connection', async () => {
  const c = client(); await c.open
  c.ws.send('not json'); c.ws.send(Buffer.from([1, 2, 3])); c.ws.send('null'); c.ws.send('{"t":"state"}')
  c.send({ t: 'ping', id: 1, t0: 0 })
  assert.equal((await c.next('pong')).id, 1)
  c.ws.close()
})

test('group delay: every room starts at the default D, a peer can set it within bounds, null restores it', async () => {
  const a = await join('d1', 'sender', 'S')
  assert.deepEqual(a.welcome.state, { delayMs: D })
  a.send({ t: 'state', patch: { delayMs: 250 } })
  assert.equal((await a.next('state')).state.delayMs, 250)
  for (const bad of [5, 60_000, -1, '300', true, { v: 1 }]) {
    a.send({ t: 'state', patch: { delayMs: bad } })
    const st = (await a.next('state')).state
    assert.equal(st.delayMs, 250, `delayMs ${JSON.stringify(bad)} refused`)
  }
  a.send({ t: 'state', patch: { delayMs: 2500.5 } })                       // buffered mode: seconds
  assert.equal((await a.next('state')).state.delayMs, 2500.5)
  a.send({ t: 'state', patch: { delayMs: null } })
  assert.equal((await a.next('state')).state.delayMs, D, 'null puts the default back, never removes D')
  const b = await join('d1', 'receiver', 'R')
  assert.equal(b.welcome.state.delayMs, D, 'a receiver joining learns D from the welcome')
  a.ws.close(); b.ws.close()
})

test('fan-out: the sender\'s frames reach every receiver of its room, byte for byte, in order — and nobody else', async () => {
  const s = await join('f1', 'sender', 'S')
  const r1 = await join('f1', 'receiver', 'R1')
  const r2 = await join('f1', 'receiver', 'R2')
  const lab = await join('f1', 'lab', 'L')
  const other = await join('f2', 'receiver', 'elsewhere')
  const sent = Array.from({ length: 50 }, (_, i) => frame(i))
  for (const f of sent) s.ws.send(f)
  await settle(s, r1, r2, lab, other)
  for (const r of [r1, r2]) {
    assert.equal(r.frames.length, sent.length)
    r.frames.forEach((got, i) => assert.deepEqual(new Uint8Array(got), sent[i]))
  }
  assert.equal(s.frames.length, 0, 'not echoed to the sender')
  assert.equal(lab.frames.length, 0, 'a lab page gets no audio')
  assert.equal(other.frames.length, 0, 'rooms are apart')
  for (const c of [s, r1, r2, lab, other]) c.ws.close()
})

test('only a sender\'s well-formed frames are relayed', async () => {
  const s = await join('f3', 'sender', 'S')
  const r = await join('f3', 'receiver', 'R')
  const r2 = await join('f3', 'receiver', 'R2')
  r2.ws.send(frame(1))                                       // a receiver cannot broadcast
  s.ws.send(frame(2).subarray(0, 13))                        // header without audio
  s.ws.send(Uint8Array.of(7, ...frame(3).subarray(1)))       // unknown type
  s.ws.send(new Uint8Array(9000).fill(1, 0, 1))              // too large
  s.ws.send(frame(4))
  const lone = client(); await lone.open
  lone.ws.send(frame(5))                                     // not in a room
  await settle(s, r, r2, lone)
  assert.deepEqual(seqs(r), [4])
  assert.deepEqual(seqs(r2), [4])
  for (const c of [s, r, r2, lone]) c.ws.close()
})

test('one sender at a time: a second one waits until the first goes quiet or leaves', async () => {
  const a = await join('f4', 'sender', 'A')
  const b = await join('f4', 'sender', 'B')
  const r = await join('f4', 'receiver', 'R')
  a.ws.send(frame(1)); await settle(a)
  b.ws.send(frame(101)); await settle(b)                     // A sent just now: B is ignored
  a.ws.send(frame(2)); await settle(a)
  await new Promise((ok) => setTimeout(ok, 650))             // A quiet for longer than senderIdleMs (500)
  b.ws.send(frame(102)); await settle(b)                     // B takes the room over
  a.ws.send(frame(3)); await settle(a)                       // now A is the one ignored
  b.ws.send(frame(103)); await settle(b)
  b.ws.close(); await new Promise((ok) => setTimeout(ok, 100))
  a.ws.send(frame(4)); await settle(a, r)                    // the sender left: A takes over at once
  assert.deepEqual(seqs(r), [1, 2, 102, 103, 4])
  a.ws.close(); r.ws.close()
})

test('a receiver that cannot keep up has frames skipped, not queued, and the skips are counted', () => {
  const fake = (role, bufferedAmount) => ({ role, drops: 0, dirty: false, ws: { readyState: 1, bufferedAmount, send(d) { fake.sent.push([role, d]) } } })
  fake.sent = []
  const fast = fake('receiver', 0), slow = fake('receiver', 70_000), sender = fake('sender', 0), closing = { ...fake('receiver', 0), ws: { readyState: 2, bufferedAmount: 0, send() { throw new Error('sent to a closing socket') } } }
  const f = frame(9)
  assert.deepEqual(fanOut([fast, slow, sender, closing], f, 64 * 1024), { sent: 1, dropped: 1 })
  assert.equal(fake.sent.length, 1)
  assert.equal(fake.sent[0][1], f, 'the same bytes, not a copy')
  assert.deepEqual([fast.drops, slow.drops], [0, 1])
  assert.ok(slow.dirty, 'the roster is refreshed with the new count')
})

test('the roster carries each peer\'s skipped-frame count', async () => {
  const r = await join('f5', 'receiver', 'R')
  let ro = await r.next('roster')
  assert.deepEqual(ro.peers.map((p) => [p.name, p.drops]), [['R', 0]])
  r.ws.close()
})
