import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createServer, type NidServer } from '../../src/index.js'

const headers = { 'x-postmark-server-token': 'pm-test', 'content-type': 'application/json', accept: 'application/json' }

async function send(server: NidServer, path: string, body: unknown, h: Record<string, string> = headers) {
  const res = await server.app.request(path, { method: 'POST', headers: h, body: JSON.stringify(body) })
  return { status: res.status, body: await res.json() }
}

test('POST /email answers with a Postmark receipt and stores the message', async (t) => {
  const server = await createServer()
  t.after(() => server.close())
  const res = await send(server, '/email', {
    From: 'Acme <hello@acme.com>',
    To: '"Lovelace, Ada" <Ada@Inbox.test>, bob@inbox.test',
    Cc: 'ops@acme.com',
    ReplyTo: 'help@acme.com',
    Subject: 'Your sign-in code',
    HtmlBody: '<p>Your code is <b>551200</b></p>',
    TextBody: 'Your code is 551200',
    Tag: 'auth',
    Metadata: { userId: 'u_1' },
    Headers: [{ Name: 'X-Ref', Value: '9' }],
    Attachments: [{ Name: 'logo.png', Content: Buffer.from('png').toString('base64'), ContentType: 'image/png', ContentID: 'cid:logo' }],
    MessageStream: 'outbound',
  })
  assert.equal(res.status, 200)
  assert.equal(res.body.ErrorCode, 0)
  assert.equal(res.body.Message, 'OK')
  assert.equal(res.body.To, 'ada@inbox.test, bob@inbox.test')
  assert.match(res.body.MessageID, /^[0-9a-f-]{36}$/)
  const stored = (await server.store.listMessages('default', { to: 'ada@inbox.test' }))[0]
  assert.ok(stored)
  assert.equal(stored.provider, 'postmark')
  assert.equal(stored.providerId, res.body.MessageID)
  assert.deepEqual(stored.recipients.map((r) => [r.kind, r.address, r.name]), [
    ['to', 'ada@inbox.test', 'Lovelace, Ada'],
    ['to', 'bob@inbox.test', null],
    ['cc', 'ops@acme.com', null],
  ])
  assert.deepEqual(stored.replyTo, ['help@acme.com'])
  assert.equal(stored.extracted.code, '551200')
  assert.equal(stored.headers['X-Ref'], '9')
  assert.deepEqual(stored.meta.tags, ['auth'])
  assert.deepEqual(stored.meta.metadata, { userId: 'u_1' })
  assert.equal(stored.attachments[0]?.contentId, 'logo')
})

test('a Bcc-only send with unset fields as null is accepted and its receipt has no To', async (t) => {
  const server = await createServer()
  t.after(() => server.close())
  const res = await send(server, '/email', { From: 'a@acme.com', To: null, Cc: null, Bcc: 'list@inbox.test', HtmlBody: null, TextBody: 'Code 777111' })
  assert.equal(res.status, 200)
  assert.equal(res.body.To, undefined)
  const stored = (await server.store.listMessages('default', { to: 'list@inbox.test' }))[0]
  assert.equal(stored?.recipients[0]?.kind, 'bcc')
})

test('a template send reads its code and link from the TemplateModel', async (t) => {
  const server = await createServer()
  t.after(() => server.close())
  const res = await send(server, '/email/withTemplate/', {
    From: 'hello@acme.com',
    To: 'tpl@inbox.test',
    TemplateAlias: 'welcome',
    TemplateModel: { code: '908172', action_url: 'https://acme.com/welcome?t=2' },
  })
  assert.equal(res.status, 200)
  const stored = (await server.store.listMessages('default', { to: 'tpl@inbox.test' }))[0]
  assert.equal(stored?.meta.templateId, 'welcome')
  assert.equal(stored?.extracted.code, '908172')
  assert.equal(stored?.extracted.link, 'https://acme.com/welcome?t=2')
})

test('a template batch takes its emails from Messages and reads each code from the model', async (t) => {
  const server = await createServer()
  t.after(() => server.close())
  const templated = await send(server, '/email/batchWithTemplates', {
    Messages: [{ From: 'a@acme.com', To: 'b3@inbox.test', TemplateId: 4, TemplateModel: { code: '424242' } }],
  })
  assert.equal(templated.body.length, 1)
  assert.equal((await server.store.listMessages('default', { to: 'b3@inbox.test' }))[0]?.extracted.code, '424242')
})

test('a batch with one bad message still sends the others and reports the bad one in its slot', async (t) => {
  const server = await createServer()
  t.after(() => server.close())
  const res = await send(server, '/email/batch', [
    { From: 'a@acme.com', To: 'good1@inbox.test', TextBody: 'Code 111000' },
    { From: 'a@acme.com', To: 'not-an-address', TextBody: 'Hi' },
    { From: 'a@acme.com', To: 'good2@inbox.test', TextBody: 'Code 222000' },
  ])
  assert.equal(res.status, 200)
  assert.deepEqual(res.body.map((r: { ErrorCode: number }) => r.ErrorCode), [0, 300, 0])
  assert.equal(res.body[2].To, 'good2@inbox.test')
  assert.equal((await server.store.listMessages('default', { to: 'good2@inbox.test' }))[0]?.extracted.code, '222000')
  assert.equal((await server.store.listRejections('default', {})).length, 1)
})

test('bad sends fail with Postmark 422 errors and a missing token gets the 401', async (t) => {
  const server = await createServer()
  t.after(() => server.close())
  const noTo = await send(server, '/email', { From: 'a@acme.com', TextBody: 'Hi' })
  assert.equal(noTo.status, 422)
  assert.deepEqual(noTo.body, { ErrorCode: 300, Message: 'Zero recipients specified' })
  const badTo = await send(server, '/email', { From: 'a@acme.com', To: 'nope', TextBody: 'Hi' })
  assert.equal(badTo.body.ErrorCode, 300)
  assert.match(badTo.body.Message, /Illegal email address 'nope'/)
  const noBody = await send(server, '/email', { From: 'a@acme.com', To: 'x@inbox.test' })
  assert.equal(noBody.body.Message, 'Provide either email TextBody or HtmlBody or both.')
  const noTemplate = await send(server, '/email/withTemplate', { From: 'a@acme.com', To: 'x@inbox.test' })
  assert.equal(noTemplate.body.ErrorCode, 1101)
  const badReplyTo = await send(server, '/email', { From: 'a@acme.com', To: 'x@inbox.test', ReplyTo: 'support', TextBody: 'Hi' })
  assert.match(badReplyTo.body.Message, /Error parsing 'ReplyTo'/)
  assert.equal((await server.store.listRejections('default', { to: 'x@inbox.test' })).length, 3)
  const noToken = await send(server, '/email', {}, { 'content-type': 'application/json' })
  assert.equal(noToken.status, 401)
  assert.equal(noToken.body.ErrorCode, 10)
})

test('every refused message in a large batch can still be found by its recipient', async (t) => {
  const server = await createServer()
  t.after(() => server.close())
  const items = Array.from({ length: 60 }, (_, i) => ({ From: 'noreply', To: `user_${i}@inbox.test`, TextBody: 'Hi' }))
  const res = await send(server, '/email/batch', items)
  assert.equal(res.status, 200)
  assert.equal((await server.store.listRejections('default', { to: 'user_0@inbox.test', limit: 1 })).length, 1)
})
