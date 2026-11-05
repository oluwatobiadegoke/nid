import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createServer } from '../../src/index.js'
import { get, resendHeaders, sendResend } from '../helpers.js'

const email = {
  from: 'Acme <onboarding@acme.com>',
  to: ['signup.8f3a@inbox.test'],
  cc: 'Ops <ops@acme.com>',
  bcc: ['audit@acme.com'],
  reply_to: 'help@acme.com',
  subject: 'Your sign-in code',
  html: '<p>Your code is <b>482913</b>. <a href="https://app.acme.com/verify?token=abc">Verify</a></p>',
  text: 'Your code is 482913. https://app.acme.com/verify?token=abc',
  headers: { 'X-Entity-Ref-ID': '123' },
  tags: [{ name: 'category', value: 'auth' }],
  attachments: [{ filename: 'hello.txt', content: Buffer.from('hello').toString('base64'), content_type: 'text/plain' }],
}

test('POST /emails answers like Resend and stores the message', async (t) => {
  const server = await createServer()
  t.after(() => server.close())
  const { status, body } = await sendResend(server, email)
  assert.equal(status, 200)
  assert.match(String(body.id), /^[0-9a-f-]{36}$/)
  const stored = (await server.store.listMessages('default', { to: 'signup.8f3a@inbox.test' }))[0]
  assert.ok(stored)
  assert.equal(stored.provider, 'resend')
  assert.equal(stored.providerId, body.id)
  assert.equal(stored.from, 'Acme <onboarding@acme.com>')
  assert.deepEqual(
    stored.recipients.map((r) => [r.kind, r.address, r.name]),
    [
      ['to', 'signup.8f3a@inbox.test', null],
      ['cc', 'ops@acme.com', 'Ops'],
      ['bcc', 'audit@acme.com', null],
    ],
  )
  assert.deepEqual(stored.replyTo, ['help@acme.com'])
  assert.equal(stored.extracted.code, '482913')
  assert.equal(stored.extracted.link, 'https://app.acme.com/verify?token=abc')
  assert.equal(stored.headers['X-Entity-Ref-ID'], '123')
  assert.deepEqual(stored.meta.tags, email.tags)
  assert.equal(stored.attachments[0]?.filename, 'hello.txt')
  assert.equal(stored.attachments[0]?.size, 5)
  assert.equal(JSON.parse(stored.raw).subject, 'Your sign-in code')
})

test('missing fields fail with Resend-shaped 422 errors and are recorded', async (t) => {
  const server = await createServer()
  t.after(() => server.close())
  const noFrom = await sendResend(server, { to: 'x@inbox.test', subject: 'Hi', text: 'Hi' })
  assert.equal(noFrom.status, 422)
  assert.deepEqual(noFrom.body, { statusCode: 422, message: 'Missing `from` field.', name: 'validation_error' })
  const noBody = await sendResend(server, { from: 'a@acme.com', to: 'Ex <X@inbox.test>', subject: 'Hi' })
  assert.equal(noBody.status, 422)
  assert.equal(noBody.body.name, 'validation_error')
  const rejections = await server.store.listRejections('default', { to: 'x@inbox.test' })
  assert.equal(rejections.length, 2)
  assert.equal(rejections[1]?.error, 'Missing `from` field.')
  assert.equal((await server.store.listMessages('default', {})).length, 0)
})

test('a missing or wrong kind of credential fails like production', async (t) => {
  const server = await createServer()
  t.after(() => server.close())
  const none = await sendResend(server, email, { 'content-type': 'application/json' })
  assert.equal(none.status, 401)
  assert.equal(none.body.name, 'missing_api_key')
  const wrongKind = await sendResend(server, email, { 'content-type': 'application/json', 'api-key': 'xkeysib-1' })
  assert.equal(wrongKind.status, 401)
  const anyBearer = await sendResend(server, email, { 'content-type': 'application/json', authorization: 'Bearer whatever' })
  assert.equal(anyBearer.status, 200)
})

test('Idempotency-Key repeats return the first id without a second message', async (t) => {
  const server = await createServer()
  t.after(() => server.close())
  const headers = { ...resendHeaders, 'idempotency-key': 'signup/8f3a' }
  const first = await sendResend(server, email, headers)
  const second = await sendResend(server, email, headers)
  assert.equal(first.body.id, second.body.id)
  assert.equal((await server.store.listMessages('default', {})).length, 1)
})

test('POST /emails/batch stores every email and answers with their ids', async (t) => {
  const server = await createServer()
  t.after(() => server.close())
  const res = await server.app.request('/emails/batch', {
    method: 'POST',
    headers: resendHeaders,
    body: JSON.stringify([
      { from: 'a@acme.com', to: 'one@inbox.test', subject: 'One', text: 'One' },
      { from: 'a@acme.com', to: 'two@inbox.test', subject: 'Two', text: 'Two' },
    ]),
  })
  assert.equal(res.status, 200)
  const body = (await res.json()) as { data: { id: string }[] }
  assert.equal(body.data.length, 2)
  assert.equal((await server.store.listMessages('default', {})).length, 2)
})

test('a refused batch is recorded against every recipient in it', async (t) => {
  const server = await createServer()
  t.after(() => server.close())
  const res = await server.app.request('/emails/batch', {
    method: 'POST',
    headers: resendHeaders,
    body: JSON.stringify([
      { from: 'a@acme.com', to: 'fine@inbox.test', subject: 'One', text: 'One' },
      { from: 'a@acme.com', to: 'other@inbox.test', text: 'No subject' },
    ]),
  })
  assert.equal(res.status, 422)
  assert.equal((await server.store.listRejections('default', { to: 'fine@inbox.test' })).length, 1)
})

test('GET /emails/:id returns the email the way Resend does', async (t) => {
  const server = await createServer()
  t.after(() => server.close())
  const { body } = await sendResend(server, email)
  const found = await get(server, `/emails/${body.id}`, resendHeaders)
  assert.equal(found.status, 200)
  assert.equal(found.body.object, 'email')
  assert.equal(found.body.id, body.id)
  assert.deepEqual(found.body.to, ['signup.8f3a@inbox.test'])
  assert.equal(found.body.last_event, 'delivered')
  const missing = await server.app.request('/emails/does-not-exist', { headers: resendHeaders })
  assert.equal(missing.status, 404)
  assert.equal(((await missing.json()) as { name: string }).name, 'not_found')
})

test('template sends keep the template id and variables and extract from them', async (t) => {
  const server = await createServer()
  t.after(() => server.close())
  const { status } = await sendResend(server, {
    to: 'tpl@inbox.test',
    template: { id: 'welcome', variables: { name: 'Ada', code: '990011' } },
  })
  assert.equal(status, 200)
  const stored = (await server.store.listMessages('default', { to: 'tpl@inbox.test' }))[0]
  assert.equal(stored?.meta.templateId, 'welcome')
  assert.equal(stored?.extracted.code, '990011')
})
