import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createServer } from '../../src/index.js'
import { brevoHeaders, sendBrevo } from '../helpers.js'

const email = {
  sender: { name: 'Clinid', email: 'hello@clinid.com' },
  to: [{ email: 'Dr.Ada@inbox.test', name: 'Ada' }],
  cc: [{ email: 'ops@clinid.com' }],
  replyTo: { email: 'support@clinid.com' },
  subject: 'Your Clinid sign-in code',
  htmlContent: '<p>Use code <b>7731</b> to sign in.</p>',
  textContent: 'Use code 7731 to sign in.',
  headers: { 'X-Sib-Sandbox': 'drop' },
  tags: ['auth'],
  attachment: [{ name: 'note.txt', content: Buffer.from('note').toString('base64') }],
}

test('POST /v3/smtp/email answers 201 with a messageId and stores the message', async (t) => {
  const server = await createServer()
  t.after(() => server.close())
  const { status, body } = await sendBrevo(server, email)
  assert.equal(status, 201)
  assert.match(String(body.messageId), /^<\d+\.[0-9a-f]+@smtp-relay\.mailin\.fr>$/)
  const stored = (await server.store.listMessages('default', { to: 'dr.ada@inbox.test' }))[0]
  assert.ok(stored)
  assert.equal(stored.provider, 'brevo')
  assert.equal(stored.from, 'Clinid <hello@clinid.com>')
  assert.equal(stored.recipients[0]?.name, 'Ada')
  assert.equal(stored.recipients[1]?.kind, 'cc')
  assert.deepEqual(stored.replyTo, ['support@clinid.com'])
  assert.equal(stored.extracted.code, '7731')
  assert.equal(stored.meta.sandbox, true)
  assert.deepEqual(stored.meta.tags, ['auth'])
  assert.equal(stored.attachments[0]?.filename, 'note.txt')
})

test('missing parameters fail with Brevo-shaped 400 errors', async (t) => {
  const server = await createServer()
  t.after(() => server.close())
  const noSender = await sendBrevo(server, { to: [{ email: 'x@inbox.test' }], subject: 'Hi', textContent: 'Hi' })
  assert.equal(noSender.status, 400)
  assert.deepEqual(noSender.body, { code: 'missing_parameter', message: 'sender is missing' })
  const noTo = await sendBrevo(server, { sender: { email: 'a@b.co' }, subject: 'Hi', textContent: 'Hi' })
  assert.deepEqual(noTo.body, { code: 'missing_parameter', message: 'to is missing' })
  const badEmail = await sendBrevo(server, { sender: { email: 'a@b.co' }, to: [{ email: 'nope' }], subject: 'Hi', textContent: 'Hi' })
  assert.equal(badEmail.body.code, 'invalid_parameter')
  assert.equal((await server.store.listRejections('default', {})).length, 3)
})

test('the api-key header is the credential', async (t) => {
  const server = await createServer()
  t.after(() => server.close())
  const none = await sendBrevo(server, email, { 'content-type': 'application/json' })
  assert.equal(none.status, 401)
  assert.deepEqual(none.body, { code: 'unauthorized', message: 'Key not found' })
  const bearerOnly = await sendBrevo(server, email, { 'content-type': 'application/json', authorization: 'Bearer x' })
  assert.equal(bearerOnly.status, 401)
})

test('template sends without a body extract from params', async (t) => {
  const server = await createServer()
  t.after(() => server.close())
  const { status } = await sendBrevo(server, {
    to: [{ email: 'tpl@inbox.test' }],
    templateId: 7,
    params: { otp: '551200', link: 'https://getclinid.com/v/1' },
  })
  assert.equal(status, 201)
  const stored = (await server.store.listMessages('default', { to: 'tpl@inbox.test' }))[0]
  assert.equal(stored?.meta.templateId, 7)
  assert.equal(stored?.extracted.code, '551200')
  assert.equal(stored?.extracted.link, 'https://getclinid.com/v/1')
})

test('messageVersions store one message per version, even with an idempotency key', async (t) => {
  const server = await createServer()
  t.after(() => server.close())
  const { status, body } = await sendBrevo(server, {
    sender: { email: 'a@b.co' },
    subject: 'Hello',
    textContent: 'Hello',
    to: [{ email: 'ignored@inbox.test' }],
    messageVersions: [
      { to: [{ email: 'v1@inbox.test' }], params: { name: 'One' } },
      { to: [{ email: 'v2@inbox.test' }], subject: 'Hello two' },
    ],
  }, { ...brevoHeaders, 'idempotency-key': 'signup-42' })
  assert.equal(status, 201)
  const ids = body.messageIds as string[]
  assert.equal(new Set(ids).size, 2)
  assert.equal((await server.store.listMessages('default', { to: 'v2@inbox.test' }))[0]?.subject, 'Hello two')
})

test('the SDK-style request is accepted with any key', async (t) => {
  const server = await createServer()
  t.after(() => server.close())
  const { status } = await sendBrevo(server, email, { ...brevoHeaders, 'api-key': 'anything' })
  assert.equal(status, 201)
})
