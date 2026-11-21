import assert from 'node:assert/strict'
import { createServer as createHttpServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { test } from 'node:test'
import { createServer } from '../src/index.js'
import { magicMatchFor } from '../src/ingest/faults.js'
import { get, json, sendResend, sleep } from './helpers.js'

test('magic names act only at inbox.test', () => {
  assert.deepEqual(magicMatchFor(['Bounce+1@Inbox.test']), { action: 'bounced', recipient: 'bounce+1@inbox.test' })
  assert.equal(magicMatchFor(['bounce@customer.com', 'ratelimit@customer.com', 'bounce@sub.inbox.test']), null)
  assert.equal(magicMatchFor(['bounce@inbox.test', 'ratelimit@inbox.test'])?.action, 'ratelimit')
  assert.equal(magicMatchFor(['defer@inbox.test', 'bounce@inbox.test'])?.action, 'deferred')
})

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
  const plain = await server.app.request('/api/faults', { method: 'POST', headers: { 'content-type': 'text/plain' }, body: '{"status":500}' })
  assert.equal(plain.status, 415)
  const tooLow = await server.app.request('/api/faults', json({ status: 100 }, { 'content-type': 'application/json' }))
  assert.equal(tooLow.status, 400)
  const badHeader = await server.app.request('/api/faults', json({ headers: { 'bad header': 'x' } }, { 'content-type': 'application/json' }))
  assert.equal(badHeader.status, 400)
  const lengthHeader = await server.app.request('/api/faults', json({ headers: { 'Content-Length': '3' } }, { 'content-type': 'application/json' }))
  assert.equal(lengthHeader.status, 400)
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
  assert.equal(limited.body.name, 'rate_limit_exceeded')
  assert.equal(limited.body.message, 'Rate limit exceeded')
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

test('a webhook answered after its message was deleted is not recorded', async (t) => {
  let answer: (() => void) | null = null
  const app = createHttpServer((req, res) => {
    req.resume()
    answer = () => res.writeHead(200).end('ok')
  })
  await new Promise<void>((resolve) => app.listen(0, '127.0.0.1', resolve))
  t.after(() => new Promise<void>((resolve) => app.close(() => resolve())))
  const server = await createServer({
    webhooks: { resend: { url: `http://127.0.0.1:${(app.address() as AddressInfo).port}/hooks`, secret: `whsec_${Buffer.from('late').toString('base64')}` } },
    autoWebhook: 'delivered',
  })
  await sendResend(server, { from: 'a@acme.com', to: 'late@inbox.test', subject: 'Late', text: 'Late' })
  for (let i = 0; i < 100 && !answer; i++) await sleep(10)
  const [message] = await server.store.listMessages('default', {})
  await server.store.deleteMessage('default', message!.id)
  answer!()
  await server.close()
  assert.deepEqual(await server.store.listWebhookDeliveries('default', message!.id), [])
})

test('a fault keeps the content type it was given, in any case', async (t) => {
  const server = await createServer()
  t.after(() => server.close())
  await server.app.request(
    '/api/faults',
    json({ status: 500, headers: { 'Content-Type': 'text/xml' }, body: '<Error>boom</Error>' }, { 'content-type': 'application/json' }),
  )
  const failed = await server.app.request(
    '/emails',
    json({ from: 'a@acme.com', to: 'xml@inbox.test', subject: 'X', text: 'X' }, { authorization: 'Bearer re_x', 'content-type': 'application/json' }),
  )
  assert.equal(failed.status, 500)
  assert.equal(failed.headers.get('content-type'), 'text/xml')
  assert.equal(await failed.text(), '<Error>boom</Error>')

  const send = () =>
    server.app.request(
      '/emails',
      json({ from: 'a@acme.com', to: 'xml@inbox.test', subject: 'X', text: 'X' }, { authorization: 'Bearer re_x', 'content-type': 'application/json' }),
    )
  const add = (rule: unknown) => server.app.request('/api/faults', json(rule, { 'content-type': 'application/json' }))
  await add({ status: 429, headers: { 'Content-Type': 'application/problem+json' }, body: { title: 'Too Many Requests' } })
  const problem = await send()
  assert.equal(problem.headers.get('content-type'), 'application/problem+json')
  assert.deepEqual(await problem.json(), { title: 'Too Many Requests' })
  await add({ status: 304, body: { a: 1 } })
  const notModified = await send()
  assert.equal(notModified.status, 304)
  assert.equal(await notModified.text(), '')
  await add({ status: 429, body: { ErrorCode: 429, Message: 'Slow down' } })
  await send()
  assert.equal((await server.store.listRejections('default', { to: 'xml@inbox.test' }))[0]?.error, 'Slow down')
})
