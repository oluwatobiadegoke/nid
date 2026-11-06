import type { AddressInfo } from 'node:net'
import { serve, type ServerType } from '@hono/node-server'
import { Hono } from 'hono'
import { bodyLimit } from 'hono/body-limit'
import { cors } from 'hono/cors'
import type { SMTPServer } from 'smtp-server'
import { readApi } from './api/index.js'
import { createIngest, defaultLimits, type Ingest } from './ingest/index.js'
import { providerRoutes } from './ingest/http.js'
import { createSmtpServer, listenSmtp } from './ingest/smtp.js'
import { providers as builtInProviders, type Provider } from './providers/index.js'
import { hostCheck } from './security/host.js'
import { mcpRoutes } from './mcp/http.js'
import type { WebhookTarget } from './api/webhook.js'
import { createSqliteStore, type Store } from './store/index.js'
import type { AuthHook, LimitsHook, Message } from './types.js'
import { webView } from './ui/index.js'
import { version } from './version.js'

export interface ServerOptions {
  store?: Store
  auth?: AuthHook
  limits?: LimitsHook
  providers?: Provider[]
  allowHosts?: string[]
  cors?: boolean
  ui?: boolean
  maxBodyBytes?: number
  webhooks?: Record<string, WebhookTarget>
  onMessage?: (message: Message) => void
  onError?: (error: Error) => void
}

export interface ListenOptions {
  port?: number
  smtpPort?: number
  host?: string
}

export interface Listening {
  url: string
  host: string
  port: number
  smtpPort: number
  close(): Promise<void>
}

export interface NidServer {
  app: Hono
  store: Store
  ingest: Ingest
  providers: Provider[]
  version: string
  listen(options?: ListenOptions): Promise<Listening>
  close(): Promise<void>
}

export const defaultPort = 4400
export const defaultSmtpPort = 1025
export const defaultHost = '127.0.0.1'

function closeHttp(server: ServerType): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((err) => (err ? reject(err) : resolve()))
    if ('closeAllConnections' in server) server.closeAllConnections()
  })
}

function closeSmtp(server: SMTPServer): Promise<void> {
  return new Promise((resolve) => server.close(() => resolve()))
}

export async function createServer(options: ServerOptions = {}): Promise<NidServer> {
  const providers = options.providers ?? builtInProviders
  const webhookProviders = providers.filter((p) => p.webhook).map((p) => p.name)
  for (const [name, target] of Object.entries(options.webhooks ?? {})) {
    if (!webhookProviders.includes(name)) {
      throw new Error(`webhooks.${name} names no provider that sends webhooks. Use ${webhookProviders.join(', ')}.`)
    }
    if (!/^https?:\/\//i.test(target.url) || !URL.canParse(target.url)) {
      throw new Error(`The ${name} webhook URL ${JSON.stringify(target.url)} is not an http:// or https:// URL. Check NID_${name.toUpperCase()}_WEBHOOK_URL.`)
    }
  }
  const store = options.store ?? (await createSqliteStore())
  const maxBodyBytes = options.maxBodyBytes ?? defaultLimits.maxBodyBytes
  const ingest = createIngest({ store, auth: options.auth, limits: options.limits, onMessage: options.onMessage })

  const app = new Hono({ strict: false })
  app.use('*', hostCheck(options.allowHosts ?? []))
  if (options.cors) app.use('*', cors())
  app.use(
    '*',
    bodyLimit({
      maxSize: maxBodyBytes,
      onError: (c) => c.json({ error: `Request body is over the ${maxBodyBytes} byte limit` }, 413),
    }),
  )
  app.get('/healthz', (c) => c.json({ ok: true, version }))
  app.route('/api', readApi({ store, ingest, providers, webhooks: options.webhooks ?? {}, version }))
  app.route('/mcp', mcpRoutes(async (path, init) => app.request(path, init), options.allowHosts ?? []))
  if (options.ui !== false) app.route('/', webView())
  app.route('/', providerRoutes({ providers, ingest, store }))
  app.notFound((c) => c.json({ error: `No route for ${c.req.method} ${c.req.path}` }, 404))
  app.onError((err, c) => {
    options.onError?.(err)
    return c.json({ error: err.message }, 500)
  })

  const smtp = createSmtpServer({ ingest, maxBodyBytes, onError: options.onError })
  let listening: Listening | null = null

  return {
    app,
    store,
    ingest,
    providers,
    version,
    async listen(listenOptions = {}) {
      if (listening) return listening
      const host = listenOptions.host ?? defaultHost
      const http = await new Promise<ServerType>((resolve, reject) => {
        const server = serve({ fetch: app.fetch, port: listenOptions.port ?? defaultPort, hostname: host }, () =>
          resolve(server),
        )
        server.once('error', reject)
      })
      const port = (http.address() as AddressInfo).port
      let smtpPort: number
      try {
        smtpPort = await listenSmtp(smtp, listenOptions.smtpPort ?? defaultSmtpPort, host)
      } catch (err) {
        await closeHttp(http)
        throw err
      }
      const urlHost = host.includes(':') ? `[${host}]` : host
      listening = {
        url: `http://${urlHost}:${port}`,
        host,
        port,
        smtpPort,
        close: async () => {
          await Promise.all([closeHttp(http), closeSmtp(smtp)])
          listening = null
        },
      }
      return listening
    },
    async close() {
      await listening?.close()
      await store.close()
    },
  }
}
