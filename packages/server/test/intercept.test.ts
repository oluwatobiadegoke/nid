import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import https from 'node:https'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { promisify } from 'node:util'
import { test } from 'node:test'
import { createServer, shouldInterceptHost } from '../src/index.js'

const runExec = promisify(execFile)

function distFile(relative: string): string {
  return fileURLToPath(new URL(`../dist/${relative}`, import.meta.url))
}

test('shouldInterceptHost matches supported provider endpoints only', () => {
  for (const host of [
    'api.resend.com',
    'API.RESEND.COM',
    'api.brevo.com',
    'api.sendinblue.com',
    'api.sendgrid.com',
    'api.eu.sendgrid.com',
    'api.postmarkapp.com',
    'api.mailgun.net',
    'api.eu.mailgun.net',
    'email.us-east-1.amazonaws.com',
    'email.eu-west-2.amazonaws.com',
    'email-fips.us-east-1.amazonaws.com',
    'email.cn-north-1.amazonaws.com.cn',
  ]) {
    assert.equal(shouldInterceptHost(host), true, host)
  }
  for (const host of ['example.com', 'resend.com', 'localhost', '127.0.0.1', 's3.us-east-1.amazonaws.com']) {
    assert.equal(shouldInterceptHost(host), false, host)
  }
})

test('preload hook redirects default production SDK constructors to nid with zero code changes', async (t) => {
  const interceptJs = distFile('intercept.js')
  assert.equal(existsSync(interceptJs), true)

  const server = await createServer()
  const listening = await server.listen({ port: 0, smtpPort: false })
  t.after(() => server.close())

  const script = `
    import { Resend } from 'resend'
    import { BrevoClient } from '@getbrevo/brevo'
    import sgMail from '@sendgrid/mail'
    import { ServerClient } from 'postmark'
    import Mailgun from 'mailgun.js'
    import { SendEmailCommand, SESv2Client } from '@aws-sdk/client-sesv2'

    const resend = new Resend('re_test')
    const resendRes = await resend.emails.send({
      from: 'hello@acme.com',
      to: 'resend@inbox.test',
      subject: 'Resend intercept',
      text: 'Code 111111',
    })
    if (resendRes.error) throw new Error(resendRes.error.message)

    const brevo = new BrevoClient({ apiKey: 'xkeysib-test', maxRetries: 0 })
    await brevo.transactionalEmails.sendTransacEmail({
      sender: { email: 'hello@acme.com' },
      to: [{ email: 'brevo@inbox.test' }],
      subject: 'Brevo intercept',
      textContent: 'Code 222222',
    })

    sgMail.setApiKey('SG.test')
    await sgMail.send({
      to: 'sendgrid@inbox.test',
      from: 'hello@acme.com',
      subject: 'SendGrid intercept',
      text: 'Code 333333',
    })

    const postmark = new ServerClient('pm-test')
    await postmark.sendEmail({
      From: 'hello@acme.com',
      To: 'postmark@inbox.test',
      Subject: 'Postmark intercept',
      TextBody: 'Code 444444',
    })

    const mg = new Mailgun(FormData).client({ username: 'api', key: 'key-test' })
    await mg.messages.create('mg.acme.com', {
      from: 'hello@acme.com',
      to: ['mailgun@inbox.test'],
      subject: 'Mailgun intercept',
      text: 'Code 555555',
    })

    const ses = new SESv2Client({
      region: 'us-east-1',
      credentials: { accessKeyId: 'test', secretAccessKey: 'test' },
    })
    await ses.send(
      new SendEmailCommand({
        FromEmailAddress: 'hello@acme.com',
        Destination: { ToAddresses: ['ses@inbox.test'] },
        Content: {
          Simple: { Subject: { Data: 'SES intercept' }, Body: { Text: { Data: 'Code 666666' } } },
        },
      }),
    )
  `

  const interceptUrl = pathToFileURL(interceptJs).href
  const env = { ...process.env, NID_URL: listening.url, NODE_OPTIONS: `--import ${interceptUrl}` }
  delete env.RESEND_BASE_URL
  delete env.RESEND_API_URL
  delete env.AWS_ENDPOINT_URL_SESV2
  delete env.AWS_ENDPOINT_URL_SES
  await runExec(process.execPath, ['--input-type=module', '-e', script], { env })

  const expected: Array<[string, string, string]> = [
    ['resend@inbox.test', 'resend', '111111'],
    ['brevo@inbox.test', 'brevo', '222222'],
    ['sendgrid@inbox.test', 'sendgrid', '333333'],
    ['postmark@inbox.test', 'postmark', '444444'],
    ['mailgun@inbox.test', 'mailgun', '555555'],
    ['ses@inbox.test', 'ses', '666666'],
  ]
  for (const [to, provider, code] of expected) {
    const messages = await server.store.listMessages('default', { to })
    assert.equal(messages.length, 1, to)
    assert.equal(messages[0]?.provider, provider)
    assert.equal(messages[0]?.extracted.code, code)
  }
})

test('nid run starts nid, injects interception, and preserves the child exit code', async () => {
  const cliJs = distFile('cli.js')
  assert.equal(existsSync(cliJs), true)

  const ok = await runExec(process.execPath, [
    cliJs,
    'run',
    '--port',
    '0',
    '--smtp-port',
    '0',
    '--quiet',
    '--',
    process.execPath,
    '--input-type=module',
    '-e',
    `
      import assert from 'node:assert/strict'
      import sgMail from '@sendgrid/mail'
      sgMail.setApiKey('SG.test')
      await sgMail.send({ to: 'run@inbox.test', from: 'a@acme.com', subject: 'Run', text: 'Code 654321' })
      const res = await fetch(process.env.NID_URL + '/api/messages?to=run@inbox.test')
      const body = await res.json()
      assert.equal(body.messages[0].extracted.code, '654321')
    `,
  ])
  assert.equal(ok.stderr, '')

  const failed = await runExec(process.execPath, [
    cliJs,
    'run',
    '--port',
    '0',
    '--smtp-port',
    '0',
    '--quiet',
    '--',
    process.execPath,
    '-e',
    'process.exit(42)',
  ]).then(
    () => assert.fail('expected non-zero exit'),
    (err: { code: number }) => err,
  )
  assert.equal(failed.code, 42)

  const missingDash = await runExec(process.execPath, [cliJs, 'run', 'node', '-e', 'process.exit(0)']).then(
    () => assert.fail('expected missing -- error'),
    (err: { code: number; stderr: string }) => err,
  )
  assert.equal(missingDash.code, 1)
  assert.match(missingDash.stderr, /Usage: nid run \[options\] -- <command\.\.\.>/)
})

test('importing nid-inbox with NID_URL does not patch globals and double-slash paths stay on nid origin', async (t) => {
  const indexJs = distFile('index.js')
  const interceptJs = distFile('intercept.js')
  assert.equal(existsSync(indexJs), true)
  assert.equal(existsSync(interceptJs), true)

  await runExec(
    process.execPath,
    [
      '--input-type=module',
      '-e',
      `
        import assert from 'node:assert/strict'
        import http from 'node:http'
        import https from 'node:https'
        const origFetch = globalThis.fetch
        const origHttpRequest = http.request
        const origHttpsRequest = https.request
        await import(${JSON.stringify(pathToFileURL(indexJs).href)})
        assert.equal(globalThis.fetch, origFetch)
        assert.equal(http.request, origHttpRequest)
        assert.equal(https.request, origHttpsRequest)
      `,
    ],
    { env: { ...process.env, NID_URL: 'http://127.0.0.1:4400' } },
  )

  const server = await createServer()
  const listening = await server.listen({ port: 0, smtpPort: false })
  t.after(() => server.close())

  const { installInterceptor } = await import('../src/intercept-core.js')
  const restore = installInterceptor(listening.url)
  t.after(restore)

  const res = await fetch('https://api.resend.com//evil.example/emails', {
    method: 'POST',
    headers: { authorization: 'Bearer re_test', 'content-type': 'application/json' },
    body: '{}',
  })
  assert.equal(res.status, 404)
  const payload = (await res.json()) as { error: string }
  assert.equal(payload.error, 'No route for POST /evil.example/emails')
})

test('a cleanup from a replaced interceptor leaves the newer one in place', async () => {
  const { installInterceptor } = await import('../src/intercept-core.js')
  const original = globalThis.fetch
  const restoreFirst = installInterceptor('http://127.0.0.1:4401')
  const restoreSecond = installInterceptor('http://127.0.0.1:4402')
  const patched = globalThis.fetch
  restoreFirst()
  assert.equal(globalThis.fetch, patched)
  restoreSecond()
  assert.equal(globalThis.fetch, original)
})

test('the interceptor keeps a Request body, array headers and credentials in the URL', async (t) => {
  const server = await createServer()
  const listening = await server.listen({ port: 0, smtpPort: false })
  t.after(() => server.close())
  const { installInterceptor } = await import('../src/intercept-core.js')
  t.after(installInterceptor(listening.url))

  const body = JSON.stringify({ from: 'a@acme.com', to: 'request@inbox.test', subject: 'Request', text: 'Hi' })
  const noKey = await fetch(new Request('https://api.resend.com/emails', { method: 'POST', body }))
  assert.equal(noKey.status, 401)
  const withKey = await fetch(
    new Request('https://api.resend.com/emails', { method: 'POST', headers: { authorization: 'Bearer re_test' }, body }),
  )
  assert.equal(withKey.status, 200)

  const nodeStatus = (url: string, options: https.RequestOptions, payload: string) =>
    new Promise<number>((resolve, reject) => {
      const req = https.request(url, { servername: 'api.resend.com', ...options }, (res) => {
        res.resume()
        resolve(res.statusCode ?? 0)
      })
      req.on('error', reject)
      req.end(payload)
    })
  const arrayHeaders = ['Authorization', 'Bearer re_test', 'Content-Type', 'application/json'] as unknown as https.RequestOptions['headers']
  assert.equal(await nodeStatus('https://api.resend.com/emails', { method: 'POST', headers: arrayHeaders }, body), 200)
  const mailgun = await nodeStatus(
    'https://api:key-test@api.mailgun.net/v3/mg.acme.com/messages',
    { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' } },
    'from=a%40acme.com&to=basic%40inbox.test&subject=Basic&text=Hi',
  )
  assert.equal(mailgun, 200)
})
