import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createServer } from '../src/index.js'
import { get, resendHeaders, sendResend, sleep } from './helpers.js'

const base = { from: 'a@acme.com', to: 'signup@inbox.test' }

test('cursor, then wait returns only mail sent after it', async (t) => {
  const server = await createServer()
  t.after(() => server.close())
  await sendResend(server, { ...base, subject: 'Old', text: 'Old code 111111' })
  const { body: cursor } = await get(server, '/api/cursor')
  const pending = get(server, `/api/wait?to=signup@inbox.test&after=${cursor.cursor}&timeout=5`)
  await sleep(300)
  await sendResend(server, { ...base, subject: 'New', text: 'Your code is 222222' })
  const { status, body } = await pending
  assert.equal(status, 200)
  const message = body.message as { subject: string; extracted: { code: string } }
  assert.equal(message.subject, 'New')
  assert.equal(message.extracted.code, '222222')
})

test('has_code skips a welcome email sent just before the code', async (t) => {
  const server = await createServer()
  t.after(() => server.close())
  await sendResend(server, { ...base, subject: 'Welcome', text: 'Thanks for joining.' })
  await sendResend(server, { ...base, subject: 'Your code', text: 'Code: 335577' })
  const { body } = await get(server, '/api/wait?to=signup@inbox.test&has_code=true&timeout=1')
  assert.equal((body.message as { subject: string }).subject, 'Your code')
})

test('code_pattern overrides extraction at read time', async (t) => {
  const server = await createServer()
  t.after(() => server.close())
  await sendResend(server, { ...base, subject: 'Key', text: 'Your access key is ACME-77-ZED' })
  const { body } = await get(server, `/api/wait?to=signup@inbox.test&timeout=1&code_pattern=${encodeURIComponent('key is ([A-Z0-9-]+)')}`)
  assert.equal((body.message as { extracted: { code: string } }).extracted.code, 'ACME-77-ZED')
  const bad = await get(server, `/api/wait?to=signup@inbox.test&timeout=1&code_pattern=${encodeURIComponent('(')}`)
  assert.equal(bad.status, 400)
})

test('a timeout answers 404 and explains itself with recent rejections', async (t) => {
  const server = await createServer()
  t.after(() => server.close())
  await sendResend(server, { to: 'signup@inbox.test', subject: 'Hi', text: 'Hi' })
  const { status, body } = await get(server, '/api/wait?to=signup@inbox.test&timeout=0.3')
  assert.equal(status, 404)
  assert.equal(body.timedOut, true)
  assert.match(String(body.error), /Timed out waiting for mail to signup@inbox.test/)
  assert.match(String(body.error), /1 resend request was rejected \d+s ago with 422: Missing `from` field\./)
  assert.equal((body.recent_rejections as unknown[]).length, 1)
})

test('unknown query parameters are a 400, not a silent match', async (t) => {
  const server = await createServer()
  t.after(() => server.close())
  const { status, body } = await get(server, '/api/messages?subjet=hello')
  assert.equal(status, 400)
  assert.deepEqual(body, { error: 'Invalid query', details: ['Unknown parameter: subjet'] })
})

test('messages list, get with raw, attachments and delete', async (t) => {
  const server = await createServer()
  t.after(() => server.close())
  await sendResend(server, {
    ...base,
    subject: 'With file',
    text: 'See attached',
    attachments: [{ filename: 'a.txt', content: Buffer.from('abc').toString('base64'), content_type: 'text/plain' }],
  })
  await sendResend(server, { from: 'a@acme.com', to: 'other@inbox.test', subject: 'Other', text: 'Other' })
  const list = await get(server, '/api/messages?to=signup@inbox.test')
  const messages = list.body.messages as { id: number; raw?: string; attachments: { url: string }[] }[]
  assert.equal(messages.length, 1)
  assert.equal(messages[0]?.raw, undefined)
  const one = await get(server, `/api/messages/${messages[0]?.id}`)
  assert.equal(typeof (one.body.message as { raw: string }).raw, 'string')
  const file = await server.app.request(messages[0]!.attachments[0]!.url)
  assert.equal(file.status, 200)
  assert.equal(file.headers.get('content-type'), 'text/plain')
  assert.equal(await file.text(), 'abc')
  const cleared = await server.app.request('/api/messages?to=signup@inbox.test', { method: 'DELETE' })
  assert.deepEqual(await cleared.json(), { deleted: 1 })
  assert.equal(((await get(server, '/api/messages')).body.messages as unknown[]).length, 1)
  const all = await server.app.request('/api/messages', { method: 'DELETE' })
  assert.deepEqual(await all.json(), { deleted: 1 })
})

test('the stream sends new messages and rejections as events', async (t) => {
  const server = await createServer()
  t.after(() => server.close())
  const response = await server.app.request('/api/stream')
  assert.equal(response.headers.get('content-type')?.split(';')[0], 'text/event-stream')
  const reader = response.body!.getReader()
  const decoder = new TextDecoder()
  let seen = ''
  const readUntil = async (needle: string) => {
    while (!seen.includes(needle)) {
      const { value, done } = await reader.read()
      if (done) break
      seen += decoder.decode(value)
    }
  }
  await readUntil('event: ready')
  await sendResend(server, { ...base, subject: 'Streamed', text: 'Hi' })
  await readUntil('event: message')
  assert.match(seen, /"subject":"Streamed"/)
  await sendResend(server, { to: 'x@inbox.test', subject: 'Bad', text: 'Hi' })
  await readUntil('event: rejection')
  await reader.cancel()
})

test('only localhost-like hosts are answered unless allowed', async (t) => {
  const server = await createServer({ allowHosts: ['mail.internal.example'] })
  t.after(() => server.close())
  const evil = await server.app.request('/api/cursor', { headers: { host: 'evil.example.com' } })
  assert.equal(evil.status, 403)
  for (const host of ['localhost:4400', '127.0.0.1', '[::1]:4400', 'testinbox:4400', 'mail.internal.example']) {
    const ok = await server.app.request('/api/cursor', { headers: { host } })
    assert.equal(ok.status, 200, host)
  }
})

test('healthz, providers and the openapi document are served', async (t) => {
  const server = await createServer()
  t.after(() => server.close())
  assert.equal((await get(server, '/healthz')).body.ok, true)
  const providers = (await get(server, '/api/providers')).body.providers as { name: string }[]
  assert.deepEqual(providers.map((p) => p.name), ['resend', 'brevo'])
  const spec = await get(server, '/api/openapi.json')
  assert.equal(spec.body.openapi, '3.0.3')
  const page = await server.app.request('/')
  assert.equal(page.status, 200)
  assert.match(await page.text(), /testinbox/)
})

test('the auth and limits hooks pick the project and its retention', async (t) => {
  const server = await createServer({
    auth: (credential) => (credential.value === 'ti_live' ? { projectId: 'acme', plan: 'pro' } : null),
    limits: (project) => ({ maxBodyBytes: 1024, retentionHours: project.plan === 'pro' ? 168 : 24 }),
  })
  t.after(() => server.close())
  const denied = await sendResend(server, { ...base, subject: 'Hi', text: 'Hi' }, { ...resendHeaders, authorization: 'Bearer nope' })
  assert.equal(denied.status, 401)
  const accepted = await sendResend(server, { ...base, subject: 'Hi', text: 'Hi' }, { ...resendHeaders, authorization: 'Bearer ti_live' })
  assert.equal(accepted.status, 200)
  const stored = (await server.store.listMessages('acme', {}))[0]
  assert.ok(stored?.expiresAt)
  assert.equal((await server.store.listMessages('default', {})).length, 0)
  const unauthenticated = await server.app.request('/api/messages')
  assert.equal(unauthenticated.status, 401)
  const authenticated = await server.app.request('/api/messages', { headers: { authorization: 'Bearer ti_live' } })
  assert.equal(authenticated.status, 200)
})
