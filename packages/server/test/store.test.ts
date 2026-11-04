import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createSqliteStore } from '../src/store/index.js'
import type { NewMessage } from '../src/types.js'

function message(overrides: Partial<NewMessage> = {}): NewMessage {
  return {
    provider: 'resend',
    providerId: crypto.randomUUID(),
    from: 'a@acme.com',
    replyTo: [],
    recipients: [{ address: 'signup.1@inbox.test', name: null, kind: 'to' }],
    subject: 'Hello',
    text: 'Hello there',
    html: null,
    headers: {},
    attachments: [],
    raw: '{}',
    meta: {},
    idempotencyKey: null,
    ...overrides,
  }
}

const noCode = { code: null, codes: [], link: null, links: [] }

test('messages are found by any recipient address, case-insensitively', async () => {
  const store = await createSqliteStore()
  await store.insertMessage(
    'default',
    message({
      recipients: [
        { address: 'to@inbox.test', name: null, kind: 'to' },
        { address: 'bcc@inbox.test', name: null, kind: 'bcc' },
      ],
    }),
    noCode,
    null,
  )
  assert.equal((await store.listMessages('default', { to: 'BCC@inbox.test' })).length, 1)
  assert.equal((await store.listMessages('default', { to: 'to@inbox.test' })).length, 1)
  assert.equal((await store.listMessages('default', { to: 'other@inbox.test' })).length, 0)
  await store.close()
})

test('the cursor grows and after= only returns newer mail', async () => {
  const store = await createSqliteStore()
  assert.equal(await store.cursor('default'), 0)
  const first = await store.insertMessage('default', message(), noCode, null)
  const cursor = await store.cursor('default')
  assert.equal(cursor, first.id)
  const second = await store.insertMessage('default', message({ subject: 'Second' }), noCode, null)
  const newer = await store.listMessages('default', { after: cursor })
  assert.deepEqual(newer.map((m) => m.id), [second.id])
  await store.close()
})

test('projects never see each other', async () => {
  const store = await createSqliteStore()
  await store.insertMessage('a', message(), noCode, null)
  await store.insertMessage('b', message(), noCode, null)
  const a = await store.listMessages('a', {})
  assert.equal(a.length, 1)
  assert.equal(await store.getMessage('b', a[0]!.id), null)
  assert.equal(await store.deleteMessages('b', 'signup.1@inbox.test'), 1)
  assert.equal((await store.listMessages('a', {})).length, 1)
  await store.close()
})

test('attachments round-trip and expired mail is swept', async () => {
  const store = await createSqliteStore()
  const content = new Uint8Array([1, 2, 3, 4])
  const stored = await store.insertMessage(
    'default',
    message({ attachments: [{ filename: 'a.bin', contentType: 'application/octet-stream', contentId: null, content }] }),
    noCode,
    '2000-01-01T00:00:00.000Z',
  )
  assert.equal(stored.attachments[0]?.size, 4)
  const attachment = await store.getAttachment('default', stored.id, 0)
  assert.deepEqual([...(attachment?.content ?? [])], [1, 2, 3, 4])
  assert.equal(await store.deleteExpired(new Date().toISOString()), 1)
  assert.equal(await store.getAttachment('default', stored.id, 0), null)
  await store.close()
})

test('rejections are listed newest first and filtered by address', async () => {
  const store = await createSqliteStore()
  await store.insertRejection('default', { provider: 'resend', to: ['x@y.co'], status: 422, error: 'bad', raw: '{}' })
  await store.insertRejection('default', { provider: 'brevo', to: ['Z@y.co'], status: 400, error: 'worse', raw: '{}' })
  const all = await store.listRejections('default', {})
  assert.deepEqual(all.map((r) => r.provider), ['brevo', 'resend'])
  assert.equal((await store.listRejections('default', { to: 'z@y.co' })).length, 1)
  await store.close()
})

test('a file-backed database keeps mail across reopen', async (t) => {
  const path = `${t.name.replace(/\W+/g, '-')}-${process.pid}.sqlite`
  const { rm } = await import('node:fs/promises')
  t.after(async () => {
    for (const suffix of ['', '-wal', '-shm']) await rm(path + suffix, { force: true })
  })
  const first = await createSqliteStore({ path })
  await first.insertMessage('default', message(), noCode, null)
  await first.close()
  const second = await createSqliteStore({ path })
  assert.equal((await second.listMessages('default', {})).length, 1)
  await second.close()
})
