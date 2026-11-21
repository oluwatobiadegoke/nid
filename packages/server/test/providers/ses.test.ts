import assert from 'node:assert/strict'
import { test } from 'node:test'
import MailComposer from 'nodemailer/lib/mail-composer/index.js'
import { createServer, type NidServer } from '../../src/index.js'

const headers = {
  authorization: 'AWS4-HMAC-SHA256 Credential=test/20261121/us-east-1/ses/aws4_request',
  'content-type': 'application/json',
}

async function sendV2(server: NidServer, body: unknown, h: Record<string, string> = headers) {
  const res = await server.app.request('/v2/email/outbound-emails', {
    method: 'POST',
    headers: h,
    body: JSON.stringify(body),
  })
  return { status: res.status, headers: res.headers, body: (await res.json()) as Record<string, unknown> }
}

async function sendBulk(server: NidServer, body: unknown) {
  const res = await server.app.request('/v2/email/outbound-bulk-emails', {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  })
  return { status: res.status, body: (await res.json()) as { BulkEmailEntryResults: Array<Record<string, unknown>> } }
}

async function sendV1(server: NidServer, params: URLSearchParams) {
  const res = await server.app.request('/', {
    method: 'POST',
    headers: {
      authorization: headers.authorization,
      'content-type': 'application/x-www-form-urlencoded',
    },
    body: params.toString(),
  })
  return { status: res.status, headers: res.headers, text: await res.text() }
}

test('SES v2 simple email returns MessageId and extracts code and link', async (t) => {
  const server = await createServer()
  t.after(() => server.close())
  const res = await sendV2(server, {
    FromEmailAddress: 'Acme <hello@acme.com>',
    Destination: { ToAddresses: ['Ada@Inbox.test'], CcAddresses: ['cc@acme.com'], BccAddresses: ['bcc@acme.com'] },
    ReplyToAddresses: ['help@acme.com'],
    ConfigurationSetName: 'auth-cfg',
    EmailTags: [{ Name: 'flow', Value: 'signin' }],
    Content: {
      Simple: {
        Subject: { Data: 'Your sign-in code' },
        Body: {
          Text: { Data: 'Code 482913' },
          Html: { Data: '<p>Code <b>482913</b></p><a href="https://acme.com/verify">Verify</a>' },
        },
        Headers: [{ Name: 'X-Custom', Value: '1' }],
      },
    },
  })
  assert.equal(res.status, 200)
  assert.ok(typeof res.body.MessageId === 'string')
  const stored = (await server.store.listMessages('default', { to: 'ada@inbox.test' }))[0]
  assert.ok(stored)
  assert.equal(stored.provider, 'ses')
  assert.equal(stored.providerId, res.body.MessageId)
  assert.equal(stored.extracted.code, '482913')
  assert.equal(stored.extracted.link, 'https://acme.com/verify')
  assert.deepEqual(stored.replyTo, ['help@acme.com'])
  assert.equal(stored.headers['X-Custom'], '1')
  assert.equal(stored.meta.configurationSet, 'auth-cfg')
  assert.deepEqual(stored.meta.tags, [{ name: 'flow', value: 'signin' }])
})

test('SES v2 raw and template sends parse MIME and TemplateData', async (t) => {
  const server = await createServer()
  t.after(() => server.close())
  const rawMime = await new MailComposer({
    from: 'hello@acme.com',
    to: 'raw@inbox.test',
    subject: 'Raw SES',
    text: 'Verification code: 912345',
  }).compile().build()
  const rawRes = await sendV2(server, {
    Content: { Raw: { Data: rawMime.toString('base64') } },
  })
  assert.equal(rawRes.status, 200)
  const rawStored = (await server.store.listMessages('default', { to: 'raw@inbox.test' }))[0]
  assert.equal(rawStored?.provider, 'ses')
  assert.equal(rawStored?.extracted.code, '912345')

  const tplRes = await sendV2(server, {
    FromEmailAddress: 'hello@acme.com',
    Destination: { ToAddresses: ['tpl@inbox.test'] },
    Content: {
      Template: {
        TemplateName: 'otp-template',
        TemplateData: JSON.stringify({ code: '776655', url: 'https://acme.com/go' }),
      },
    },
  })
  assert.equal(tplRes.status, 200)
  const tplStored = (await server.store.listMessages('default', { to: 'tpl@inbox.test' }))[0]
  assert.equal(tplStored?.meta.templateId, 'otp-template')
  assert.equal(tplStored?.extracted.code, '776655')
  assert.equal(tplStored?.extracted.link, 'https://acme.com/go')
})

test('SES v2 bulk sends handle per-entry results and rejections', async (t) => {
  const server = await createServer()
  t.after(() => server.close())
  const res = await sendBulk(server, {
    FromEmailAddress: 'hello@acme.com',
    DefaultContent: {
      Template: { TemplateName: 'bulk-otp', TemplateData: '{"code":"000000"}' },
    },
    BulkEmailEntries: [
      { Destination: { ToAddresses: ['b1@inbox.test'] }, ReplacementEmailContent: { ReplacementTemplate: { ReplacementTemplateData: '{"code":"111222"}' } } },
      { Destination: { ToAddresses: ['not-an-address'] } },
      { Destination: { ToAddresses: ['b2@inbox.test'] }, ReplacementEmailContent: { ReplacementTemplate: { ReplacementTemplateData: '{"code":"333444"}' } } },
    ],
  })
  assert.equal(res.status, 200)
  assert.equal(res.body.BulkEmailEntryResults[0]?.Status, 'SUCCESS')
  assert.equal(res.body.BulkEmailEntryResults[1]?.Status, 'MESSAGE_REJECTED')
  assert.equal(res.body.BulkEmailEntryResults[2]?.Status, 'SUCCESS')
  assert.equal((await server.store.listMessages('default', { to: 'b1@inbox.test' }))[0]?.extracted.code, '111222')
  assert.equal((await server.store.listMessages('default', { to: 'b2@inbox.test' }))[0]?.extracted.code, '333444')
  assert.equal((await server.store.listRejections('default', { to: 'not-an-address' })).length, 1)
})

test('SES v1 form SendEmail and SendRawEmail return XML receipts and errors', async (t) => {
  const server = await createServer()
  t.after(() => server.close())
  const res = await sendV1(
    server,
    new URLSearchParams({
      Action: 'SendEmail',
      Source: 'hello@acme.com',
      'Destination.ToAddresses.member.1': 'v1@inbox.test',
      'Message.Subject.Data': 'SES v1',
      'Message.Body.Text.Data': 'Your code is 246801',
    }),
  )
  assert.equal(res.status, 200)
  assert.match(res.headers.get('content-type') ?? '', /text\/xml/)
  assert.match(res.text, /<SendEmailResponse/)
  assert.match(res.text, /<MessageId>[^<]+<\/MessageId>/)
  const v1Stored = (await server.store.listMessages('default', { to: 'v1@inbox.test' }))[0]
  assert.equal(v1Stored?.extracted.code, '246801')
  assert.match(v1Stored?.raw ?? '', /^Action=SendEmail&Source=hello%40acme\.com&/)
  assert.match(v1Stored?.raw ?? '', /Message\.Body\.Text\.Data=Your\+code\+is\+246801$/)

  const rawMime = await new MailComposer({
    from: 'hello@acme.com',
    to: 'v1raw@inbox.test',
    subject: 'SES v1 raw',
    text: 'Code 554433',
  }).compile().build()
  const rawRes = await sendV1(
    server,
    new URLSearchParams({
      Action: 'SendRawEmail',
      'RawMessage.Data': rawMime.toString('base64'),
    }),
  )
  assert.equal(rawRes.status, 200)
  assert.match(rawRes.text, /<SendRawEmailResponse/)
  assert.equal((await server.store.listMessages('default', { to: 'v1raw@inbox.test' }))[0]?.extracted.code, '554433')

  const bccCompiled = new MailComposer({
    from: 'hello@acme.com',
    to: 'v1shown@inbox.test',
    bcc: 'v1hidden@inbox.test',
    subject: 'SES v1 bcc',
    text: 'Hidden copy',
  }).compile()
  bccCompiled.keepBcc = true
  const bccRes = await sendV1(
    server,
    new URLSearchParams({ Action: 'SendRawEmail', 'RawMessage.Data': (await bccCompiled.build()).toString('base64') }),
  )
  assert.equal(bccRes.status, 200)
  const hidden = (await server.store.listMessages('default', { to: 'v1hidden@inbox.test' }))[0]
  assert.equal(hidden?.recipients.find((r) => r.address === 'v1hidden@inbox.test')?.kind, 'bcc')

  const bad = await sendV1(
    server,
    new URLSearchParams({ Action: 'SendEmail', 'Destination.ToAddresses.member.1': 'v1bad@inbox.test' }),
  )
  assert.equal(bad.status, 400)
  assert.equal(bad.headers.get('x-amzn-errortype'), 'MissingParameter')
  assert.match(bad.text, /<ErrorResponse/)
  assert.equal((await server.store.listRejections('default', { to: 'v1bad@inbox.test' })).length, 1)
})

test('SES checks SigV4 authorization header and validates bad v2 requests', async (t) => {
  const server = await createServer()
  t.after(() => server.close())
  const unauth = await sendV2(server, {}, { 'content-type': 'application/json' })
  assert.equal(unauth.status, 403)
  assert.equal(unauth.headers.get('x-amzn-errortype'), 'MissingAuthenticationTokenException')

  const bad = await sendV2(server, {
    Destination: { ToAddresses: ['missingfrom@inbox.test'] },
    Content: { Simple: { Subject: { Data: 'Hi' }, Body: { Text: { Data: 'Hi' } } } },
  })
  assert.equal(bad.status, 400)
  assert.equal(bad.headers.get('x-amzn-errortype'), 'BadRequestException')
  assert.equal((await server.store.listRejections('default', { to: 'missingfrom@inbox.test' })).length, 1)
})

test('SES extracts the stable access key id for auth hooks', async (t) => {
  let seenValue: string | null = null
  const server = await createServer({
    auth: (credential) => {
      if (credential.provider !== 'ses') return { projectId: 'default', plan: 'free' }
      seenValue = credential.value
      return credential.value === 'AKIAEXAMPLEKEY' ? { projectId: 'ses-team', plan: 'pro' } : null
    },
  })
  t.after(() => server.close())

  const denied = await sendV2(server, {
    FromEmailAddress: 'hello@acme.com',
    Destination: { ToAddresses: ['a@inbox.test'] },
    Content: { Simple: { Subject: { Data: 'No' }, Body: { Text: { Data: 'No' } } } },
  })
  assert.equal(denied.status, 403)
  assert.equal(seenValue, 'test')

  const ok = await sendV2(
    server,
    {
      FromEmailAddress: 'hello@acme.com',
      Destination: { ToAddresses: ['a@inbox.test'] },
      Content: { Simple: { Subject: { Data: 'Yes' }, Body: { Text: { Data: 'Code 102938' } } } },
    },
    {
      authorization:
        'AWS4-HMAC-SHA256 Credential=AKIAEXAMPLEKEY/20261121/us-east-1/ses/aws4_request, SignedHeaders=host, Signature=deadbeef',
      'content-type': 'application/json',
    },
  )
  assert.equal(ok.status, 200)
  assert.equal(seenValue, 'AKIAEXAMPLEKEY')
  assert.equal((await server.store.listMessages('ses-team', { to: 'a@inbox.test' }))[0]?.extracted.code, '102938')
})
