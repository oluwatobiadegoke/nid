import assert from 'node:assert/strict'
import { createServer as createHttpServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { test } from 'node:test'
import { createServer } from '../src/index.js'
import { get, json, sendResend, sleep } from './helpers.js'

test('fault rules return custom errors, respect count/provider/to scoping, and record rejections', async (t) => {
  const server = await createServer()
  t.after(() => server.close())

  const added = await server.app.request(
    '/api/faults',
    json(
      {
        provider: 'resend',
        to: 'flaky@inbox.test',
        status: 429,
        headers: { 'retry-after': '3' },
        body: { statusCode: 429, message: 'Too many requests', name: 'rate_limit_exceeded' },
        count: 1,
      },
      { 'content-type': 'application/json' },
    ),
  )
  assert.equal(added.status, 201)
  assert.equal(((await get(server, '/api/faults')).body.faults as unknown[]).length, 1)

  const otherRecipient = await sendResend(server, { from: 'a@acme.com', to: 'other@inbox.test', subject: 'Ok', text: 'Ok' })
  assert.equal(otherRecipient.status, 200)

  const hit = await server.app.request(
    '/emails',
    json(
      { from: 'a@acme.com', to: 'flaky@inbox.test', subject: 'First', text: 'First' },
      { authorization: 'Bearer re_x', 'content-type': 'application/json' },
    ),
  )
  assert.equal(hit.status, 429)
  assert.equal(hit.headers.get('retry-after'), '3')
  const rejections = await server.store.listRejections('default', { to: 'flaky@inbox.test' })
  assert.equal(rejections.length, 1)
  assert.equal(rejections[0]?.status, 429)
  assert.equal(rejections[0]?.error, 'Too many requests')

  const recovered = await sendResend(server, { from: 'a@acme.com', to: 'flaky@inbox.test', subject: 'Second', text: 'Second' })
  assert.equal(recovered.status, 200)
  assert.equal(((await get(server, '/api/faults')).body.faults as unknown[]).length, 0)

  await server.app.request(
    '/api/faults',
    json({ status: 200, delayMs: 60, count: null }, { 'content-type': 'application/json' }),
  )
  const started = performance.now()
  const delayed = await sendResend(server, { from: 'a@acme.com', to: 'slow@inbox.test', subject: 'Slow', text: 'Slow' })
  assert.equal(delayed.status, 200)
  assert.ok(performance.now() - started >= 50)
  const cleared = await server.app.request('/api/faults', { method: 'DELETE' })
  assert.deepEqual(await cleared.json(), { cleared: 1 })

  await server.app.request(
    '/api/faults',
    json({ provider: 'resend', status: 302, headers: { location: 'https://redirect.example' } }, { 'content-type': 'application/json' }),
  )
  const redir = await server.app.request(
    '/emails',
    json(
      { from: 'a@acme.com', to: 'redir@inbox.test', subject: 'R', text: 'R' },
      { authorization: 'Bearer re_x', 'content-type': 'application/json' },
    ),
  )
  assert.equal(redir.status, 302)
  assert.equal(redir.headers.get('location'), 'https://redirect.example')
  assert.equal((await server.store.listMessages('default', { to: 'redir@inbox.test' })).length, 0)
  assert.equal((await server.store.listRejections('default', { to: 'redir@inbox.test' })).length, 0)
})

test('magic addresses simulate ratelimit 429 and automatic webhooks, and autoWebhook fires on sends', async (t) => {
  const received: Array<{ path: string; body: Record<string, unknown> }> = []
  const app = createHttpServer((req, res) => {
    let body = ''
    req.on('data', (chunk) => (body += chunk))
    req.on('end', () => {
      received.push({ path: req.url ?? '', body: JSON.parse(body) as Record<string, unknown> })
      res.writeHead(200).end('ok')
    })
  })
  await new Promise<void>((resolve) => app.listen(0, '127.0.0.1', resolve))
  t.after(() => new Promise<void>((resolve) => app.close(() => resolve())))
  const appUrl = `http://127.0.0.1:${(app.address() as AddressInfo).port}`

  const secret = `whsec_${Buffer.from('magic-secret').toString('base64')}`
  const server = await createServer({
    webhooks: { resend: { url: `${appUrl}/hooks/resend`, secret } },
    autoWebhook: 'delivered',
  })

  const limited = await sendResend(server, { from: 'a@acme.com', to: 'ratelimit+1@inbox.test', subject: 'RL', text: 'RL' })
  assert.equal(limited.status, 429)
  assert.equal((await server.store.listRejections('default', { to: 'ratelimit+1@inbox.test' })).length, 1)

  await sendResend(server, {
    from: 'a@acme.com',
    to: ['normal-first@inbox.test', 'bounce+user@inbox.test'],
    subject: 'B',
    text: 'B',
  })
  await sendResend(
    server,
    { from: 'a@acme.com', to: 'normal@inbox.test', subject: 'N', text: 'N' },
    { authorization: 'Bearer re_test', 'content-type': 'application/json', 'idempotency-key': 'idem-1' },
  )
  await sendResend(
    server,
    { from: 'a@acme.com', to: 'normal@inbox.test', subject: 'N', text: 'N' },
    { authorization: 'Bearer re_test', 'content-type': 'application/json', 'idempotency-key': 'idem-1' },
  )

  for (let i = 0; i < 40 && received.length < 2; i++) await sleep(20)
  await sleep(40)
  assert.equal(received.length, 2)
  const bouncedEvent = received.find((r) => r.body.type === 'email.bounced')
  assert.ok(bouncedEvent)
  assert.deepEqual((bouncedEvent.body.data as { to: string[] }).to, ['bounce+user@inbox.test'])
  assert.deepEqual(
    received.map((r) => r.body.type).sort(),
    ['email.bounced', 'email.delivered'],
  )

  await sendResend(server, { from: 'a@acme.com', to: 'flush@inbox.test', subject: 'Flush', text: 'Flush' })
  await server.close()
  assert.equal(received.length, 3)
  assert.deepEqual((received[2]!.body.data as { to: string[] }).to, ['flush@inbox.test'])
})
