import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createServer } from 'testinbox'
import { InboxTimeoutError, createInbox } from '../src/index.js'

async function running(t: { after(fn: () => Promise<void>): void }) {
  const server = await createServer()
  const listening = await server.listen({ port: 0, smtpPort: 0 })
  t.after(() => server.close())
  const send = (to: string, subject: string, text: string) =>
    fetch(`${listening.url}/emails`, {
      method: 'POST',
      headers: { authorization: 'Bearer re_x', 'content-type': 'application/json' },
      body: JSON.stringify({ from: 'a@acme.com', to, subject, text }),
    })
  return { url: listening.url, send }
}

test('addresses are unique and lowercase', async (t) => {
  const { url } = await running(t)
  const inbox = createInbox({ url })
  const a = inbox.address('Sign Up')
  const b = inbox.address('Sign Up')
  assert.match(a, /^sign-up\.[0-9a-f]{8}@inbox\.test$/)
  assert.notEqual(a, b)
  assert.match(inbox.address('x', { domain: 'acme.com' }), /@acme\.com$/)
})

test('waitFor remembers the cursor per address so the second call gets the next email', async (t) => {
  const { url, send } = await running(t)
  const inbox = createInbox({ url })
  await inbox.start()
  const email = inbox.address('signup')
  await send(email, 'Your code', 'Code: 111111')
  const first = await inbox.waitFor(email, { hasCode: true, timeout: 5 })
  assert.equal(first.code, '111111')
  await send(email, 'Your code', 'Code: 222222')
  const second = await inbox.waitFor(email, { hasCode: true, timeout: 5 })
  assert.equal(second.code, '222222')
  assert.notEqual(first.id, second.id)
  const again = await inbox.waitFor(email, { after: 0, timeout: 1 })
  assert.equal(again.id, first.id)
})

test('start() takes a cursor so mail from before the test never matches', async (t) => {
  const { url, send } = await running(t)
  const inbox = createInbox({ url })
  const email = inbox.address('old')
  await send(email, 'Old', 'Code: 999999')
  await inbox.start()
  await assert.rejects(inbox.waitFor(email, { timeout: 0.3 }), (err: unknown) => {
    assert.ok(err instanceof InboxTimeoutError)
    assert.equal(err.address, email)
    assert.match(err.message, /Timed out/)
    return true
  })
})

test('list, get, rejections and clear', async (t) => {
  const { url, send } = await running(t)
  const inbox = createInbox({ url })
  const email = inbox.address('list')
  await send(email, 'One', 'https://app.acme.com/one')
  await send(email, 'Two', 'Two')
  const list = await inbox.list({ to: email })
  assert.deepEqual(list.map((m) => m.subject), ['Two', 'One'])
  const one = await inbox.get(list[1]!.id)
  assert.equal(one.link, 'https://app.acme.com/one')
  assert.equal(typeof one.raw, 'string')
  await fetch(`${url}/emails`, {
    method: 'POST',
    headers: { authorization: 'Bearer re_x', 'content-type': 'application/json' },
    body: JSON.stringify({ to: email, subject: 'Bad', text: 'Bad' }),
  })
  assert.equal((await inbox.rejections(email))[0]?.status, 422)
  assert.equal(await inbox.clear(email), 2)
  assert.deepEqual(await inbox.list({ to: email }), [])
})

test('a code pattern of the test\'s own is honoured', async (t) => {
  const { url, send } = await running(t)
  const inbox = createInbox({ url })
  const email = inbox.address('key')
  await send(email, 'Key', 'Your access key is ACME-77')
  const found = await inbox.waitFor(email, { codePattern: /key is ([A-Z0-9-]+)/, timeout: 2 })
  assert.equal(found.code, 'ACME-77')
})
