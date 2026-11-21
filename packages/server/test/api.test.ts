import assert from 'node:assert/strict'
import { test } from 'node:test'
import { SendEmailCommand, SESv2Client } from '@aws-sdk/client-sesv2'
import { createServer } from '../src/index.js'
import { get, resendHeaders, sendResend, sleep } from './helpers.js'

const base = { from: 'a@acme.com', to: 'signup@inbox.test' }

test('cursor, then wait returns only mail sent after it', async (t) => {
  const server = await createServer()
  t.after(() => server.close())
  await sendResend(server, { ...base, subject: 'Old', text: 'Old code 111111' })
  const { body: cursor } = await get(server, '/api/cursor')
  const pending = get(server, `/api/wait?to=signup@inbox.test&after=${cursor.cursor}&timeout=5`)
  await sleep(300)
  await sendResend(server, { ...base, subject: 'New', text: 'Your code is 222222' })
  const { status, body } = await pending
  assert.equal(status, 200)
  const message = body.message as { subject: string; extracted: { code: string } }
  assert.equal(message.subject, 'New')
  assert.equal(message.extracted.code, '222222')
})

test('has_code skips a welcome email sent just before the code', async (t) => {
  const server = await createServer()
  t.after(() => server.close())
  await sendResend(server, { ...base, subject: 'Welcome', text: 'Thanks for joining.' })
  await sendResend(server, { ...base, subject: 'Your code', text: 'Code: 335577' })
  const { body } = await get(server, '/api/wait?to=signup@inbox.test&has_code=true&timeout=1')
  assert.equal((body.message as { subject: string }).subject, 'Your code')
})

test('code_pattern overrides extraction at read time', async (t) => {
  const server = await createServer()
  t.after(() => server.close())
  await sendResend(server, { ...base, subject: 'Key', text: 'Your access key is ACME-77-ZED' })
  const { body } = await get(server, `/api/wait?to=signup@inbox.test&timeout=1&code_pattern=${encodeURIComponent('key is ([A-Z0-9-]+)')}`)
  assert.equal((body.message as { extracted: { code: string } }).extracted.code, 'ACME-77-ZED')
  const bad = await get(server, `/api/wait?to=signup@inbox.test&timeout=1&code_pattern=${encodeURIComponent('(')}`)
  assert.equal(bad.status, 400)
})

test('a timeout answers 404 and explains itself with recent rejections', async (t) => {
  const server = await createServer()
  t.after(() => server.close())
  await sendResend(server, { to: 'signup@inbox.test', subject: 'Hi', text: 'Hi' })
  const { status, body } = await get(server, '/api/wait?to=signup@inbox.test&timeout=0.3')
  assert.equal(status, 404)
  assert.equal(body.timedOut, true)
  assert.match(String(body.error), /Timed out waiting for mail to signup@inbox.test/)
  assert.match(String(body.error), /1 resend request was rejected \d+s ago with 422: Missing `from` field\./)
  assert.equal((body.recent_rejections as unknown[]).length, 1)
})

test('unknown query parameters are a 400, not a silent match', async (t) => {
  const server = await createServer()
  t.after(() => server.close())
  const { status, body } = await get(server, '/api/messages?subjet=hello')
  assert.equal(status, 400)
  assert.deepEqual(body, { error: 'Invalid query', details: ['Unknown parameter: subjet'] })
})

test('messages list, get with raw, attachments and delete', async (t) => {
  const server = await createServer()
  t.after(() => server.close())
  await sendResend(server, {
    ...base,
    subject: 'With file',
    text: 'See attached',
    attachments: [{ filename: 'Łódź (final).txt', content: Buffer.from('abc').toString('base64'), content_type: 'text/plain' }],
  })
  await sendResend(server, { from: 'a@acme.com', to: 'other@inbox.test', subject: 'Other', text: 'Other' })
  const list = await get(server, '/api/messages?to=signup@inbox.test')
  const messages = list.body.messages as { id: number; raw?: string; attachments: { url: string }[] }[]
  assert.equal(messages.length, 1)
  assert.equal(messages[0]?.raw, undefined)
  const one = await get(server, `/api/messages/${messages[0]?.id}`)
  assert.equal(typeof (one.body.message as { raw: string }).raw, 'string')
  const file = await server.app.request(messages[0]!.attachments[0]!.url)
  assert.equal(file.status, 200)
  assert.equal(file.headers.get('content-type'), 'text/plain')
  assert.equal(file.headers.get('content-disposition'), `attachment; filename="__d_ (final).txt"; filename*=UTF-8''%C5%81%C3%B3d%C5%BA%20%28final%29.txt`)
  assert.equal(await file.text(), 'abc')
  const cleared = await server.app.request('/api/messages?to=signup@inbox.test', { method: 'DELETE' })
  assert.deepEqual(await cleared.json(), { deleted: 1 })
  assert.equal(((await get(server, '/api/messages')).body.messages as unknown[]).length, 1)
  const all = await server.app.request('/api/messages', { method: 'DELETE' })
  assert.deepEqual(await all.json(), { deleted: 1 })
})

test('the stream sends new messages and rejections as events', async (t) => {
  const server = await createServer()
  t.after(() => server.close())
  const response = await server.app.request('/api/stream')
  assert.equal(response.headers.get('content-type')?.split(';')[0], 'text/event-stream')
  const reader = response.body!.getReader()
  const decoder = new TextDecoder()
  let seen = ''
  const readUntil = async (needle: string) => {
    while (!seen.includes(needle)) {
      const { value, done } = await reader.read()
      if (done) break
      seen += decoder.decode(value)
    }
  }
  await readUntil('event: ready')
  await sendResend(server, { ...base, subject: 'Streamed', text: 'Hi' })
  await readUntil('event: message')
  assert.match(seen, /"subject":"Streamed"/)
  await sendResend(server, { to: 'x@inbox.test', subject: 'Bad', text: 'Hi' })
  await readUntil('event: rejection')
  await reader.cancel()
})

test('only localhost-like hosts are answered unless allowed', async (t) => {
  const server = await createServer({ allowHosts: ['mail.internal.example'] })
  t.after(() => server.close())
  const evil = await server.app.request('/api/cursor', { headers: { host: 'evil.example.com' } })
  assert.equal(evil.status, 403)
  for (const host of ['localhost:4400', '127.0.0.1', '[::1]:4400', 'nid:4400', 'mail.internal.example']) {
    const ok = await server.app.request('/api/cursor', { headers: { host } })
    assert.equal(ok.status, 200, host)
  }
})

test('healthz, providers and the openapi document are served', async (t) => {
  const server = await createServer({ webhooks: { resend: { url: 'http://127.0.0.1:3000/hook' } } })
  t.after(() => server.close())
  assert.equal((await get(server, '/healthz')).body.ok, true)
  const provBody = (await get(server, '/api/providers')).body as {
    providers: { name: string }[]
    smtpPort: number
    webhooks: string[]
  }
  assert.deepEqual(provBody.providers.map((p) => p.name), ['resend', 'brevo', 'sendgrid', 'postmark', 'mailgun', 'ses'])
  assert.equal(provBody.smtpPort, 1025)
  assert.deepEqual(provBody.webhooks, ['resend'])
  const spec = await get(server, '/api/openapi.json')
  assert.equal(spec.body.openapi, '3.0.3')
  const page = await server.app.request('/')
  assert.equal(page.status, 200)
  assert.match(await page.text(), /nid/)
})

test('the auth and limits hooks pick the project and its retention', async (t) => {
  const server = await createServer({
    auth: (credential) => (credential.value === 'ti_live' ? { projectId: 'acme', plan: 'pro' } : null),
    limits: (project) => ({ maxBodyBytes: 1024, retentionHours: project.plan === 'pro' ? 168 : 24 }),
  })
  t.after(() => server.close())
  const denied = await sendResend(server, { ...base, subject: 'Hi', text: 'Hi' }, { ...resendHeaders, authorization: 'Bearer nope' })
  assert.equal(denied.status, 401)
  const accepted = await sendResend(server, { ...base, subject: 'Hi', text: 'Hi' }, { ...resendHeaders, authorization: 'Bearer ti_live' })
  assert.equal(accepted.status, 200)
  const stored = (await server.store.listMessages('acme', {}))[0]
  assert.ok(stored?.expiresAt)
  assert.equal((await server.store.listMessages('default', {})).length, 0)
  const unauthenticated = await server.app.request('/api/messages')
  assert.equal(unauthenticated.status, 401)
  const authenticated = await server.app.request('/api/messages', { headers: { authorization: 'Bearer ti_live' } })
  assert.equal(authenticated.status, 200)
})

test('wait wakes up immediately via EventBus with zero polling and cleans up on abort', async (t) => {
  const server = await createServer()
  t.after(() => server.close())
  let listCalls = 0
  const origList = server.store.listMessages.bind(server.store)
  server.store.listMessages = (...args) => {
    listCalls++
    return origList(...args)
  }
  let activeSubs = 0
  const origSubscribe = server.events.subscribe.bind(server.events)
  server.events.subscribe = (projectId, listener) => {
    activeSubs++
    const unsub = origSubscribe(projectId, listener)
    return () => {
      activeSubs--
      unsub()
    }
  }

  const started = performance.now()
  const pending = get(server, '/api/wait?to=signup@inbox.test&timeout=5')
  await sleep(10)
  await sendResend(server, { ...base, subject: 'Fast', text: 'Code 918273' })
  const res = await pending
  const elapsed = performance.now() - started
  assert.equal(res.status, 200)
  assert.ok(elapsed < 100, `expected <100ms, got ${elapsed}ms`)
  assert.equal(listCalls, 1)
  assert.equal(activeSubs, 0)

  const controller = new AbortController()
  const aborted = server.app.request('/api/wait?to=never@inbox.test&timeout=20', { signal: controller.signal })
  await sleep(10)
  assert.equal(activeSubs, 1)
  controller.abort()
  await aborted
  assert.equal(activeSubs, 0)
})

test('wait with code_pattern finds a match past more than 50 earlier messages', async (t) => {
  const server = await createServer()
  t.after(() => server.close())
  for (let i = 0; i < 60; i++) {
    await sendResend(server, { ...base, subject: `Noise ${i}`, text: `Nothing to match ${i}` })
  }
  await sendResend(server, { ...base, subject: 'Key', text: 'Your access key is PAGE-2-OK' })
  const res = await get(server, `/api/wait?to=signup@inbox.test&timeout=1&code_pattern=${encodeURIComponent('key is ([A-Z0-9-]+)')}`)
  assert.equal(res.status, 200)
  assert.equal((res.body.message as { extracted: { code: string } }).extracted.code, 'PAGE-2-OK')
})

test('expired messages are hidden from read routes and attachment downloads', async (t) => {
  const server = await createServer()
  t.after(() => server.close())
  const expired = await server.store.insertMessage(
    'default',
    {
      provider: 'resend',
      providerId: 'exp-1',
      from: 'a@acme.com',
      replyTo: [],
      recipients: [{ address: 'signup@inbox.test', name: null, kind: 'to' }],
      subject: 'Expired',
      text: 'Old',
      html: null,
      headers: {},
      attachments: [{ filename: 'a.txt', contentType: 'text/plain', contentId: null, content: new Uint8Array([1]) }],
      raw: '{}',
      meta: {},
      idempotencyKey: null,
    },
    { code: null, codes: [], link: null, links: [] },
    '2000-01-01T00:00:00.000Z',
  )
  assert.deepEqual((await get(server, '/api/messages')).body.messages, [])
  assert.equal((await get(server, `/api/messages/${expired.id}`)).status, 404)
  const file = await server.app.request(`/api/messages/${expired.id}/attachments/0`)
  assert.equal(file.status, 404)
})

test('stream drains more than 100 backlog messages and resumes via Last-Event-ID', async (t) => {
  const server = await createServer()
  t.after(() => server.close())
  for (let i = 1; i <= 120; i++) {
    await sendResend(server, { ...base, subject: `Backlog ${i}`, text: `Msg ${i}` })
  }
  const response = await server.app.request('/api/stream?after=0')
  const reader = response.body!.getReader()
  const decoder = new TextDecoder()
  let seen = ''
  while (!seen.includes('"subject":"Backlog 120"')) {
    const { value, done } = await reader.read()
    if (done) break
    seen += decoder.decode(value)
  }
  await reader.cancel()
  assert.ok(seen.includes('"subject":"Backlog 1"'))
  assert.ok(seen.includes('"subject":"Backlog 101"'))
  assert.ok(seen.includes('"subject":"Backlog 120"'))

  await sendResend(server, { ...base, subject: 'After disconnect 121', text: 'Msg 121' })
  const resumed = await server.app.request('/api/stream?after=0', { headers: { 'last-event-id': '120' } })
  const resumedReader = resumed.body!.getReader()
  let resumedSeen = ''
  while (!resumedSeen.includes('"subject":"After disconnect 121"')) {
    const { value, done } = await resumedReader.read()
    if (done) break
    resumedSeen += decoder.decode(value)
  }
  await resumedReader.cancel()
  assert.equal(resumedSeen.includes('"subject":"Backlog 120"'), false)
})

test('delete single message, delete rejections, and render sandboxed html preview with cid images', async (t) => {
  const server = await createServer()
  t.after(() => server.close())
  await sendResend(server, {
    ...base,
    subject: 'Inline',
    html: '<img src="cid:logo@acme.com"><img src="https://cdn.acme.com/banner.png">',
    attachments: [
      {
        filename: 'logo.png',
        content: Buffer.from('pngbytes').toString('base64'),
        content_type: 'image/png',
        content_id: '<logo@acme.com>',
      },
    ],
  })
  await sendResend(server, { ...base, subject: 'Keep', text: 'Keep me' })
  await sendResend(server, { to: 'bad@inbox.test', subject: 'Bad', text: 'Bad' })
  await sendResend(server, { to: 'other-bad@inbox.test', subject: 'Bad2', text: 'Bad2' })

  const list = (await get(server, '/api/messages')).body.messages as Array<{ id: number; subject: string }>
  const inlineId = list.find((m) => m.subject === 'Inline')!.id
  const keepId = list.find((m) => m.subject === 'Keep')!.id

  const preview = await server.app.request(`/api/messages/${inlineId}/html`)
  assert.equal(preview.status, 200)
  const csp = preview.headers.get('content-security-policy') ?? ''
  assert.match(csp, /sandbox/)
  assert.match(csp, /default-src 'none'/)
  assert.match(csp, /img-src \* data: blob:/)
  assert.match(csp, /form-action 'none'/)
  assert.match(csp, /base-uri 'none'/)
  const html = await preview.text()
  assert.match(html, /data:image\/png;base64,cG5nYnl0ZXM=/)
  assert.match(html, /https:\/\/cdn\.acme\.com\/banner\.png/)

  const delOne = await server.app.request(`/api/messages/${inlineId}`, { method: 'DELETE' })
  assert.equal(delOne.status, 200)
  assert.equal((await get(server, `/api/messages/${inlineId}`)).status, 404)
  assert.equal((await get(server, `/api/messages/${keepId}`)).status, 200)

  const delOneRej = await server.app.request('/api/rejections?to=bad@inbox.test', { method: 'DELETE' })
  assert.deepEqual(await delOneRej.json(), { deleted: 1 })
  assert.equal(((await get(server, '/api/rejections')).body.rejections as unknown[]).length, 1)

  const delAllRej = await server.app.request('/api/rejections', { method: 'DELETE' })
  assert.deepEqual(await delAllRej.json(), { deleted: 1 })
  assert.equal(((await get(server, '/api/rejections')).body.rejections as unknown[]).length, 0)
})

test('read API refuses cross-origin mutating requests from disallowed origins', async (t) => {
  const server = await createServer({ allowHosts: ['app.local.test'] })
  t.after(() => server.close())
  await sendResend(server, { ...base, subject: 'CSRF', text: 'CSRF' })
  const messages = (await get(server, '/api/messages')).body.messages as Array<{ id: number }>
  const id = messages[0]!.id

  const faultRes = await server.app.request('/api/faults', {
    method: 'POST',
    headers: { origin: 'https://evil.example', 'content-type': 'text/plain' },
    body: JSON.stringify({ status: 503 }),
  })
  assert.equal(faultRes.status, 403)
  assert.equal(((await get(server, '/api/faults')).body.faults as unknown[]).length, 0)

  const eventRes = await server.app.request(`/api/messages/${id}/events`, {
    method: 'POST',
    headers: { origin: 'https://evil.example', 'content-type': 'text/plain' },
    body: JSON.stringify({ type: 'complained' }),
  })
  assert.equal(eventRes.status, 403)

  const allowedOrigin = await server.app.request('/api/faults', {
    method: 'POST',
    headers: { origin: 'http://app.local.test', 'content-type': 'application/json' },
    body: JSON.stringify({ status: 503 }),
  })
  assert.equal(allowedOrigin.status, 201)
})

test('nid serve --token enforces authentication on provider and read routes', async (t) => {
  const { spawn } = await import('node:child_process')
  const { fileURLToPath } = await import('node:url')
  const cliJs = fileURLToPath(new URL('../dist/cli.js', import.meta.url))
  const child = spawn(process.execPath, [cliJs, 'serve', '--port', '0', '--smtp-port', '0', '--token', 'stage-secret'], {
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  t.after(() => {
    if (!child.killed) child.kill('SIGTERM')
  })

  const url = await new Promise<string>((resolve, reject) => {
    let out = ''
    let err = ''
    child.stdout.on('data', (chunk: Buffer) => {
      out += chunk.toString()
      const match = out.match(/web view\s+(http:\/\/[^\s]+)/)
      if (match?.[1]) resolve(match[1])
    })
    child.stderr.on('data', (chunk: Buffer) => {
      err += chunk.toString()
    })
    child.once('exit', (code) => reject(new Error(`cli exited ${code}: ${err}`)))
  })

  const unauthRead = await fetch(`${url}/api/messages`)
  assert.equal(unauthRead.status, 401)
  const badSend = await fetch(`${url}/emails`, {
    method: 'POST',
    headers: { authorization: 'Bearer wrong', 'content-type': 'application/json' },
    body: JSON.stringify({ from: 'a@acme.com', to: 'u@inbox.test', subject: 'Hi', text: 'Hi' }),
  })
  assert.equal(badSend.status, 401)

  const okSend = await fetch(`${url}/emails`, {
    method: 'POST',
    headers: { authorization: 'Bearer stage-secret', 'content-type': 'application/json' },
    body: JSON.stringify({ from: 'a@acme.com', to: 'u@inbox.test', subject: 'Hi', text: 'Code 102030' }),
  })
  assert.equal(okSend.status, 200)

  const queryTokenRead = await fetch(`${url}/api/messages?token=stage-secret`)
  assert.equal(queryTokenRead.status, 401)

  const okRead = await fetch(`${url}/api/messages`, { headers: { authorization: 'Bearer stage-secret' } })
  assert.equal(okRead.status, 200)
  const data = (await okRead.json()) as { messages: Array<{ id: number; extracted: { code: string } }> }
  assert.equal(data.messages[0]?.extracted.code, '102030')

  const badSes = new SESv2Client({
    region: 'us-east-1',
    endpoint: url,
    credentials: { accessKeyId: 'wrong', secretAccessKey: 'any' },
  })
  await assert.rejects(
    badSes.send(
      new SendEmailCommand({
        FromEmailAddress: 'hello@acme.com',
        Destination: { ToAddresses: ['ses-auth@inbox.test'] },
        Content: { Simple: { Subject: { Data: 'Denied' }, Body: { Text: { Data: 'Denied' } } } },
      }),
    ),
  )

  const okSes = new SESv2Client({
    region: 'us-east-1',
    endpoint: url,
    credentials: { accessKeyId: 'stage-secret', secretAccessKey: 'any' },
  })
  await okSes.send(
    new SendEmailCommand({
      FromEmailAddress: 'hello@acme.com',
      Destination: { ToAddresses: ['ses-auth@inbox.test'] },
      Content: { Simple: { Subject: { Data: 'Allowed' }, Body: { Text: { Data: 'Code 454545' } } } },
    }),
  )
  const sesRead = await fetch(`${url}/api/messages?to=ses-auth@inbox.test`, {
    headers: { authorization: 'Bearer stage-secret' },
  })
  assert.equal(sesRead.status, 200)
  const sesData = (await sesRead.json()) as { messages: Array<{ extracted: { code: string } }> }
  assert.equal(sesData.messages[0]?.extracted.code, '454545')

  const uiPage = await fetch(`${url}/`)
  assert.equal(uiPage.status, 200)
})
