// node --test — the relay over a real WebSocket on localhost.
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import WebSocket from 'ws'
import { start } from '../server/index.js'
import { ClockSync } from '../shared/clock.js'

let srv, base
before(async () => { srv = await start({ port: 0, host: '127.0.0.1' }); base = `127.0.0.1:${srv.port}` })
after(() => { for (const c of srv.wss.clients) c.terminate(); srv.wss.close(); srv.server.close() })

function client() {
  const ws = new WebSocket(`ws://${base}/ws`)
  const queue = [], waiters = []
  ws.on('message', (raw) => { const m = JSON.parse(raw); const i = waiters.findIndex((w) => w.t === m.t); if (i >= 0) waiters.splice(i, 1)[0].ok(m); else queue.push(m) })
  const next = (t) => new Promise((ok, ko) => {
    const i = queue.findIndex((m) => m.t === t)
    if (i >= 0) return ok(queue.splice(i, 1)[0])
    waiters.push({ t, ok }); setTimeout(() => ko(new Error(`timeout waiting for ${t}`)), 2000)
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

test('garbage does not kill the connection', async () => {
  const c = client(); await c.open
  c.ws.send('not json'); c.ws.send(Buffer.from([1, 2, 3])); c.ws.send('null'); c.ws.send('{"t":"state"}')
  c.send({ t: 'ping', id: 1, t0: 0 })
  assert.equal((await c.next('pong')).id, 1)
  c.ws.close()
})
