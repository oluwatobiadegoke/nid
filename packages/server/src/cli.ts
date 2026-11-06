#!/usr/bin/env node
import { parseArgs } from 'node:util'
import { version } from './version.js'
import type { SerializedMessage } from './api/serialize.js'
import type { WebhookResult } from './api/webhook.js'

const defaultPort = 4400
const defaultSmtpPort = 1025
const defaultHost = '127.0.0.1'

const help = `nid ${version}

Usage:
  nid serve [--port 4400] [--smtp-port 1025] [--host 127.0.0.1] [--db mail.sqlite] [--cors] [--allow-host name]
  nid read <address> [--latest] [--code] [--links] [--wait 30] [--json]
  nid clear [<address>]
  nid webhook <message-id> <delivered|deferred|bounced|complained|opened|clicked>
  nid mcp
  nid healthcheck

Options for read, clear, webhook, mcp and healthcheck:
  --url <url>   The server to talk to (default: $NID_URL or http://127.0.0.1:4400)

Environment:
  NID_URL, NID_TOKEN, NID_PORT, NID_SMTP_PORT, NID_HOST, NID_DB
  NID_<PROVIDER>_WEBHOOK_URL, NID_<PROVIDER>_WEBHOOK_SECRET, such as NID_BREVO_WEBHOOK_URL
`

function fail(message: string, code = 1): never {
  process.stderr.write(`${message}\n`)
  process.exit(code)
}

function baseUrl(value: string | undefined): string {
  return (value ?? process.env.NID_URL ?? `http://127.0.0.1:${defaultPort}`).replace(/\/+$/, '')
}

async function api(url: string, path: string, init: RequestInit = {}): Promise<Response> {
  const headers = new Headers(init.headers)
  const token = process.env.NID_TOKEN
  if (token) headers.set('authorization', `Bearer ${token}`)
  try {
    return await fetch(`${url}${path}`, { ...init, headers })
  } catch (err) {
    fail(`Could not reach ${url}: ${(err as Error).message}. Is nid serve running?`, 2)
  }
}

async function serve(args: string[]) {
  const { values } = parseArgs({
    args,
    options: {
      port: { type: 'string', default: process.env.NID_PORT ?? String(defaultPort) },
      'smtp-port': { type: 'string', default: process.env.NID_SMTP_PORT ?? String(defaultSmtpPort) },
      host: { type: 'string', default: process.env.NID_HOST ?? defaultHost },
      db: { type: 'string', default: process.env.NID_DB },
      cors: { type: 'boolean', default: false },
      'allow-host': { type: 'string', multiple: true, default: [] },
      quiet: { type: 'boolean', default: false },
    },
  })
  const [{ createServer }, { createSqliteStore }, { providers }] = await Promise.all([
    import('./server.js'),
    import('./store/index.js'),
    import('./providers/index.js'),
  ])
  const store = await createSqliteStore(values.db ? { path: values.db } : {})
  const webhooks = Object.fromEntries(
    providers.flatMap((p) => {
      const env = `NID_${p.name.toUpperCase()}_WEBHOOK`
      const url = process.env[`${env}_URL`]
      return url ? [[p.name, { url, secret: process.env[`${env}_SECRET`] }]] : []
    }),
  )
  const server = await createServer({
    store,
    cors: values.cors,
    allowHosts: values['allow-host'],
    webhooks,
    onError: (err) => process.stderr.write(`nid: ${err.message}\n`),
  }).catch((err: Error) => fail(err.message))
  const listening = await server.listen({
    port: Number(values.port),
    smtpPort: Number(values['smtp-port']),
    host: values.host,
  })
  if (!values.quiet) {
    const where = values.db ? `kept in ${values.db}` : 'kept in memory until you stop the server'
    process.stdout.write(
      [
        `nid ${version}`,
        `  web view    ${listening.url}`,
        `  provider APIs and read API on ${listening.url}`,
        `  SMTP        ${listening.host}:${listening.smtpPort}`,
        ...Object.entries(webhooks).map(([name, target]) => {
          const shown = new URL(target.url)
          shown.username = ''
          shown.password = ''
          return `  webhooks    ${name} to ${shown.href}`
        }),
        `  mail is ${where}`,
        '',
      ].join('\n'),
    )
  }
  const stop = async () => {
    await server.close()
    process.exit(0)
  }
  process.once('SIGINT', stop)
  process.once('SIGTERM', stop)
}

function printMessage(message: SerializedMessage, flags: { code: boolean; links: boolean; json: boolean }) {
  if (flags.json) return process.stdout.write(`${JSON.stringify(message, null, 2)}\n`)
  if (flags.code) {
    if (!message.extracted.code) fail('No code found in the message', 1)
    return process.stdout.write(`${message.extracted.code}\n`)
  }
  if (flags.links) {
    if (message.extracted.links.length === 0) fail('No links found in the message', 1)
    return process.stdout.write(`${message.extracted.links.map((l) => l.href).join('\n')}\n`)
  }
  const lines = [
    `#${message.id}  ${message.provider}  ${message.createdAt}`,
    `From:    ${message.from}`,
    `To:      ${message.to.join(', ')}`,
    `Subject: ${message.subject}`,
  ]
  if (message.extracted.code) lines.push(`Code:    ${message.extracted.code}`)
  if (message.extracted.link) lines.push(`Link:    ${message.extracted.link}`)
  lines.push('', message.text ?? message.html ?? '')
  process.stdout.write(`${lines.join('\n')}\n`)
}

async function read(args: string[]) {
  const { values, positionals } = parseArgs({
    args,
    allowPositionals: true,
    options: {
      latest: { type: 'boolean', default: false },
      code: { type: 'boolean', default: false },
      links: { type: 'boolean', default: false },
      wait: { type: 'string' },
      json: { type: 'boolean', default: false },
      url: { type: 'string' },
    },
  })
  const address = positionals[0]
  if (!address) fail('Usage: nid read <address> [--latest] [--code] [--links] [--wait 30]')
  const url = baseUrl(values.url)
  const flags = { code: values.code, links: values.links, json: values.json }
  if (values.wait !== undefined) {
    const seconds = Number.parseInt(values.wait, 10) || 30
    const cursor = (await (await api(url, '/api/cursor')).json()) as { cursor: number }
    const query = new URLSearchParams({ to: address, after: String(cursor.cursor), timeout: String(seconds) })
    if (values.code) query.set('has_code', 'true')
    const response = await api(url, `/api/wait?${query}`)
    const body = (await response.json()) as { message?: SerializedMessage; error?: string }
    if (!response.ok || !body.message) fail(body.error ?? 'No message arrived', 1)
    return printMessage(body.message, flags)
  }
  const query = new URLSearchParams({ to: address, limit: values.latest ? '1' : '50' })
  const response = await api(url, `/api/messages?${query}`)
  const body = (await response.json()) as { messages?: SerializedMessage[]; error?: string }
  if (!response.ok || !body.messages) fail(body.error ?? 'Request failed', 1)
  if (body.messages.length === 0) fail(`No mail for ${address}`, 1)
  if (values.latest || values.code || values.links) return printMessage(body.messages[0] as SerializedMessage, flags)
  if (values.json) return process.stdout.write(`${JSON.stringify(body.messages, null, 2)}\n`)
  for (const m of body.messages) {
    const code = m.extracted.code ? `  code ${m.extracted.code}` : ''
    process.stdout.write(`#${m.id}  ${m.createdAt}  ${m.provider}  ${m.subject}${code}\n`)
  }
}

async function clear(args: string[]) {
  const { values, positionals } = parseArgs({
    args,
    allowPositionals: true,
    options: { url: { type: 'string' } },
  })
  const query = positionals[0] ? `?${new URLSearchParams({ to: positionals[0] })}` : ''
  const response = await api(baseUrl(values.url), `/api/messages${query}`, { method: 'DELETE' })
  const body = (await response.json()) as { deleted?: number; error?: string }
  if (!response.ok) fail(body.error ?? 'Request failed', 1)
  process.stdout.write(`Deleted ${body.deleted ?? 0} message${body.deleted === 1 ? '' : 's'}\n`)
}

async function webhook(args: string[]) {
  const { values, positionals } = parseArgs({
    args,
    allowPositionals: true,
    options: { url: { type: 'string' } },
  })
  const [id, type] = positionals
  if (!id || !type) fail('Usage: nid webhook <message-id> <delivered|deferred|bounced|complained|opened|clicked>')
  const response = await api(baseUrl(values.url), `/api/messages/${encodeURIComponent(id)}/events`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ type }),
  })
  const body = (await response.json()) as WebhookResult & { error?: string }
  if (!response.ok) fail(body.error ?? 'Request failed', 1)
  if (body.appStatus === null) fail(body.error ?? 'Could not reach your app', 1)
  process.stdout.write(`Your app answered ${body.appStatus} in ${body.durationMs} ms\n${body.appBody ? `${body.appBody}\n` : ''}`)
  if (!body.delivered) process.exit(1)
}

async function mcp(args: string[]) {
  const { values } = parseArgs({ args, options: { url: { type: 'string' } } })
  const url = baseUrl(values.url)
  const [{ serveStdio }, { createMcpServer }] = await Promise.all([
    import('@modelcontextprotocol/server/stdio'),
    import('./mcp/tools.js'),
  ])
  const token = process.env.NID_TOKEN
  serveStdio(() => createMcpServer((path, init) => fetch(`${url}${path}`, init), token ? `Bearer ${token}` : undefined))
}

async function healthcheck(args: string[]) {
  const { values } = parseArgs({ args, options: { url: { type: 'string' } } })
  const response = await api(baseUrl(values.url), '/healthz')
  if (!response.ok) fail(`Server answered ${response.status}`, 1)
  const body = (await response.json()) as { version: string }
  process.stdout.write(`ok ${body.version}\n`)
}

const [command, ...rest] = process.argv.slice(2)

switch (command) {
  case 'serve':
    await serve(rest)
    break
  case 'read':
    await read(rest)
    break
  case 'clear':
    await clear(rest)
    break
  case 'webhook':
    await webhook(rest)
    break
  case 'mcp':
    await mcp(rest)
    break
  case 'healthcheck':
    await healthcheck(rest)
    break
  case '--version':
  case '-v':
    process.stdout.write(`${version}\n`)
    break
  case undefined:
  case 'help':
  case '--help':
  case '-h':
    process.stdout.write(help)
    break
  default:
    fail(`Unknown command: ${command}\n\n${help}`)
}
