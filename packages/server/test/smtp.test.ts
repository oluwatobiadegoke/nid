import assert from 'node:assert/strict'
import { test } from 'node:test'
import nodemailer from 'nodemailer'
import { start } from './helpers.js'

test('mail over SMTP is stored with recipients from the envelope', async (t) => {
  const running = await start()
  t.after(() => running.close())
  const transport = nodemailer.createTransport({
    host: '127.0.0.1',
    port: running.smtpPort,
    secure: false,
    auth: { user: 'anything', pass: 'anything' },
  })
  const info = await transport.sendMail({
    from: 'Acme <no-reply@acme.com>',
    to: 'Ada <ada@inbox.test>',
    cc: 'ops@acme.com',
    bcc: 'hidden@inbox.test',
    subject: 'Your code',
    text: 'Your verification code is 604020',
    html: '<p>Your verification code is <b>604020</b></p>',
    attachments: [{ filename: 'hi.txt', content: 'hi' }],
  })
  assert.ok(info.messageId)
  const hidden = await running.server.store.listMessages('default', { to: 'hidden@inbox.test' })
  assert.equal(hidden.length, 1)
  const message = hidden[0]!
  assert.equal(message.provider, 'smtp')
  assert.equal(message.from, 'Acme <no-reply@acme.com>')
  assert.deepEqual(
    message.recipients.map((r) => [r.kind, r.address]),
    [
      ['to', 'ada@inbox.test'],
      ['cc', 'ops@acme.com'],
      ['bcc', 'hidden@inbox.test'],
    ],
  )
  assert.equal(message.recipients[0]?.name, 'Ada')
  assert.equal(message.extracted.code, '604020')
  assert.equal(message.attachments[0]?.filename, 'hi.txt')
  assert.match(message.raw, /Subject: Your code/)
  transport.close()
})

test('a message over the size limit is refused and nid keeps taking mail', async (t) => {
  const running = await start({ maxBodyBytes: 1024 })
  t.after(() => running.close())
  const transport = nodemailer.createTransport({ host: '127.0.0.1', port: running.smtpPort, secure: false })
  t.after(() => transport.close())
  await assert.rejects(
    transport.sendMail({ from: 'a@acme.com', to: 'big@inbox.test', subject: 'Big', text: 'x'.repeat(2048) }),
    (err: { responseCode?: number }) => err.responseCode === 552,
  )
  await transport.sendMail({ from: 'a@acme.com', to: 'small@inbox.test', subject: 'Small', text: 'Your code is 604020' })
  assert.equal((await running.server.store.listMessages('default', { to: 'big@inbox.test' })).length, 0)
  assert.equal((await running.server.store.listMessages('default', { to: 'small@inbox.test' })).length, 1)
})

test('STARTTLS is not offered, so plain clients never try to upgrade', async (t) => {
  const running = await start()
  t.after(() => running.close())
  const transport = nodemailer.createTransport({ host: '127.0.0.1', port: running.smtpPort, secure: false })
  await transport.sendMail({ from: 'a@acme.com', to: 'plain@inbox.test', subject: 'Plain', text: 'Plain' })
  assert.equal((await running.server.store.listMessages('default', { to: 'plain@inbox.test' })).length, 1)
  transport.close()
})
