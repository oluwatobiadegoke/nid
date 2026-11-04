import { Hono, type Context } from 'hono'
import type { Provider, IncomingRequest, ProviderReply, SendRoute, ReadRoute } from '../providers/types.js'
import { SendError } from '../providers/types.js'
import type { Store } from '../store/types.js'
import type { Message, Project } from '../types.js'
import type { Ingest } from './types.js'

export interface HttpIngestOptions {
  providers: Provider[]
  ingest: Ingest
  store: Store
}

async function readRequest(c: Context): Promise<IncomingRequest> {
  const contentType = c.req.header('content-type') ?? ''
  let body: unknown = null
  let rawBody = ''
  if (c.req.method !== 'GET' && c.req.method !== 'HEAD') {
    if (contentType.includes('multipart/form-data') || contentType.includes('application/x-www-form-urlencoded')) {
      body = await c.req.parseBody({ all: true })
      rawBody = contentType.includes('application/x-www-form-urlencoded') ? await c.req.text().catch(() => '') : ''
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

function send(c: Context, reply: ProviderReply) {
  for (const [k, v] of Object.entries(reply.headers ?? {})) c.header(k, v)
  if (reply.body === null || reply.body === undefined) return c.body(null, reply.status as 200)
  if (typeof reply.body === 'string') return c.text(reply.body, reply.status as 200)
  return c.json(reply.body as object, reply.status as 200)
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

async function handleSend(
  c: Context,
  provider: Provider,
  route: SendRoute,
  req: IncomingRequest,
  project: Project,
  ingest: Ingest,
  store: Store,
) {
  let parsed
  try {
    parsed = route.parse(req)
  } catch (err) {
    if (err instanceof SendError) {
      await ingest.reject(project, {
        provider: provider.name,
        to: err.to,
        status: err.reply.status,
        error: err.message,
        raw: req.rawBody,
      })
      return send(c, err.reply)
    }
    throw err
  }
  const stored: Message[] = []
  for (const message of parsed) {
    if (message.idempotencyKey) {
      const existing = await store.findByIdempotencyKey(project.projectId, provider.name, message.idempotencyKey)
      if (existing) {
        stored.push(existing)
        continue
      }
    }
    stored.push(await ingest.accept(project, message))
  }
  return send(c, route.reply(stored, req))
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
          return handleSend(c, provider, route, req, project, options.ingest, options.store)
        }
        return handleRead(c, route, req, project, options.store)
      })
    }
  }
  return app
}
