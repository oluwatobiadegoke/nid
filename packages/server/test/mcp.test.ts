import assert from 'node:assert/strict'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client'
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio'
import { sendResend, sleep, start, type Running } from './helpers.js'

const cli = fileURLToPath(new URL('../src/cli.ts', import.meta.url))

async function connectHttp(running: Running): Promise<Client> {
  const client = new Client({ name: 'agent', version: '1.0.0' })
  await client.connect(new StreamableHTTPClientTransport(new URL(`${running.url}/mcp`)))
  return client
}

async function connectStdio(url: string): Promise<Client> {
  const client = new Client({ name: 'agent', version: '1.0.0' })
  await client.connect(new StdioClientTransport({ command: process.execPath, args: ['--import', 'tsx', cli, 'mcp', '--url', url] }))
  return client
}

async function call(client: Client, name: string, args: Record<string, unknown> = {}) {
  const result = await client.callTool({ name, arguments: args })
  const content = result.content as Array<{ type: string; text: string }>
  const text = content[0]?.text ?? ''
  return { isError: result.isError === true, text, value: result.isError ? null : JSON.parse(text) }
}

function signInEmail(to: string, code: string) {
  return {
    from: 'Acme <hello@acme.com>',
    to,
    subject: 'Your sign-in code',
    html: `<p>Your code is <b>${code}</b>.</p><a href="https://app.acme.com/verify?code=${code}">Sign in</a>`,
  }
}

test('an agent signs up with a fresh address and reads the code and link over HTTP', async (t) => {
  const running = await start()
  const client = await connectHttp(running)
  t.after(async () => {
    await client.close()
    await running.close()
  })
  const tools = await client.listTools()
  assert.deepEqual(tools.tools.map((tool) => tool.name).sort(), ['clear', 'get_code', 'get_links', 'list_messages', 'new_address', 'wait_for_email'])

  const fresh = await call(client, 'new_address', { prefix: 'Sign Up' })
  assert.match(fresh.value.address, /^sign-up\.[0-9a-f]{8}@inbox\.test$/)
  const waiting = call(client, 'wait_for_email', { to: fresh.value.address, after: fresh.value.cursor, timeout: 10 })
  await sleep(300)
  await sendResend(running.server, signInEmail(fresh.value.address, '482913'))
  const first = await waiting
  assert.equal(first.value.code, '482913')
  assert.equal(first.value.link, 'https://app.acme.com/verify?code=482913')
  assert.match(first.value.text, /Your code is 482913/)

  await sendResend(running.server, signInEmail(fresh.value.address, '551200'))
  const resent = await call(client, 'wait_for_email', { to: fresh.value.address, after: first.value.id, timeout: 5 })
  assert.equal(resent.value.code, '551200')
  assert.equal((await call(client, 'get_code', { to: fresh.value.address })).value.code, '551200')
  assert.equal((await call(client, 'get_links', { to: fresh.value.address })).value.link, 'https://app.acme.com/verify?code=551200')
  const listed = await call(client, 'list_messages', { to: fresh.value.address })
  assert.deepEqual(listed.value.map((m: { code: string }) => m.code), ['551200', '482913'])

  assert.equal((await call(client, 'clear', { to: fresh.value.address })).value.deleted, 2)
  const gone = await call(client, 'get_code', { to: fresh.value.address })
  assert.equal(gone.isError, true)
  assert.match(gone.text, /wait_for_email/)
})

test('a wait that times out tells the agent which send nid refused', async (t) => {
  const running = await start()
  const client = await connectHttp(running)
  t.after(async () => {
    await client.close()
    await running.close()
  })
  await sendResend(running.server, { to: 'refused@inbox.test', subject: 'Hi', text: 'Code 1234' })
  const result = await call(client, 'wait_for_email', { to: 'refused@inbox.test', timeout: 0.5 })
  assert.equal(result.isError, true)
  assert.match(result.text, /Timed out waiting for mail to refused@inbox\.test/)
  assert.match(result.text, /resend request was rejected .* with 422: Missing `from` field\./)
})

test('a web page on another site cannot reach the MCP endpoint', async (t) => {
  const running = await start()
  t.after(() => running.close())
  const request = (origin: string) =>
    fetch(`${running.url}/mcp`, {
      method: 'POST',
      headers: { origin, 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }),
    })
  assert.equal((await request('https://evil.example')).status, 403)
  assert.notEqual((await request('http://localhost:3000')).status, 403)
})

test('nid mcp serves the same tools over stdio to a running server', async (t) => {
  const running = await start()
  const client = await connectStdio(running.url)
  t.after(async () => {
    await client.close()
    await running.close()
  })
  await sendResend(running.server, signInEmail('stdio@inbox.test', '908172'))
  assert.equal((await call(client, 'get_code', { to: 'stdio@inbox.test' })).value.code, '908172')
})

test('nid mcp says so when no server is running', async (t) => {
  const client = await connectStdio('http://127.0.0.1:9')
  t.after(() => client.close())
  const result = await call(client, 'list_messages')
  assert.equal(result.isError, true)
  assert.match(result.text, /Could not reach nid: .*Is nid serve running\?/)
})
