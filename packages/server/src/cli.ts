#!/usr/bin/env node
import { spawn } from 'node:child_process'
import { createHash, timingSafeEqual } from 'node:crypto'
import { existsSync } from 'node:fs'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { parseArgs } from 'node:util'
import { version } from './version.js'
import type { SerializedMessage } from './api/serialize.js'
import type { WebhookResult } from './api/webhook.js'

const defaultPort = 4400
const defaultSmtpPort = 1025
const defaultHost = '127.0.0.1'

const help = `nid ${version}

Usage:
  nid serve [--port 4400] [--smtp-port 1025] [--host 127.0.0.1] [--db mail.sqlite] [--cors origin] [--allow-host name] [--auto-webhook event] [--token secret]
  nid run [serve options] [--url <url>] -- <command...>
  nid read <address> [--latest] [--code] [--links] [--wait 30] [--json]
  nid clear [<address>]
  nid webhook <message-id> <delivered|deferred|bounced|complained|opened|clicked>
  nid mcp
  nid healthcheck

Options for read, clear, webhook, mcp, healthcheck and run:
  --url <url>   The server to talk to (default: $NID_URL or http://127.0.0.1:4400)

Environment:
  NID_URL, NID_TOKEN, NID_AUTH_TOKEN, NID_PORT, NID_SMTP_PORT, NID_HOST, NID_DB, NID_INTERCEPT, NID_AUTO_WEBHOOK
  NID_<PROVIDER>_WEBHOOK_URL, NID_<PROVIDER>_WEBHOOK_SECRET, such as NID_BREVO_WEBHOOK_URL
`

const serverOptionConfig = {
  port: { type: 'string', default: process.env.NID_PORT ?? String(defaultPort) },
  'smtp-port': { type: 'string', default: process.env.NID_SMTP_PORT ?? String(defaultSmtpPort) },
  host: { type: 'string', default: process.env.NID_HOST ?? defaultHost },
  db: { type: 'string', default: process.env.NID_DB },
  cors: { type: 'string', multiple: true, default: [] as string[] },
  'allow-host': { type: 'string', multiple: true, default: [] as string[] },
  'auto-webhook': { type: 'string', default: process.env.NID_AUTO_WEBHOOK },
  token: { type: 'string', default: process.env.NID_AUTH_TOKEN },
  quiet: { type: 'boolean', default: false },
} as const

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

function createTokenAuth(expected: string) {
  const expectedHash = createHash('sha256').update(expected).digest()
  return (credential: { value: string }) => {
    const actualHash = createHash('sha256').update(credential.value).digest()
    return timingSafeEqual(expectedHash, actualHash) ? { projectId: 'default', plan: 'local' } : null
  }
}

async function startServer(values: {
  port: string
  'smtp-port': string
  host: string
  db?: string | undefined
  cors: string[]
  'allow-host': string[]
  'auto-webhook'?: string | undefined
  token?: string | undefined
  quiet: boolean
}) {
  const [{ createServer }, { providers }, { webhookEvents }] = await Promise.all([
    import('./server.js'),
    import('./providers/index.js'),
    import('./providers/types.js'),
  ])
  let autoWebhook: (typeof webhookEvents)[number] | undefined
  if (values['auto-webhook']) {
    if (!webhookEvents.includes(values['auto-webhook'] as (typeof webhookEvents)[number])) {
      fail(`--auto-webhook must be one of ${webhookEvents.join(', ')}`)
    }
    autoWebhook = values['auto-webhook'] as (typeof webhookEvents)[number]
  }
  const token = values.token?.trim()
  if (values.token !== undefined && !token) {
    fail('--token must not be empty')
  }
  let store
  if (values.db) {
    const { createSqliteStore } = await import('./store/index.js')
    store = await createSqliteStore({ path: values.db }).catch((err: Error) => fail(err.message))
  }
  const webhooks = Object.fromEntries(
    providers.flatMap((p) => {
      const env = `NID_${p.name.toUpperCase()}_WEBHOOK`
      const url = process.env[`${env}_URL`]
      return url ? [[p.name, { url, secret: process.env[`${env}_SECRET`] }]] : []
    }),
  )
  const server = await createServer({
    ...(store ? { store } : {}),
    ...(token ? { auth: createTokenAuth(token) } : {}),
    cors: values.cors,
    allowHosts: values['allow-host'],
    webhooks,
    ...(autoWebhook ? { autoWebhook } : {}),
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
        ...(autoWebhook ? [`  auto        ${autoWebhook} webhook after each send`] : []),
        ...(token ? ['  auth        token required'] : []),
        `  mail is ${where}`,
        '',
      ].join('\n'),
    )
  }
  return { server, listening }
}

async function serve(args: string[]) {
  const { values } = parseArgs({ args, options: serverOptionConfig })
  const { server } = await startServer(values)
  const stop = async () => {
    await server.close()
    process.exit(0)
  }
  process.once('SIGINT', stop)
  process.once('SIGTERM', stop)
}

function resolveInterceptPath(): string {
  const jsPath = fileURLToPath(new URL('./intercept.js', import.meta.url))
  if (existsSync(jsPath)) return jsPath
  return fileURLToPath(new URL('./intercept.ts', import.meta.url))
}

async function run(args: string[]) {
  const dashDash = args.indexOf('--')
  if (dashDash === -1) fail('Usage: nid run [options] -- <command...>')
  const nidArgs = args.slice(0, dashDash)
  const commandArgs = args.slice(dashDash + 1)
  const { values } = parseArgs({
    args: nidArgs,
    options: {
      ...serverOptionConfig,
      url: { type: 'string' },
    },
  })
  const command = commandArgs[0]
  if (!command) fail('Usage: nid run [options] -- <command...>')

  let targetUrl: string
  let serverToClose: { close(): Promise<void> } | null = null
  const localToken = values.url ? undefined : values.token?.trim()
  if (values.url) {
    targetUrl = baseUrl(values.url)
  } else {
    const started = await startServer(values)
    serverToClose = started.server
    targetUrl = started.listening.host === '0.0.0.0' ? `http://127.0.0.1:${started.listening.port}` : started.listening.url
  }

  const importFlag = `--import ${pathToFileURL(resolveInterceptPath()).href}`
  const existingNodeOptions = process.env.NODE_OPTIONS?.trim()
  const nodeOptions = existingNodeOptions ? `${existingNodeOptions} ${importFlag}` : importFlag

  const child = spawn(command, commandArgs.slice(1), {
    stdio: 'inherit',
    env: {
      ...process.env,
      NID_URL: targetUrl,
      ...(localToken ? { NID_TOKEN: localToken } : {}),
      RESEND_BASE_URL: targetUrl,
      RESEND_API_URL: targetUrl,
      AWS_ENDPOINT_URL_SESV2: targetUrl,
      AWS_ENDPOINT_URL_SES: targetUrl,
      NODE_OPTIONS: nodeOptions,
    },
  })

  let interrupted = false
  const forward = (signal: NodeJS.Signals) => {
    interrupted = true
    child.kill(signal)
  }
  process.on('SIGINT', forward)
  process.on('SIGTERM', forward)

  const exitCode = await new Promise<number>((resolve) => {
    child.once('error', (err) => {
      process.stderr.write(`nid: failed to start ${command}: ${err.message}\n`)
      resolve(1)
    })
    child.once('exit', (code, signal) => {
      if (code !== null) resolve(code)
      else resolve(signal || interrupted ? 1 : 0)
    })
  })

  process.off('SIGINT', forward)
  process.off('SIGTERM', forward)
  await serverToClose?.close()
  process.exit(exitCode)
}

const controlCharacters = /[\x00-\x08\x0b-\x1f\x7f-\x9f]/g

function print(text: string) {
  process.stdout.write(`${text.replace(controlCharacters, '')}\n`)
}

function printMessage(message: SerializedMessage, flags: { code: boolean; links: boolean; json: boolean }) {
  if (flags.json) return process.stdout.write(`${JSON.stringify(message, null, 2)}\n`)
  if (flags.code) {
    if (!message.extracted.code) fail('No code found in the message', 1)
    return print(message.extracted.code)
  }
  if (flags.links) {
    if (message.extracted.links.length === 0) fail('No links found in the message', 1)
    return print(message.extracted.links.map((l) => l.href).join('\n'))
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
  print(lines.join('\n'))
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
    print(`#${m.id}  ${m.createdAt}  ${m.provider}  ${m.subject}${code}`)
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
  const body = (await response.json()) as WebhookResult
  if (!response.ok || body.appStatus === null) fail(body.error ?? 'Request failed')
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

try {
  switch (command) {
    case 'serve':
      await serve(rest)
      break
    case 'run':
      await run(rest)
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
} catch (err) {
  if ((err as { code?: string }).code?.startsWith('ERR_PARSE_ARGS_')) fail(`${(err as Error).message}\n\n${help}`)
  throw err
}
