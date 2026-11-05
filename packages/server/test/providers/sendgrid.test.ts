import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createServer, type NidServer } from '../../src/index.js'

const headers = { authorization: 'Bearer SG.test', 'content-type': 'application/json' }

async function send(server: NidServer, body: unknown, h: Record<string, string> = headers) {
  const res = await server.app.request('/v3/mail/send', { method: 'POST', headers: h, body: JSON.stringify(body) })
  const text = await res.text()
  return { status: res.status, id: res.headers.get('x-message-id'), body: text ? JSON.parse(text) : null }
}

test('a sign-in email answers 202 with an X-Message-Id and lands in the inbox', async (t) => {
  const server = await createServer()
  t.after(() => server.close())
  const res = await send(server, {
    personalizations: [{ to: [{ email: 'Ada@Inbox.test', name: 'Ada' }], cc: [{ email: 'ops@acme.com' }] }],
    from: { email: 'hello@acme.com', name: 'Acme' },
    reply_to: { email: 'help@acme.com' },
    subject: 'Your sign-in code',
    content: [
      { type: 'text/plain', value: 'Your code is 482913' },
      { type: 'text/html', value: '<p>Your code is <b>482913</b>. <a href="https://acme.com/verify?t=1">Verify</a></p>' },
    ],
    attachments: [{ filename: 'note.txt', content: Buffer.from('note').toString('base64'), type: 'text/plain' }],
    categories: ['auth'],
    headers: { 'X-Ref': '9' },
  })
  assert.equal(res.status, 202)
  assert.equal(res.body, null)
  assert.match(res.id ?? '', /^[\w-]{22}$/)
  const stored = (await server.store.listMessages('default', { to: 'ada@inbox.test' }))[0]
  assert.ok(stored)
  assert.equal(stored.provider, 'sendgrid')
  assert.equal(stored.providerId, `${res.id}.0`)
  assert.equal(stored.from, 'Acme <hello@acme.com>')
  assert.deepEqual(stored.recipients.map((r) => [r.kind, r.address, r.name]), [
    ['to', 'ada@inbox.test', 'Ada'],
    ['cc', 'ops@acme.com', null],
  ])
  assert.deepEqual(stored.replyTo, ['help@acme.com'])
  assert.equal(stored.extracted.code, '482913')
  assert.equal(stored.extracted.link, 'https://acme.com/verify?t=1')
  assert.equal(stored.headers['X-Ref'], '9')
  assert.deepEqual(stored.meta.tags, ['auth'])
  assert.equal(stored.attachments[0]?.filename, 'note.txt')
  assert.equal(stored.attachments[0]?.contentType, 'text/plain')
})

test('each personalization of a template send becomes its own message with its own data', async (t) => {
  const server = await createServer()
  t.after(() => server.close())
  const res = await send(server, {
    from: { email: 'hello@acme.com' },
    template_id: 'd-123',
    personalizations: [
      { to: [{ email: 'one@inbox.test' }], dynamic_template_data: { code: '111222' } },
      { to: [{ email: 'two@inbox.test' }], dynamic_template_data: { code: '333444' }, subject: 'For two' },
    ],
  })
  assert.equal(res.status, 202)
  const one = (await server.store.listMessages('default', { to: 'one@inbox.test' }))[0]
  const two = (await server.store.listMessages('default', { to: 'two@inbox.test' }))[0]
  assert.equal(one?.extracted.code, '111222')
  assert.equal(two?.extracted.code, '333444')
  assert.equal(two?.subject, 'For two')
  assert.equal(one?.meta.templateId, 'd-123')
  assert.equal(two?.providerId, `${res.id}.1`)
  assert.equal(one?.recipients.length, 1)
})

test('bad sends fail with SendGrid-shaped 400 errors and show up as rejections', async (t) => {
  const server = await createServer()
  t.after(() => server.close())
  const content = [{ type: 'text/plain', value: 'Hi' }]
  const noFrom = await send(server, { personalizations: [{ to: [{ email: 'x@inbox.test' }] }], subject: 'Hi', content })
  assert.equal(noFrom.status, 400)
  assert.equal(noFrom.body.errors[0].field, 'from.email')
  const noTo = await send(server, { personalizations: [{}], from: { email: 'a@acme.com' }, subject: 'Hi', content })
  assert.equal(noTo.body.errors[0].field, 'personalizations.0.to')
  const badTo = await send(server, { personalizations: [{ to: [{ email: 'nope' }] }], from: { email: 'a@acme.com' }, subject: 'Hi', content })
  assert.deepEqual(badTo.body.errors[0].message, 'Does not contain a valid address.')
  const noContent = await send(server, { personalizations: [{ to: [{ email: 'x@inbox.test' }] }], from: { email: 'a@acme.com' }, subject: 'Hi' })
  assert.equal(noContent.body.errors[0].field, 'content')
  const named = await send(server, { personalizations: [{ to: [{ email: 'Bob <x@inbox.test>' }] }], from: { email: 'a@acme.com' }, subject: 'Hi', content })
  assert.equal(named.body.errors[0].field, 'personalizations.0.to.0.email')
  const duplicate = await send(server, {
    personalizations: [{ to: [{ email: 'x@inbox.test' }], cc: [{ email: 'X@inbox.test' }] }],
    from: { email: 'a@acme.com' },
    subject: 'Hi',
    content,
  })
  assert.equal(duplicate.body.errors[0].field, 'personalizations.0.cc')
  const rejections = await server.store.listRejections('default', { to: 'x@inbox.test' })
  assert.equal(rejections.length, 4)
  assert.equal(rejections[0]?.provider, 'sendgrid')
})

test('a missing API key gets the SendGrid 401', async (t) => {
  const server = await createServer()
  t.after(() => server.close())
  const res = await send(server, {}, { 'content-type': 'application/json' })
  assert.equal(res.status, 401)
  assert.match(res.body.errors[0].message, /authorization grant is invalid/)
})
