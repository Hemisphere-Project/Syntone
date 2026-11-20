// node --test — the relay over a real WebSocket on localhost.
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import WebSocket from 'ws'
import { start } from '../server/index.js'
import { ClockSync } from '../shared/clock.js'

let srv, base
before(async () => { srv = await start({ port: 0, host: '127.0.0.1', silentMs: 1500 }); base = `127.0.0.1:${srv.port}` })
after(() => { for (const c of srv.wss.clients) c.terminate(); srv.wss.close(); srv.server.close() })

function client() {
  const ws = new WebSocket(`ws://${base}/ws`)
  const queue = [], waiters = []
  ws.on('message', (raw) => { const m = JSON.parse(raw); const i = waiters.findIndex((w) => w.t === m.t); if (i >= 0) waiters.splice(i, 1)[0].ok(m); else queue.push(m) })
  const next = (t) => new Promise((ok, ko) => {
    const i = queue.findIndex((m) => m.t === t)
    if (i >= 0) return ok(queue.splice(i, 1)[0])
    waiters.push({ t, ok }); setTimeout(() => ko(new Error(`timeout waiting for ${t}`)), 4000)
  })
  const send = (m) => ws.send(JSON.stringify(m))
  return { ws, next, send, open: new Promise((ok) => ws.on('open', ok)) }
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
  assert.deepEqual((await a.next('state')).state, { stagger: true })

  a.ws.close()
  await new Promise((ok) => setTimeout(ok, 100))
  const c = client(); await c.open
  c.send({ t: 'hello', room: 'r1', role: 'lab', name: 'C' })
  const wc = await c.next('welcome')
  assert.equal(wc.slot, 0, 'the freed slot is taken again')
  assert.deepEqual(wc.state, { stagger: true }, 'a newcomer gets the room state')
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
  assert.deepEqual((await a.next('state')).state, { mode: 'raw', run: false, n: 3 })
  const many = Object.fromEntries(Array.from({ length: 40 }, (_, i) => ['k' + i, i]))
  a.send({ t: 'state', patch: many })                      // too many keys: refused whole
  a.send({ t: 'state', patch: { n: null } })               // null removes a key
  assert.deepEqual((await a.next('state')).state, { mode: 'raw', run: false })
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
