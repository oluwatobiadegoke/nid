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
