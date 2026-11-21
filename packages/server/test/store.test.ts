import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createMemoryStore, createSqliteStore, type Store } from '../src/store/index.js'
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

const drivers: Array<{ name: string; create: () => Promise<Store> }> = [
  { name: 'memory', create: async () => createMemoryStore() },
  { name: 'sqlite', create: () => createSqliteStore() },
]

for (const driver of drivers) {
  test(`[${driver.name}] messages are found by any recipient address, case-insensitively`, async () => {
    const store = await driver.create()
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

  test(`[${driver.name}] the cursor grows and after= only returns newer mail`, async () => {
    const store = await driver.create()
    assert.equal(await store.cursor('default'), 0)
    const first = await store.insertMessage('default', message(), noCode, null)
    const cursor = await store.cursor('default')
    assert.equal(cursor, first.id)
    const second = await store.insertMessage('default', message({ subject: 'Second' }), noCode, null)
    const newer = await store.listMessages('default', { after: cursor })
    assert.deepEqual(newer.map((m) => m.id), [second.id])
    await store.close()
  })

  test(`[${driver.name}] projects never see each other across messages, rejections, deletes and webhooks`, async () => {
    const store = await driver.create()
    const aMsg = await store.insertMessage('a', message(), noCode, null)
    await store.insertMessage('b', message(), noCode, null)
    await store.insertRejection('a', { provider: 'resend', to: ['signup.1@inbox.test'], status: 422, error: 'bad', raw: '{}' })
    await store.insertWebhookDelivery('a', {
      messageId: aMsg.id,
      provider: 'resend',
      event: 'bounced',
      recipient: 'signup.1@inbox.test',
      url: 'http://127.0.0.1:3000/hooks',
      delivered: true,
      appStatus: 200,
      appBody: 'ok',
      durationMs: 3,
      error: null,
    })

    const a = await store.listMessages('a', {})
    assert.equal(a.length, 1)
    assert.equal(await store.getMessage('b', aMsg.id), null)
    assert.equal(await store.deleteMessage('b', aMsg.id), false)
    assert.equal(await store.deleteMessages('b', 'signup.1@inbox.test'), 1)
    assert.equal((await store.listMessages('a', {})).length, 1)
    assert.equal(await store.deleteRejections('b'), 0)
    assert.equal((await store.listRejections('a', {})).length, 1)
    assert.deepEqual(await store.listWebhookDeliveries('b', aMsg.id), [])
    assert.equal(await store.latestWebhookEvent('b', aMsg.id), null)
    assert.equal(await store.latestWebhookEvent('a', aMsg.id), 'bounced')
    await store.close()
  })

  test(`[${driver.name}] attachments round-trip, expired mail is hidden on read, and deleteExpired sweeps it`, async () => {
    const store = await driver.create()
    const content = new Uint8Array([1, 2, 3, 4])
    const future = new Date(Date.now() + 60_000).toISOString()
    const live = await store.insertMessage(
      'default',
      message({ attachments: [{ filename: 'a.bin', contentType: 'application/octet-stream', contentId: null, content }] }),
      noCode,
      future,
    )
    assert.equal(live.attachments[0]?.size, 4)
    const attachment = await store.getAttachment('default', live.id, 0)
    assert.deepEqual([...(attachment?.content ?? [])], [1, 2, 3, 4])

    const expired = await store.insertMessage(
      'default',
      message({
        providerId: 'expired-pid',
        idempotencyKey: 'expired-idem',
        attachments: [{ filename: 'old.bin', contentType: 'application/octet-stream', contentId: null, content }],
      }),
      noCode,
      '2000-01-01T00:00:00.000Z',
    )
    assert.equal(await store.getMessage('default', expired.id), null)
    assert.equal(await store.findByProviderId('default', 'resend', 'expired-pid'), null)
    assert.equal(await store.findByIdempotencyKey('default', 'resend', 'expired-idem'), null)
    assert.equal(await store.getAttachment('default', expired.id, 0), null)
    assert.deepEqual(
      (await store.listMessages('default', {})).map((m) => m.id),
      [live.id],
    )
    assert.equal(await store.deleteExpired(new Date().toISOString()), 1)
    assert.equal(await store.deleteExpired(new Date().toISOString()), 0)
    await store.close()
  })

  test(`[${driver.name}] rejections are listed newest first, filtered by address, and deleted`, async () => {
    const store = await driver.create()
    await store.insertRejection('default', { provider: 'resend', to: ['x@y.co'], status: 422, error: 'bad', raw: '{}' })
    const inserted = await store.insertRejection('default', { provider: 'brevo', to: [' Z@y.co '], status: 400, error: 'worse', raw: '{}' })
    assert.deepEqual(inserted.to, ['z@y.co'])
    const all = await store.listRejections('default', {})
    assert.deepEqual(all.map((r) => r.provider), ['brevo', 'resend'])
    assert.deepEqual((await store.listRejections('default', { to: 'z@y.co' })).map((r) => r.to), [['z@y.co']])
    assert.equal(await store.deleteRejections('default', 'z@y.co'), 1)
    assert.deepEqual((await store.listRejections('default', {})).map((r) => r.provider), ['resend'])
    await store.insertRejection('other', { provider: 'resend', to: ['x@y.co'], status: 422, error: 'kept', raw: '{}' })
    assert.equal(await store.deleteRejections('default'), 1)
    assert.deepEqual(await store.listRejections('default', {}), [])
    assert.equal((await store.listRejections('other', { to: 'x@y.co' })).length, 1)
    await store.close()
  })

  test(`[${driver.name}] deleteMessage and webhook deliveries clean up accurately`, async () => {
    const store = await driver.create()
    const first = await store.insertMessage('default', message({ providerId: 'p1', idempotencyKey: 'k1' }), noCode, null)
    const second = await store.insertMessage('default', message({ providerId: 'p2', idempotencyKey: 'k2' }), noCode, null)
    await store.insertWebhookDelivery('default', {
      messageId: first.id,
      provider: 'resend',
      event: 'delivered',
      recipient: 'signup.1@inbox.test',
      url: 'http://127.0.0.1:3000/hooks',
      delivered: true,
      appStatus: 200,
      appBody: 'ok',
      durationMs: 2,
      error: null,
    })
    await store.insertWebhookDelivery('default', {
      messageId: first.id,
      provider: 'resend',
      event: 'bounced',
      recipient: 'signup.1@inbox.test',
      url: 'http://127.0.0.1:3000/hooks',
      delivered: true,
      appStatus: 200,
      appBody: 'ok',
      durationMs: 4,
      error: null,
    })
    assert.equal((await store.listWebhookDeliveries('default', first.id)).length, 2)
    assert.equal(await store.latestWebhookEvent('default', first.id), 'bounced')
    assert.equal(await store.deleteMessage('default', first.id), true)
    assert.equal(await store.deleteMessage('default', first.id), false)
    assert.equal(await store.getMessage('default', first.id), null)
    assert.equal(await store.findByProviderId('default', 'resend', 'p1'), null)
    assert.equal(await store.findByIdempotencyKey('default', 'resend', 'k1'), null)
    assert.deepEqual(await store.listWebhookDeliveries('default', first.id), [])
    assert.equal(await store.latestWebhookEvent('default', first.id), null)
    assert.ok(await store.getMessage('default', second.id))
    await store.close()
  })

  test(`[${driver.name}] subject filter matches _ and % literally`, async () => {
    const store = await driver.create()
    await store.insertMessage('default', message({ providerId: 'sub-1', subject: 'hello world' }), noCode, null)
    await store.insertMessage('default', message({ providerId: 'sub-2', subject: 'h_llo literal' }), noCode, null)
    await store.insertMessage('default', message({ providerId: 'sub-3', subject: 'Save 100% today' }), noCode, null)
    const underscore = await store.listMessages('default', { subject: 'h_llo' })
    assert.deepEqual(
      underscore.map((m) => m.subject),
      ['h_llo literal'],
    )
    const percent = await store.listMessages('default', { subject: '100%' })
    assert.deepEqual(
      percent.map((m) => m.subject),
      ['Save 100% today'],
    )
    await store.close()
  })
}

test('[memory] evicts oldest messages and rejections past capacity and clears all indices', async () => {
  const store = createMemoryStore({ maxMessages: 2, maxRejections: 2 })
  const m1 = await store.insertMessage(
    'default',
    message({ providerId: 'pid-1', idempotencyKey: 'key-1', recipients: [{ address: 'only1@inbox.test', name: null, kind: 'to' }] }),
    noCode,
    null,
  )
  await store.insertWebhookDelivery('default', {
    messageId: m1.id,
    provider: 'resend',
    event: 'delivered',
    recipient: 'only1@inbox.test',
    url: 'http://127.0.0.1:3000/hooks',
    delivered: true,
    appStatus: 200,
    appBody: '',
    durationMs: 1,
    error: null,
  })
  const m2 = await store.insertMessage('default', message({ providerId: 'pid-2', idempotencyKey: 'key-2' }), noCode, null)
  const m3 = await store.insertMessage('default', message({ providerId: 'pid-3', idempotencyKey: 'key-3' }), noCode, null)

  assert.equal(await store.getMessage('default', m1.id), null)
  assert.equal(await store.findByProviderId('default', 'resend', 'pid-1'), null)
  assert.equal(await store.findByIdempotencyKey('default', 'resend', 'key-1'), null)
  assert.deepEqual(await store.listMessages('default', { to: 'only1@inbox.test' }), [])
  assert.deepEqual(await store.listWebhookDeliveries('default', m1.id), [])
  assert.deepEqual(
    (await store.listMessages('default', {})).map((m) => m.id),
    [m3.id, m2.id],
  )

  await store.insertRejection('default', { provider: 'resend', to: ['a@inbox.test'], status: 422, error: 'r1', raw: '{}' })
  await store.insertRejection('default', { provider: 'resend', to: ['b@inbox.test'], status: 422, error: 'r2', raw: '{}' })
  await store.insertRejection('default', { provider: 'resend', to: ['c@inbox.test'], status: 422, error: 'r3', raw: '{}' })
  assert.deepEqual(
    (await store.listRejections('default', {})).map((r) => r.error),
    ['r3', 'r2'],
  )
  await store.close()
})

test('[sqlite] a file-backed database keeps mail across reopen', async (t) => {
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
