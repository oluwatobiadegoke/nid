import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createServer, type NidServer } from '../../src/index.js'

const auth = { authorization: `Basic ${Buffer.from('api:key-test').toString('base64')}` }

async function send(server: NidServer, form: FormData | URLSearchParams, headers: Record<string, string> = auth) {
  const res = await server.app.request('/v3/mg.acme.com/messages', { method: 'POST', headers, body: form })
  const text = await res.text()
  return { status: res.status, text, body: text.startsWith('{') ? JSON.parse(text) : null }
}

test('a multipart send with an attachment lands in the inbox and answers Queued', async (t) => {
  const server = await createServer()
  t.after(() => server.close())
  const form = new FormData()
  form.append('from', 'Acme <hello@acme.com>')
  form.append('to', '"Lovelace, Ada" <Ada@Inbox.test>, bob@inbox.test')
  form.append('cc', 'ops@acme.com')
  form.append('subject', 'Your sign-in code')
  form.append('text', 'Your code is 731900')
  form.append('html', '<p>Your code is <b>731900</b> <a href="https://acme.com/v?t=3">Verify</a></p>')
  form.append('o:tag', 'auth')
  form.append('o:tag', 'signup')
  form.append('h:reply-to', 'help@acme.com')
  form.append('h:X-Ref', '9')
  form.append('v:user-id', '123456')
  form.append('attachment', new File(['hello'], 'hello.txt', { type: 'text/plain' }))
  form.append('inline', new File(['png'], 'logo.png', { type: 'image/png' }))
  const res = await send(server, form)
  assert.equal(res.status, 200)
  assert.equal(res.body.message, 'Queued. Thank you.')
  assert.match(res.body.id, /^<\d+\.[0-9a-f]{16}@mg\.acme\.com>$/)
  const stored = (await server.store.listMessages('default', { to: 'ada@inbox.test' }))[0]
  assert.ok(stored)
  assert.equal(stored.provider, 'mailgun')
  assert.equal(stored.providerId, res.body.id)
  assert.deepEqual(stored.recipients.map((r) => [r.kind, r.address]), [
    ['to', 'ada@inbox.test'],
    ['to', 'bob@inbox.test'],
    ['cc', 'ops@acme.com'],
  ])
  assert.deepEqual(stored.replyTo, ['help@acme.com'])
  assert.equal(stored.extracted.code, '731900')
  assert.equal(stored.extracted.link, 'https://acme.com/v?t=3')
  assert.deepEqual(stored.meta.tags, ['auth', 'signup'])
  assert.deepEqual(stored.meta.customVariables, { 'user-id': '123456' })
  assert.equal(stored.meta.domain, 'mg.acme.com')
  assert.equal(stored.headers['X-Ref'], '9')
  assert.deepEqual(stored.attachments.map((a) => [a.filename, a.contentType, a.contentId, a.size]), [
    ['hello.txt', 'text/plain', null, 5],
    ['logo.png', 'image/png', 'logo.png', 3],
  ])
  const full = await server.store.getMessage('default', stored.id)
  assert.match(full?.raw ?? '', /"subject":"Your sign-in code"/)
})

test('recipient-variables send each person their own copy with their own code', async (t) => {
  const server = await createServer()
  t.after(() => server.close())
  const form = new URLSearchParams()
  form.append('from', 'hello@acme.com')
  form.append('to', 'one@inbox.test')
  form.append('to', 'Two@inbox.test')
  form.append('subject', 'Hi %recipient.name%')
  form.append('text', 'Your code is %recipient.code%')
  form.append('recipient-variables', JSON.stringify({ 'one@inbox.test': { name: 'One', code: '100200' }, 'Two@inbox.test': { name: 'Two', code: '300400' } }))
  const res = await send(server, form)
  assert.equal(res.status, 200)
  const one = (await server.store.listMessages('default', { to: 'one@inbox.test' }))[0]
  const two = (await server.store.listMessages('default', { to: 'two@inbox.test' }))[0]
  assert.equal(one?.subject, 'Hi One')
  assert.equal(one?.extracted.code, '100200')
  assert.equal(two?.extracted.code, '300400')
  assert.deepEqual(two?.recipients.map((r) => r.address), ['two@inbox.test'])
})

test('a template send reads its code from t:variables', async (t) => {
  const server = await createServer()
  t.after(() => server.close())
  const form = new URLSearchParams({ from: 'hello@acme.com', to: 'tpl@inbox.test', template: 'welcome', 't:variables': '{"code":"665544"}' })
  assert.equal((await send(server, form)).status, 200)
  const stored = (await server.store.listMessages('default', { to: 'tpl@inbox.test' }))[0]
  assert.equal(stored?.meta.templateId, 'welcome')
  assert.equal(stored?.extracted.code, '665544')
})

test('a template batch reads each person\'s code from v: fields filled by recipient-variables', async (t) => {
  const server = await createServer()
  t.after(() => server.close())
  const form = new URLSearchParams({
    from: 'hello@acme.com',
    to: 'p1@inbox.test, p2@inbox.test',
    template: 'otp',
    'v:code': '%recipient.code%',
    'recipient-variables': JSON.stringify({ 'p1@inbox.test': { code: '135791' }, 'p2@inbox.test': { code: '246802' } }),
  })
  assert.equal((await send(server, form)).status, 200)
  assert.equal((await server.store.listMessages('default', { to: 'p1@inbox.test' }))[0]?.extracted.code, '135791')
  assert.equal((await server.store.listMessages('default', { to: 'p2@inbox.test' }))[0]?.extracted.code, '246802')
})

test('bad sends fail with Mailgun 400 messages and a missing key gets Forbidden', async (t) => {
  const server = await createServer()
  t.after(() => server.close())
  const noFrom = await send(server, new URLSearchParams({ to: 'x@inbox.test', text: 'Hi' }))
  assert.equal(noFrom.status, 400)
  assert.deepEqual(noFrom.body, { message: "'from' parameter is missing" })
  const noTo = await send(server, new URLSearchParams({ from: 'a@acme.com', text: 'Hi' }))
  assert.equal(noTo.body.message, "'to' parameter is missing")
  const noBody = await send(server, new URLSearchParams({ from: 'a@acme.com', to: 'x@inbox.test' }))
  assert.match(noBody.body.message, /Need at least one of 'text', 'html' or 'template'/)
  const badTo = await send(server, new URLSearchParams({ from: 'a@acme.com', to: 'x@inbox.test, nope', text: 'Hi' }))
  assert.match(badTo.body.message, /not a valid address/)
  const tooMany = await send(server, new URLSearchParams({ from: 'a@acme.com', to: Array.from({ length: 1001 }, (_, i) => `u${i}@inbox.test`).join(','), text: 'Hi' }))
  assert.equal(tooMany.status, 400)
  assert.equal((await server.store.listRejections('default', { to: 'u1000@inbox.test' })).length, 1)
  assert.equal((await server.store.listRejections('default', { to: 'x@inbox.test' })).length, 3)
  const noKey = await send(server, new URLSearchParams({ from: 'a@acme.com', to: 'x@inbox.test', text: 'Hi' }), {})
  assert.equal(noKey.status, 401)
  assert.equal(noKey.text, 'Forbidden')
  const domainAsUser = { authorization: `Basic ${Buffer.from('mg.acme.com:key-test').toString('base64')}` }
  const wrongUser = await send(server, new URLSearchParams({ from: 'a@acme.com', to: 'x@inbox.test', text: 'Hi' }), domainAsUser)
  assert.equal(wrongUser.status, 401)
})
