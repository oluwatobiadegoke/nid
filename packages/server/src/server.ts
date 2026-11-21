import type { AddressInfo } from 'node:net'
import { serve, type ServerType } from '@hono/node-server'
import { Hono } from 'hono'
import { bodyLimit } from 'hono/body-limit'
import { cors } from 'hono/cors'
import type { SMTPServer } from 'smtp-server'
import { readApi } from './api/index.js'
import { dispatchWebhook, type WebhookTarget } from './api/webhook.js'
import { createMemoryEventBus, type EventBus } from './events/index.js'
import { createFaultStore, type FaultStore } from './ingest/faults.js'
import { createIngest, defaultLimits, type Ingest } from './ingest/index.js'
import { providerRoutes } from './ingest/http.js'
import { createSmtpServer, listenSmtp } from './ingest/smtp.js'
import { providers as builtInProviders, type Provider } from './providers/index.js'
import { webhookEvents, type WebhookEvent } from './providers/types.js'
import { hostCheck } from './security/host.js'
import { mcpRoutes } from './mcp/http.js'
import { createMemoryStore, type Store } from './store/index.js'
import type { AuthHook, LimitsHook, Message } from './types.js'
import { webView } from './ui/index.js'
import { version } from './version.js'

export interface ServerOptions {
  store?: Store
  events?: EventBus
  faults?: FaultStore
  auth?: AuthHook
  limits?: LimitsHook
  providers?: Provider[]
  allowHosts?: string[]
  cors?: boolean
  ui?: boolean
  maxBodyBytes?: number
  webhooks?: Record<string, WebhookTarget>
  magicAddresses?: boolean
  autoWebhook?: WebhookEvent
  onMessage?: (message: Message) => void
  onError?: (error: Error) => void
}

export interface ListenOptions {
  port?: number
  smtpPort?: number | false
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
  events: EventBus
  faults: FaultStore
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
    const protocol = URL.canParse(target.url) ? new URL(target.url).protocol : ''
    if (!/^https?:$/.test(protocol)) {
      throw new Error(
        `The ${name} webhook URL ${JSON.stringify(target.url)} is not an http:// or https:// URL. Check NID_${name.toUpperCase()}_WEBHOOK_URL.`,
      )
    }
  }
  if (options.autoWebhook !== undefined && !webhookEvents.includes(options.autoWebhook)) {
    throw new Error(`autoWebhook must be one of ${webhookEvents.join(', ')}.`)
  }
  const store = options.store ?? createMemoryStore()
  const events = options.events ?? createMemoryEventBus()
  const faults = options.faults ?? createFaultStore()
  const magicAddresses = options.magicAddresses ?? !options.auth
  const webhooks = options.webhooks ?? {}
  const maxBodyBytes = options.maxBodyBytes ?? defaultLimits.maxBodyBytes
  const ingest = createIngest({ store, events, auth: options.auth, limits: options.limits, onMessage: options.onMessage })

  let closed = false
  let currentSmtpPort = defaultSmtpPort
  const pendingAutoWebhooks = new Map<ReturnType<typeof setTimeout>, () => Promise<void>>()
  const inFlightWebhooks = new Set<Promise<void>>()

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
  app.route(
    '/api',
    readApi({
      store,
      events,
      ingest,
      providers,
      webhooks,
      faults,
      allowHosts: options.allowHosts,
      getSmtpPort: () => currentSmtpPort,
      version,
    }),
  )
  app.route('/mcp', mcpRoutes(async (path, init) => app.request(path, init), options.allowHosts ?? []))
  if (options.ui !== false) app.route('/', webView())
  app.route(
    '/',
    providerRoutes({
      providers,
      ingest,
      store,
      faults,
      magicAddresses,
      autoWebhook: options.autoWebhook,
      onAutoWebhook(project, provider, message, event, recipient) {
        const target = webhooks[provider.name]
        if (!target || !provider.webhook || closed) return
        const run = () => {
          const task = dispatchWebhook({
            store,
            events,
            provider,
            target,
            projectId: project.projectId,
            message,
            event,
            recipient,
          })
            .then(() => {})
            .catch((err) => options.onError?.(err as Error))
            .finally(() => {
              inFlightWebhooks.delete(task)
            })
          inFlightWebhooks.add(task)
          return task
        }
        const timer = setTimeout(() => {
          pendingAutoWebhooks.delete(timer)
          if (!closed) void run()
        }, 10)
        timer.unref()
        pendingAutoWebhooks.set(timer, run)
      },
    }),
  )
  app.notFound((c) => c.json({ error: `No route for ${c.req.method} ${c.req.path}` }, 404))
  app.onError((err, c) => {
    options.onError?.(err)
    return c.json({ error: err.message }, 500)
  })

  const sweepTimer = options.limits
    ? setInterval(() => {
        void store.deleteExpired(new Date().toISOString()).catch((err) => options.onError?.(err as Error))
      }, 60_000)
    : null
  sweepTimer?.unref()

  let listening: Listening | null = null

  return {
    app,
    store,
    events,
    faults,
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
      let smtp: SMTPServer | null = null
      let smtpPort = 0
      if (listenOptions.smtpPort !== false) {
        try {
          smtp = await createSmtpServer({ ingest, maxBodyBytes, onError: options.onError })
          smtpPort = await listenSmtp(smtp, listenOptions.smtpPort ?? defaultSmtpPort, host)
        } catch (err) {
          await closeHttp(http)
          throw err
        }
      }
      currentSmtpPort = smtpPort
      const urlHost = host.includes(':') ? `[${host}]` : host
      listening = {
        url: `http://${urlHost}:${port}`,
        host,
        port,
        smtpPort,
        close: async () => {
          await Promise.all([closeHttp(http), smtp ? closeSmtp(smtp) : Promise.resolve()])
          smtp = null
          listening = null
        },
      }
      return listening
    },
    async close() {
      if (closed) return
      closed = true
      if (sweepTimer) clearInterval(sweepTimer)
      for (const [timer, run] of [...pendingAutoWebhooks]) {
        clearTimeout(timer)
        pendingAutoWebhooks.delete(timer)
        void run()
      }
      if (inFlightWebhooks.size > 0) {
        await Promise.allSettled([...inFlightWebhooks])
      }
      await listening?.close()
      await store.close()
    },
  }
}
