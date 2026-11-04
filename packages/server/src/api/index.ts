import { Hono } from 'hono'
import { streamSSE } from 'hono/streaming'
import type { Ingest } from '../ingest/types.js'
import type { Provider } from '../providers/types.js'
import type { Store } from '../store/types.js'
import type { Project } from '../types.js'
import { openapi } from './openapi.js'
import {
  compilePattern,
  deleteQuery,
  isIssue,
  messagesQuery,
  parseQuery,
  rejectionsQuery,
  streamQuery,
  waitQuery,
} from './query.js'
import { serializeMessage, serializeRejection } from './serialize.js'
import { defaultTimeoutSeconds, describeTimeout, waitForMessage } from './wait.js'

export interface ApiOptions {
  store: Store
  ingest: Ingest
  providers: Provider[]
  version: string
}

type Env = { Variables: { project: Project } }

function bearerToken(header: string | undefined): string | null {
  const match = header?.match(/^Bearer\s+(\S+)$/i)
  return match?.[1] ?? null
}

export function readApi(options: ApiOptions): Hono<Env> {
  const { store } = options
  const app = new Hono<Env>()

  app.use('*', async (c, next) => {
    const token = bearerToken(c.req.header('authorization')) ?? c.req.query('token') ?? ''
    const project = await options.ingest.resolveProject({ kind: 'http', provider: 'api', value: token })
    if (!project) return c.json({ error: 'Invalid or missing token' }, 401)
    c.set('project', project)
    await next()
  })

  app.get('/cursor', async (c) => {
    return c.json({ cursor: await store.cursor(c.get('project').projectId) })
  })

  app.get('/wait', async (c) => {
    const query = parseQuery(waitQuery, new URL(c.req.url).searchParams)
    if (isIssue(query)) return c.json(query, 400)
    const pattern = compilePattern(query.code_pattern)
    if (isIssue(pattern)) return c.json(pattern, 400)
    const params = {
      to: query.to,
      after: query.after,
      subject: query.subject,
      provider: query.provider,
      hasCode: query.has_code,
      codePattern: pattern,
      timeoutMs: (query.timeout ?? defaultTimeoutSeconds) * 1000,
      signal: c.req.raw.signal,
    }
    const result = await waitForMessage(store, c.get('project').projectId, params)
    if (!result.message) {
      return c.json(
        {
          timedOut: true,
          error: describeTimeout(params, result),
          messages: result.arrived.map((m) => serializeMessage(m)),
          recent_rejections: result.rejections.map((r) => serializeRejection(r)),
        },
        404,
      )
    }
    const message = serializeMessage(result.message)
    if (pattern) message.extracted = { ...message.extracted, code: result.code }
    return c.json({ message })
  })

  app.get('/messages', async (c) => {
    const query = parseQuery(messagesQuery, new URL(c.req.url).searchParams)
    if (isIssue(query)) return c.json(query, 400)
    const messages = await store.listMessages(c.get('project').projectId, {
      to: query.to,
      subject: query.subject,
      provider: query.provider,
      after: query.after,
      hasCode: query.has_code,
      limit: query.limit,
    })
    return c.json({ messages: messages.map((m) => serializeMessage(m)) })
  })

  app.delete('/messages', async (c) => {
    const query = parseQuery(deleteQuery, new URL(c.req.url).searchParams)
    if (isIssue(query)) return c.json(query, 400)
    const deleted = await store.deleteMessages(c.get('project').projectId, query.to)
    return c.json({ deleted })
  })

  app.get('/messages/:id', async (c) => {
    const id = Number(c.req.param('id'))
    if (!Number.isInteger(id)) return c.json({ error: 'Message id must be an integer' }, 400)
    const message = await store.getMessage(c.get('project').projectId, id)
    if (!message) return c.json({ error: `No message with id ${id}` }, 404)
    return c.json({ message: serializeMessage(message, { raw: true }) })
  })

  app.get('/messages/:id/attachments/:n', async (c) => {
    const id = Number(c.req.param('id'))
    const n = Number(c.req.param('n'))
    if (!Number.isInteger(id) || !Number.isInteger(n)) return c.json({ error: 'Ids must be integers' }, 400)
    const attachment = await store.getAttachment(c.get('project').projectId, id, n)
    if (!attachment) return c.json({ error: `No attachment ${n} on message ${id}` }, 404)
    const safeName = attachment.filename.replace(/["\r\n]/g, '')
    return c.body(new Uint8Array(attachment.content), 200, {
      'content-type': attachment.contentType,
      'content-disposition': `attachment; filename="${safeName}"`,
      'content-length': String(attachment.content.byteLength),
    })
  })

  app.get('/rejections', async (c) => {
    const query = parseQuery(rejectionsQuery, new URL(c.req.url).searchParams)
    if (isIssue(query)) return c.json(query, 400)
    const rejections = await store.listRejections(c.get('project').projectId, {
      to: query.to,
      after: query.after,
      limit: query.limit,
    })
    return c.json({ rejections: rejections.map((r) => serializeRejection(r, { raw: true })) })
  })

  app.get('/stream', async (c) => {
    const query = parseQuery(streamQuery, new URL(c.req.url).searchParams)
    if (isIssue(query)) return c.json(query, 400)
    const projectId = c.get('project').projectId
    let messageCursor = query.after ?? (await store.cursor(projectId))
    let rejectionCursor = (await store.listRejections(projectId, { limit: 1 }))[0]?.id ?? 0
    return streamSSE(c, async (stream) => {
      await stream.writeSSE({ event: 'ready', data: JSON.stringify({ cursor: messageCursor }) })
      let beat = 0
      while (!c.req.raw.signal.aborted && !stream.closed && !stream.aborted) {
        let messages
        let rejections
        try {
          messages = await store.listMessages(projectId, { after: messageCursor, order: 'asc', limit: 100 })
          rejections = (await store.listRejections(projectId, { after: rejectionCursor, limit: 100 })).reverse()
        } catch {
          break
        }
        for (const m of messages) {
          messageCursor = m.id
          await stream.writeSSE({ event: 'message', data: JSON.stringify(serializeMessage(m)), id: String(m.id) })
        }
        for (const r of rejections) {
          rejectionCursor = r.id
          await stream.writeSSE({ event: 'rejection', data: JSON.stringify(serializeRejection(r)) })
        }
        if (++beat % 50 === 0) await stream.writeSSE({ event: 'ping', data: '' })
        await stream.sleep(400)
      }
    })
  })

  app.get('/providers', (c) => {
    return c.json({
      providers: options.providers.map((p) => ({ name: p.name, label: p.label, setup: p.setup })),
    })
  })

  app.get('/openapi.json', (c) => c.json(openapi(options.version)))

  return app
}
