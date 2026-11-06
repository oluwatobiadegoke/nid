import assert from 'node:assert/strict'
import { createHmac, createPublicKey, createVerify } from 'node:crypto'
import { createServer as createHttpServer, type IncomingHttpHeaders } from 'node:http'
import type { AddressInfo } from 'node:net'
import { execFile } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { test } from 'node:test'
import nodemailer from 'nodemailer'
import { Resend } from 'resend'
import { sendgridWebhookPublicKey, type ServerOptions } from '../src/index.js'
import { brevoHeaders, json, sendBrevo, sendResend, start, type Running } from './helpers.js'

interface Received {
  path: string
  headers: IncomingHttpHeaders
  body: string
}

type Handler = (req: Received) => { status: number; body: string }

async function fakeApp(t: { after(fn: () => Promise<void>): void }, handler: Handler = () => ({ status: 200, body: 'ok' })) {
  const received: Received[] = []
  const server = createHttpServer((req, res) => {
    let body = ''
    req.on('data', (chunk) => (body += chunk))
    req.on('end', () => {
      const request = { path: req.url ?? '', headers: req.headers, body }
      received.push(request)
      const reply = handler(request)
      res.writeHead(reply.status, { 'content-type': 'application/json' }).end(reply.body)
    })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  t.after(() => new Promise<void>((resolve) => server.close(() => resolve())))
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, received }
}

async function nid(t: { after(fn: () => Promise<void>): void }, webhooks: ServerOptions['webhooks']): Promise<Running> {
  const running = await start({ webhooks })
  t.after(() => running.close())
  return running
}

async function trigger(running: Running, id: unknown, type: string) {
  const res = await running.server.app.request(`/api/messages/${id}/events`, json({ type }, { 'content-type': 'application/json' }))
  return { status: res.status, body: (await res.json()) as Record<string, unknown> }
}

async function latestId(running: Running): Promise<number> {
  return running.server.store.cursor('default')
}

const signIn = { subject: 'Your sign-in code', html: '<p>Your code is <b>482913</b>. <a href="https://app.acme.com/verify?t=1">Verify</a></p>' }

function clinidBrevoHandler(req: Received) {
  if (req.headers.authorization !== 'Bearer webhook-token') return { status: 401, body: '{"message":"Unauthorized"}' }
  const event = JSON.parse(req.body)
  if (Array.isArray(event) || !event.event || !event['message-id'] || typeof event.ts_epoch !== 'number') {
    return { status: 400, body: '{"message":"This event could not be read."}' }
  }
  return { status: 201, body: '{"received":true}' }
}

test('a Brevo bounce reaches the app with the token, message-id and job id the app looks up', async (t) => {
  const app = await fakeApp(t, clinidBrevoHandler)
  const running = await nid(t, { brevo: { url: `${app.url}/api/communications/webhooks/brevo`, secret: 'webhook-token' } })
  const sent = await sendBrevo(running.server, {
    sender: { email: 'hello@clinid.com', name: 'Clinid' },
    to: [{ email: 'Patient@Inbox.test' }],
    headers: { 'X-Mailin-custom': 'job_1' },
    tags: ['otp'],
    subject: signIn.subject,
    htmlContent: signIn.html,
  })

  const bounced = await trigger(running, await latestId(running), 'bounced')
  assert.equal(bounced.status, 200)
  assert.equal(bounced.body.delivered, true)
  assert.equal(bounced.body.appStatus, 201)
  assert.equal(bounced.body.appBody, '{"received":true}')
  assert.equal(typeof bounced.body.durationMs, 'number')
  assert.equal(app.received[0]?.path, '/api/communications/webhooks/brevo')
  const event = JSON.parse(app.received[0]?.body ?? '')
  assert.equal(event.event, 'hard_bounce')
  assert.equal(event['message-id'], sent.body.messageId)
  assert.equal(event['X-Mailin-custom'], 'job_1')
  assert.equal(event.email, 'patient@inbox.test')
  assert.deepEqual(event.tags, ['otp'])
  assert.match(event.reason, /does not exist/)
  assert.ok(Math.abs(event.ts_epoch - Date.now()) < 5000)

  const delivered = await trigger(running, await latestId(running), 'delivered')
  assert.equal(JSON.parse(app.received[1]?.body ?? '').event, 'delivered')
  assert.equal(delivered.body.delivered, true)
})

test('a webhook handler that fails shows its status and error in the test, and the CLI exits non-zero', async (t) => {
  const app = await fakeApp(t, () => ({ status: 500, body: '{"error":"Cannot read properties of undefined (reading \'email\')"}' }))
  const running = await nid(t, { brevo: { url: app.url } })
  await sendBrevo(running.server, { sender: { email: 'hello@acme.com' }, to: [{ email: 'ada@inbox.test' }], ...signIn, htmlContent: signIn.html })
  const id = await latestId(running)

  const result = await trigger(running, id, 'bounced')
  assert.equal(result.body.delivered, false)
  assert.equal(result.body.appStatus, 500)
  assert.match(String(result.body.appBody), /reading 'email'/)
  assert.equal(app.received[0]?.headers.authorization, undefined)

  const cli = fileURLToPath(new URL('../src/cli.ts', import.meta.url))
  const run = promisify(execFile)(process.execPath, ['--import', 'tsx', cli, 'webhook', String(id), 'bounced', '--url', running.url])
  const failed = await run.then(
    () => assert.fail('expected nid webhook to exit non-zero'),
    (err: { code: number; stdout: string }) => err,
  )
  assert.equal(failed.code, 1)
  assert.match(failed.stdout, /Your app answered 500 in \d+ ms/)
  assert.match(failed.stdout, /reading 'email'/)
})

test('an app that is not running is reported, not hidden', async (t) => {
  const running = await nid(t, { brevo: { url: 'http://127.0.0.1:9/webhooks/brevo' } })
  await sendBrevo(running.server, { sender: { email: 'hello@acme.com' }, to: [{ email: 'ada@inbox.test' }], ...signIn, htmlContent: signIn.html })
  const result = await trigger(running, await latestId(running), 'delivered')
  assert.equal(result.status, 200)
  assert.equal(result.body.delivered, false)
  assert.equal(result.body.appStatus, null)
  assert.match(String(result.body.error), /Could not reach your app at http:\/\/127\.0\.0\.1:9\/webhooks\/brevo/)
})

test('a Resend webhook passes the Resend SDK signature check', async (t) => {
  const secret = `whsec_${Buffer.from('resend-test-signing-secret').toString('base64')}`
  const app = await fakeApp(t, (req) => {
    try {
      const headers = { id: String(req.headers['svix-id']), timestamp: String(req.headers['svix-timestamp']), signature: String(req.headers['svix-signature']) }
      new Resend('re_x').webhooks.verify({ payload: req.body, headers, webhookSecret: secret })
      return { status: 200, body: '{"ok":true}' }
    } catch (err) {
      return { status: 400, body: JSON.stringify({ error: (err as Error).message }) }
    }
  })
  const running = await nid(t, { resend: { url: app.url, secret } })
  const sent = await sendResend(running.server, { from: 'Acme <hello@acme.com>', to: 'ada@inbox.test', tags: [{ name: 'flow', value: 'signin' }], ...signIn })

  const clicked = await trigger(running, await latestId(running), 'clicked')
  assert.equal(clicked.body.appStatus, 200, String(clicked.body.appBody))
  const event = JSON.parse(app.received[0]?.body ?? '')
  assert.equal(event.type, 'email.clicked')
  assert.equal(event.data.email_id, sent.body.id)
  assert.deepEqual(event.data.to, ['ada@inbox.test'])
  assert.deepEqual(event.data.tags, { flow: 'signin' })
  assert.equal(event.data.click.link, 'https://app.acme.com/verify?t=1')

  const wrong = await nid(t, { resend: { url: app.url, secret: `whsec_${Buffer.from('another-secret').toString('base64')}` } })
  await sendResend(wrong.server, { from: 'hello@acme.com', to: 'ada@inbox.test', ...signIn })
  assert.equal((await trigger(wrong, await latestId(wrong), 'bounced')).body.appStatus, 400)
})

test('a SendGrid event batch passes the check against nid\'s public key', async (t) => {
  const publicKey = createPublicKey(`-----BEGIN PUBLIC KEY-----\n${sendgridWebhookPublicKey}\n-----END PUBLIC KEY-----`)
  const app = await fakeApp(t, (req) => {
    const verify = createVerify('sha256')
    verify.update(String(req.headers['x-twilio-email-event-webhook-timestamp']) + req.body)
    const ok = verify.verify(publicKey, String(req.headers['x-twilio-email-event-webhook-signature']), 'base64')
    return ok ? { status: 200, body: '' } : { status: 403, body: '' }
  })
  const running = await nid(t, { sendgrid: { url: app.url } })
  const res = await running.server.app.request(
    '/v3/mail/send',
    json(
      {
        personalizations: [{ to: [{ email: 'ada@inbox.test' }], custom_args: { user_id: '42' } }],
        from: { email: 'hello@acme.com' },
        subject: signIn.subject,
        content: [{ type: 'text/html', value: signIn.html }],
      },
      { authorization: 'Bearer SG.test', 'content-type': 'application/json' },
    ),
  )
  const result = await trigger(running, await latestId(running), 'bounced')
  assert.equal(result.body.delivered, true)
  const [event] = JSON.parse(app.received[0]?.body ?? '')
  assert.equal(event.event, 'bounce')
  assert.equal(event.email, 'ada@inbox.test')
  assert.equal(event.user_id, '42')
  assert.equal(event.sg_message_id.split('.')[0], res.headers.get('x-message-id'))
})

test('a Mailgun webhook carries a signature the app can check with its signing key', async (t) => {
  const key = 'mailgun-signing-key'
  const app = await fakeApp(t, (req) => {
    const { signature } = JSON.parse(req.body)
    const expected = createHmac('sha256', key).update(signature.timestamp + signature.token).digest('hex')
    return expected === signature.signature ? { status: 200, body: '' } : { status: 406, body: '' }
  })
  const running = await nid(t, { mailgun: { url: app.url, secret: key } })
  const form = new FormData()
  form.append('from', 'hello@acme.com')
  form.append('to', 'ada@inbox.test')
  form.append('subject', signIn.subject)
  form.append('html', signIn.html)
  form.append('v:user-id', '42')
  const auth = { authorization: `Basic ${Buffer.from('api:key-test').toString('base64')}` }
  const sent = await (await running.server.app.request('/v3/mg.acme.com/messages', { method: 'POST', headers: auth, body: form })).json()

  const result = await trigger(running, await latestId(running), 'deferred')
  assert.equal(result.body.delivered, true)
  const data = JSON.parse(app.received[0]?.body ?? '')['event-data']
  assert.equal(data.event, 'failed')
  assert.equal(data.severity, 'temporary')
  assert.equal(`<${data.message.headers['message-id']}>`, sent.id)
  assert.deepEqual(data['user-variables'], { 'user-id': '42' })
})

test('a Postmark webhook URL with a user and password arrives as basic auth', async (t) => {
  const app = await fakeApp(t)
  const running = await nid(t, { postmark: { url: `http://hooks:s3cret@${app.url.slice('http://'.length)}/postmark` } })
  const res = await running.server.app.request(
    '/email',
    json(
      { From: 'hello@acme.com', To: 'ada@inbox.test', Subject: signIn.subject, HtmlBody: signIn.html, Tag: 'signin', Metadata: { user: '42' } },
      { 'x-postmark-server-token': 'pm-test', 'content-type': 'application/json', accept: 'application/json' },
    ),
  )
  const sent = (await res.json()) as { MessageID: string }
  const result = await trigger(running, await latestId(running), 'bounced')
  assert.equal(result.body.url, `${app.url}/postmark`)
  assert.equal(app.received[0]?.headers.authorization, `Basic ${Buffer.from('hooks:s3cret').toString('base64')}`)
  const bounce = JSON.parse(app.received[0]?.body ?? '')
  assert.equal(bounce.RecordType, 'Bounce')
  assert.equal(bounce.Type, 'HardBounce')
  assert.equal(bounce.MessageID, sent.MessageID)
  assert.equal(bounce.Email, 'ada@inbox.test')
  assert.equal(bounce.Tag, 'signin')
  assert.deepEqual(bounce.Metadata, { user: '42' })
})

test('nid says what to set when it cannot send a webhook', async (t) => {
  const running = await nid(t, { resend: { url: 'http://127.0.0.1:9' } })
  await sendBrevo(running.server, { sender: { email: 'hello@acme.com' }, to: [{ email: 'ada@inbox.test' }], ...signIn, htmlContent: signIn.html }, brevoHeaders)
  const brevoId = await latestId(running)
  const noUrl = await trigger(running, brevoId, 'bounced')
  assert.equal(noUrl.status, 400)
  assert.match(String(noUrl.body.error), /NID_BREVO_WEBHOOK_URL/)

  await sendResend(running.server, { from: 'hello@acme.com', to: 'ada@inbox.test', ...signIn })
  const noSecret = await trigger(running, await latestId(running), 'bounced')
  assert.equal(noSecret.status, 400)
  assert.match(String(noSecret.body.error), /NID_RESEND_WEBHOOK_SECRET/)

  const badType = await trigger(running, brevoId, 'bounce')
  assert.equal(badType.status, 400)
  assert.match(String(badType.body.error), /delivered, deferred, bounced, complained, opened, clicked/)
  assert.equal((await trigger(running, 999, 'bounced')).status, 404)

  const transport = nodemailer.createTransport({ host: '127.0.0.1', port: running.smtpPort, secure: false })
  await transport.sendMail({ from: 'hello@acme.com', to: 'ada@inbox.test', subject: 'Hi', text: 'Code 1234' })
  const smtp = await trigger(running, await latestId(running), 'bounced')
  assert.equal(smtp.status, 400)
  assert.match(String(smtp.body.error), /over smtp has no webhooks/)
})
