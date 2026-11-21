import { Hono, type Context } from 'hono'
import type { Provider, IncomingRequest, ProviderReply, SendRoute, ReadRoute, WebhookEvent } from '../providers/types.js'
import { SendError } from '../providers/types.js'
import type { Store } from '../store/types.js'
import type { Message, Project } from '../types.js'
import { magicActionFor, magicMatchFor, type FaultStore } from './faults.js'
import type { Ingest } from './types.js'

export interface HttpIngestOptions {
  providers: Provider[]
  ingest: Ingest
  store: Store
  faults?: FaultStore | undefined
  magicAddresses?: boolean | undefined
  autoWebhook?: WebhookEvent | undefined
  onAutoWebhook?:
    | ((project: Project, provider: Provider, message: Message, event: WebhookEvent, recipient?: string) => void)
    | undefined
}

async function readRequest(c: Context): Promise<IncomingRequest> {
  const contentType = c.req.header('content-type') ?? ''
  let body: unknown = null
  let rawBody = ''
  if (c.req.method !== 'GET' && c.req.method !== 'HEAD') {
    if (contentType.includes('multipart/form-data') || contentType.includes('application/x-www-form-urlencoded')) {
      const urlEncoded = contentType.includes('application/x-www-form-urlencoded')
      if (urlEncoded) rawBody = await c.req.text()
      body = await c.req.parseBody({ all: true })
      if (!urlEncoded) rawBody = JSON.stringify(body, (_, v) => (v instanceof File ? `(file ${v.name}, ${v.size} bytes)` : v))
    } else {
      rawBody = await c.req.text()
      if (rawBody.trim()) {
        try {
          body = JSON.parse(rawBody)
        } catch {
          body = undefined
        }
      }
    }
  }
  return {
    method: c.req.method,
    path: c.req.path,
    params: c.req.param() as Record<string, string>,
    query: new URL(c.req.url).searchParams,
    headers: c.req.raw.headers,
    contentType,
    body,
    rawBody,
  }
}

const statusesWithoutBody = [204, 205, 304]

function send(c: Context, reply: ProviderReply) {
  for (const [k, v] of Object.entries(reply.headers ?? {})) c.header(k, v)
  if (reply.body === null || reply.body === undefined || statusesWithoutBody.includes(reply.status)) {
    return c.body(null, reply.status as 200)
  }
  const hasContentType = Object.keys(reply.headers ?? {}).some((k) => k.toLowerCase() === 'content-type')
  if (typeof reply.body === 'string') {
    return hasContentType ? c.body(reply.body, reply.status as 200) : c.text(reply.body, reply.status as 200)
  }
  return hasContentType ? c.body(JSON.stringify(reply.body), reply.status as 200) : c.json(reply.body as object, reply.status as 200)
}

async function authenticate(
  c: Context,
  provider: Provider,
  req: IncomingRequest,
  ingest: Ingest,
): Promise<Project | Response> {
  const value = provider.credential(req)
  if (!value) return send(c, provider.unauthorized())
  const project = await ingest.resolveProject({ kind: 'http', provider: provider.name, value })
  if (!project) return send(c, provider.unauthorized())
  return project
}

function waitDelay(ms: number, signal?: AbortSignal): Promise<boolean> {
  if (ms <= 0) return Promise.resolve(!signal?.aborted)
  return new Promise((resolve) => {
    const done = (ok: boolean) => {
      signal?.removeEventListener('abort', onAbort)
      clearTimeout(timer)
      resolve(ok)
    }
    const onAbort = () => done(false)
    const timer = setTimeout(() => done(true), ms)
    signal?.addEventListener('abort', onAbort, { once: true })
  })
}

function faultErrorMessage(status: number, body: unknown): string {
  if (typeof body === 'string' && body) return body
  if (body && typeof body === 'object' && !Array.isArray(body)) {
    const rec = body as Record<string, unknown>
    if (typeof rec.message === 'string' && rec.message) return rec.message
    if (typeof rec.error === 'string' && rec.error) return rec.error
  }
  return `Simulated fault (${status})`
}

async function handleSend(
  c: Context,
  provider: Provider,
  route: SendRoute,
  req: IncomingRequest,
  project: Project,
  options: HttpIngestOptions,
) {
  const { ingest, store } = options
  const reject = (err: SendError) =>
    ingest.reject(project, { provider: provider.name, to: err.to, status: err.reply.status, error: err.message, raw: req.rawBody })
  let parsed
  try {
    parsed = await route.parse(req)
  } catch (err) {
    if (err instanceof SendError) {
      await reject(err)
      return send(c, err.reply)
    }
    throw err
  }
  const allRecipients = [
    ...new Set(parsed.flatMap((o) => (o instanceof SendError ? o.to : o.recipients.map((r) => r.address)))),
  ]
  const fault = options.faults?.consume(project.projectId, provider.name, allRecipients)
  if (fault) {
    if (!(await waitDelay(fault.delayMs, c.req.raw.signal))) {
      return c.body(null, 499 as 500)
    }
    if (fault.status >= 300) {
      const errMsg = faultErrorMessage(fault.status, fault.body)
      if (fault.status >= 400) {
        await ingest.reject(project, {
          provider: provider.name,
          to: allRecipients,
          status: fault.status,
          error: errMsg,
          raw: req.rawBody,
        })
      }
      const fallbackBody = fault.status >= 400 ? { error: errMsg } : null
      return send(c, { status: fault.status, headers: fault.headers, body: fault.body ?? fallbackBody })
    }
  }
  const batchMagic = options.magicAddresses ? magicActionFor(allRecipients) : null
  if (batchMagic === 'ratelimit') {
    await ingest.reject(project, {
      provider: provider.name,
      to: allRecipients,
      status: 429,
      error: 'Rate limit exceeded',
      raw: req.rawBody,
    })
    return send(c, { status: 429, headers: { 'retry-after': '1' }, body: { error: 'Rate limit exceeded' } })
  }

  const outcomes: Array<Message | SendError> = []
  const newlyAccepted: Message[] = []
  for (const message of parsed) {
    if (message instanceof SendError) {
      await reject(message)
      outcomes.push(message)
      continue
    }
    const existing = message.idempotencyKey
      ? await store.findByIdempotencyKey(project.projectId, provider.name, message.idempotencyKey)
      : null
    if (existing) {
      outcomes.push(existing)
    } else {
      const accepted = await ingest.accept(project, message)
      outcomes.push(accepted)
      newlyAccepted.push(accepted)
    }
  }
  const stored = outcomes.filter((o): o is Message => !(o instanceof SendError))
  if (options.onAutoWebhook) {
    for (const msg of newlyAccepted) {
      const magic = options.magicAddresses ? magicMatchFor(msg.recipients.map((r) => r.address)) : null
      const event = magic && magic.action !== 'ratelimit' ? magic.action : options.autoWebhook
      if (event) {
        options.onAutoWebhook(project, provider, msg, event, magic ? magic.recipient : undefined)
      }
    }
  }
  return send(c, route.reply(stored, outcomes))
}

async function handleRead(c: Context, route: ReadRoute, req: IncomingRequest, project: Project, store: Store) {
  return send(c, await route.handle(req, { store, projectId: project.projectId }))
}

export function providerRoutes(options: HttpIngestOptions): Hono {
  const app = new Hono()
  for (const provider of options.providers) {
    for (const route of provider.routes) {
      app.on(route.method, route.path, async (c) => {
        const req = await readRequest(c)
        const project = await authenticate(c, provider, req, options.ingest)
        if (project instanceof Response) return project
        if (route.kind === 'send') {
          return handleSend(c, provider, route, req, project, options)
        }
        return handleRead(c, route, req, project, options.store)
      })
    }
  }
  return app
}
