import assert from 'node:assert/strict'
import { test } from 'node:test'
import { BrevoClient, BrevoError } from '@getbrevo/brevo'
import { Resend } from 'resend'
import { start } from './helpers.js'

test('the official Resend SDK sends, reads back and sees typed errors', async (t) => {
  const running = await start()
  t.after(() => running.close())
  const resend = new Resend('re_test_key', { baseUrl: running.url })
  const sent = await resend.emails.send({
    from: 'Acme <onboarding@acme.com>',
    to: ['sdk@inbox.test'],
    subject: 'Hello from the SDK',
    html: '<p>Your code is 718293</p>',
  })
  assert.equal(sent.error, null)
  assert.ok(sent.data?.id)
  const fetched = await resend.emails.get(sent.data!.id)
  assert.equal(fetched.data?.subject, 'Hello from the SDK')
  const stored = (await running.server.store.listMessages('default', { to: 'sdk@inbox.test' }))[0]
  assert.equal(stored?.extracted.code, '718293')

  const failed = await resend.emails.send({ to: ['sdk@inbox.test'], subject: 'No from', html: '<p>x</p>' } as never)
  assert.equal(failed.data, null)
  assert.equal(failed.error?.name, 'validation_error')

  const batch = await resend.batch.send([
    { from: 'a@acme.com', to: 'b1@inbox.test', subject: 'One', text: 'One' },
    { from: 'a@acme.com', to: 'b2@inbox.test', subject: 'Two', text: 'Two' },
  ])
  assert.equal(batch.data?.data.length, 2)
})

test('the official Brevo SDK sends and raises its own error on a bad request', async (t) => {
  const running = await start()
  t.after(() => running.close())
  const brevo = new BrevoClient({ apiKey: 'xkeysib-test', baseUrl: `${running.url}/v3`, maxRetries: 0 })
  const sent = await brevo.transactionalEmails.sendTransacEmail({
    sender: { name: 'Clinid', email: 'hello@clinid.com' },
    to: [{ email: 'brevo-sdk@inbox.test' }],
    subject: 'Your Clinid code',
    textContent: 'Use code 4411 to sign in.',
  })
  assert.match(String(sent.messageId), /@smtp-relay\.mailin\.fr>$/)
  const stored = (await running.server.store.listMessages('default', { to: 'brevo-sdk@inbox.test' }))[0]
  assert.equal(stored?.extracted.code, '4411')

  await assert.rejects(
    brevo.transactionalEmails.sendTransacEmail({ to: [{ email: 'x@inbox.test' }], subject: 'x', textContent: 'x' }),
    (err: unknown) => err instanceof BrevoError && err.statusCode === 400,
  )
})

test('the official SendGrid SDK sends and surfaces SendGrid errors', async (t) => {
  const running = await start()
  t.after(() => running.close())
  const sgMail = (await import('@sendgrid/mail')).default
  sgMail.setApiKey('SG.test')
  sgMail.client.setDefaultRequest('baseUrl', running.url)
  const [res] = await sgMail.send({
    to: 'sg-sdk@inbox.test',
    from: { email: 'hello@acme.com', name: 'Acme' },
    subject: 'Your code',
    text: 'Your code is 246810',
    html: '<p>Your code is 246810</p>',
  })
  assert.equal(res.statusCode, 202)
  assert.ok(res.headers['x-message-id'])
  const stored = (await running.server.store.listMessages('default', { to: 'sg-sdk@inbox.test' }))[0]
  assert.equal(stored?.extracted.code, '246810')
  assert.equal(stored?.from, 'Acme <hello@acme.com>')

  await sgMail.send(
    [
      { to: 'sg-one@inbox.test', substitutions: { code: '112233' } },
      { to: 'sg-two@inbox.test', substitutions: { code: '445566' } },
    ].map((p) => ({ ...p, from: 'hello@acme.com', subject: 'Code', text: 'Your code is {{code}}' })),
  )
  assert.equal((await running.server.store.listMessages('default', { to: 'sg-two@inbox.test' }))[0]?.extracted.code, '445566')

  await assert.rejects(
    sgMail.send({ to: 'sg-sdk@inbox.test', from: 'hello@acme.com', text: 'No subject' }),
    (err: { code?: number; response?: { body?: { errors?: Array<{ field: string }> } } }) =>
      err.code === 400 && err.response?.body?.errors?.[0]?.field === 'subject',
  )
})

test('the official Postmark SDK sends single, template and batch mail', async (t) => {
  const running = await start()
  t.after(() => running.close())
  const { ServerClient, Errors } = await import('postmark')
  const client = new ServerClient('pm-test', { useHttps: false, requestHost: new URL(running.url).host })
  const sent = await client.sendEmail({ From: 'hello@acme.com', To: 'pm-sdk@inbox.test', Subject: 'Code', TextBody: 'Code 135790' })
  assert.equal(sent.ErrorCode, 0)
  assert.ok(sent.MessageID)
  const stored = (await running.server.store.listMessages('default', { to: 'pm-sdk@inbox.test' }))[0]
  assert.equal(stored?.extracted.code, '135790')

  await client.sendEmailWithTemplate({ From: 'hello@acme.com', To: 'pm-tpl@inbox.test', TemplateAlias: 'otp', TemplateModel: { code: '864200' } })
  assert.equal((await running.server.store.listMessages('default', { to: 'pm-tpl@inbox.test' }))[0]?.extracted.code, '864200')

  const batch = await client.sendEmailBatch([
    { From: 'hello@acme.com', To: 'pm-b1@inbox.test', TextBody: 'One' },
    { From: 'hello@acme.com', To: 'pm-b2@inbox.test', TextBody: 'Two' },
  ])
  assert.equal(batch.length, 2)

  await assert.rejects(client.sendEmail({ From: 'hello@acme.com', To: 'pm-sdk@inbox.test' }), (err: unknown) => err instanceof Errors.ApiInputError)
})

test('the official Mailgun SDK sends with an attachment and sees Mailgun errors', async (t) => {
  const running = await start()
  t.after(() => running.close())
  const Mailgun = (await import('mailgun.js')).default
  const mg = new Mailgun(FormData).client({ username: 'api', key: 'key-test', url: running.url })
  const sent = await mg.messages.create('mg.acme.com', {
    from: 'Acme <hello@acme.com>',
    to: ['mg-sdk@inbox.test'],
    subject: 'Your code',
    text: 'Your code is 975310',
    'o:tag': ['auth'],
    attachment: [{ filename: 'hello.txt', data: Buffer.from('hello') }],
  })
  assert.equal(sent.status, 200)
  assert.match(String(sent.id), /@mg\.acme\.com>$/)
  const stored = (await running.server.store.listMessages('default', { to: 'mg-sdk@inbox.test' }))[0]
  assert.equal(stored?.extracted.code, '975310')
  assert.equal(stored?.attachments[0]?.filename, 'hello.txt')
  assert.equal(stored?.attachments[0]?.size, 5)

  const MailComposer = (await import('nodemailer/lib/mail-composer/index.js')).default
  const mimeMessage = await new MailComposer({
    from: 'hello@acme.com',
    to: 'mg-mime@inbox.test',
    subject: 'Built with nodemailer',
    text: 'Your code is 808080',
  }).compile().build()
  const viaMime = await mg.messages.create('mg.acme.com', { to: 'mg-mime@inbox.test', message: mimeMessage })
  assert.equal(viaMime.status, 200)
  const mimeStored = (await running.server.store.listMessages('default', { to: 'mg-mime@inbox.test' }))[0]
  assert.equal(mimeStored?.provider, 'mailgun')
  assert.equal(mimeStored?.subject, 'Built with nodemailer')
  assert.equal(mimeStored?.extracted.code, '808080')

  await assert.rejects(
    mg.messages.create('mg.acme.com', { to: ['mg-sdk@inbox.test'], text: 'No from' } as never),
    (err: { status?: number }) => err.status === 400,
  )
})
