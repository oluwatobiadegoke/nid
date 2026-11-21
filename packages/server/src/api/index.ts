import { Hono } from 'hono'
import { streamSSE } from 'hono/streaming'
import type { EventBus } from '../events/index.js'
import type { FaultStore } from '../ingest/faults.js'
import type { Ingest } from '../ingest/types.js'
import { webhookEvents, type Provider, type WebhookEvent } from '../providers/types.js'
import { originCheck } from '../security/host.js'
import type { Store } from '../store/types.js'
import type { Message, Project } from '../types.js'
import { openapi } from './openapi.js'
import {
  compilePattern,
  deleteQuery,
  faultBodySchema,
  isIssue,
  messagesQuery,
  parseQuery,
  rejectionsQuery,
  streamQuery,
  waitQuery,
} from './query.js'
import { serializeMessage, serializeRejection } from './serialize.js'
import { defaultTimeoutSeconds, describeTimeout, waitForMessage } from './wait.js'
import { dispatchWebhook, type WebhookTarget } from './webhook.js'

export interface ApiOptions {
  store: Store
  events: EventBus
  ingest: Ingest
  providers: Provider[]
  webhooks: Record<string, WebhookTarget>
  faults: FaultStore
  allowHosts?: string[] | undefined
  getSmtpPort: () => number
  version: string
}

type Env = { Variables: { project: Project } }

function bearerToken(header: string | undefined): string | null {
  const match = header?.match(/^Bearer\s+(\S+)$/i)
  return match?.[1] ?? null
}

async function renderHtmlPreview(store: Store, projectId: string, message: Message): Promise<string> {
  let html = message.html ?? ''
  for (const info of message.attachments) {
    if (!info.contentId) continue
    const cleanId = info.contentId.replace(/^<|>$/g, '').replace(/^cid:/i, '').trim()
    if (!cleanId) continue
    const attachment = await store.getAttachment(projectId, message.id, info.n)
    if (!attachment) continue
    const mediaType = attachment.contentType.split(';')[0]!.replace(/[^\w.+/-]/g, '') || 'application/octet-stream'
    const dataUrl = `data:${mediaType};base64,${Buffer.from(attachment.content).toString('base64')}`
    const escaped = cleanId.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    html = html.replace(new RegExp(`cid:${escaped}(?=["'\\s)>]|$)`, 'gi'), () => dataUrl)
  }
  return html
}

function isJson(contentType: string | undefined): boolean {
  return /^application\/json\b/i.test(contentType ?? '')
}

export function readApi(options: ApiOptions): Hono<Env> {
  const { store, events, faults } = options
  const app = new Hono<Env>()

  app.use('*', originCheck(options.allowHosts ?? []))
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
    const result = await waitForMessage(store, events, c.get('project').projectId, params)
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

  app.delete('/messages/:id', async (c) => {
    const id = Number(c.req.param('id'))
    if (!Number.isInteger(id)) return c.json({ error: 'Message id must be an integer' }, 400)
    const deleted = await store.deleteMessage(c.get('project').projectId, id)
    if (!deleted) return c.json({ error: `No message with id ${id}` }, 404)
    return c.json({ deleted: true })
  })

  app.get('/messages/:id/html', async (c) => {
    const id = Number(c.req.param('id'))
    if (!Number.isInteger(id)) return c.json({ error: 'Message id must be an integer' }, 400)
    const projectId = c.get('project').projectId
    const message = await store.getMessage(projectId, id)
    if (!message) return c.json({ error: `No message with id ${id}` }, 404)
    if (!message.html) return c.json({ error: `Message ${id} has no HTML body` }, 404)
    const html = await renderHtmlPreview(store, projectId, message)
    return c.html(html, 200, {
      'content-security-policy':
        "sandbox; default-src 'none'; img-src * data: blob:; style-src 'unsafe-inline' https: http:; font-src * data:; form-action 'none'; base-uri 'none'",
      'referrer-policy': 'no-referrer',
      'x-content-type-options': 'nosniff',
    })
  })

  app.get('/messages/:id/events', async (c) => {
    const id = Number(c.req.param('id'))
    if (!Number.isInteger(id)) return c.json({ error: 'Message id must be an integer' }, 400)
    const projectId = c.get('project').projectId
    const message = await store.getMessage(projectId, id)
    if (!message) return c.json({ error: `No message with id ${id}` }, 404)
    const deliveries = await store.listWebhookDeliveries(projectId, id)
    return c.json({ events: deliveries })
  })

  app.post('/messages/:id/events', async (c) => {
    const id = Number(c.req.param('id'))
    if (!Number.isInteger(id)) return c.json({ error: 'Message id must be an integer' }, 400)
    if (!isJson(c.req.header('content-type'))) {
      return c.json({ error: 'Send the event as JSON, with content-type: application/json' }, 415)
    }
    const body = (await c.req.json().catch(() => null)) as {
      type?: unknown
      recipient?: unknown
      url?: unknown
      reason?: unknown
    } | null
    const event = body?.type as WebhookEvent
    if (!webhookEvents.includes(event)) {
      return c.json({ error: `type must be one of ${webhookEvents.join(', ')}` }, 400)
    }
    if (body?.recipient !== undefined && (typeof body.recipient !== 'string' || !body.recipient.trim())) {
      return c.json({ error: 'recipient must be a non-empty string' }, 400)
    }
    if (body?.url !== undefined && typeof body.url !== 'string') {
      return c.json({ error: 'url must be a string' }, 400)
    }
    if (body?.reason !== undefined && typeof body.reason !== 'string') {
      return c.json({ error: 'reason must be a string' }, 400)
    }
    const projectId = c.get('project').projectId
    const message = await store.getMessage(projectId, id)
    if (!message) return c.json({ error: `No message with id ${id}` }, 404)
    const provider = options.providers.find((p) => p.name === message.provider)
    if (!provider?.webhook) return c.json({ error: `Mail sent over ${message.provider} has no webhooks` }, 400)
    const target = options.webhooks[provider.name]
    if (!target) {
      return c.json(
        {
          error: `No ${provider.label} webhook URL is set. Start nid with NID_${provider.name.toUpperCase()}_WEBHOOK_URL set to your app's ${provider.label} webhook route.`,
        },
        400,
      )
    }
    try {
      const outcome = await dispatchWebhook({
        store,
        events,
        provider,
        target,
        projectId,
        message,
        event,
        recipient: typeof body?.recipient === 'string' ? body.recipient.trim() : undefined,
        url: typeof body?.url === 'string' ? body.url : undefined,
        reason: typeof body?.reason === 'string' ? body.reason : undefined,
      })
      return c.json(outcome)
    } catch (err) {
      return c.json({ error: (err as Error).message }, 400)
    }
  })

  app.get('/messages/:id/attachments/:n', async (c) => {
    const id = Number(c.req.param('id'))
    const n = Number(c.req.param('n'))
    if (!Number.isInteger(id) || !Number.isInteger(n)) return c.json({ error: 'Ids must be integers' }, 400)
    const attachment = await store.getAttachment(c.get('project').projectId, id, n)
    if (!attachment) return c.json({ error: `No attachment ${n} on message ${id}` }, 404)
    const asciiName = attachment.filename.replace(/[^\x20-\x7e]|["\\]/g, '_')
    const utf8Name = encodeURIComponent(attachment.filename).replace(/['()*]/g, (ch) => `%${ch.charCodeAt(0).toString(16).toUpperCase()}`)
    return c.body(new Uint8Array(attachment.content), 200, {
      'content-type': attachment.contentType,
      'content-disposition': `attachment; filename="${asciiName}"; filename*=UTF-8''${utf8Name}`,
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

  app.delete('/rejections', async (c) => {
    const query = parseQuery(deleteQuery, new URL(c.req.url).searchParams)
    if (isIssue(query)) return c.json(query, 400)
    const deleted = await store.deleteRejections(c.get('project').projectId, query.to)
    return c.json({ deleted })
  })

  app.get('/faults', (c) => {
    return c.json({ faults: faults.list(c.get('project').projectId) })
  })

  app.post('/faults', async (c) => {
    if (!isJson(c.req.header('content-type'))) {
      return c.json({ error: 'Send the rule as JSON, with content-type: application/json' }, 415)
    }
    const raw = await c.req.json().catch(() => undefined)
    const parsed = faultBodySchema.safeParse(raw)
    if (!parsed.success) {
      return c.json(
        {
          error: 'Invalid body',
          details: parsed.error.issues.map((i) => {
            const path = i.path.join('.')
            return path ? `${path}: ${i.message}` : i.message
          }),
        },
        400,
      )
    }
    const rule = faults.add(c.get('project').projectId, parsed.data)
    return c.json({ fault: rule }, 201)
  })

  app.delete('/faults', (c) => {
    return c.json({ cleared: faults.clear(c.get('project').projectId) })
  })

  app.get('/stream', async (c) => {
    const query = parseQuery(streamQuery, new URL(c.req.url).searchParams)
    if (isIssue(query)) return c.json(query, 400)
    const projectId = c.get('project').projectId
    const rawLastId = c.req.header('last-event-id')?.trim()
    const parsedLastId = rawLastId && /^\d+$/.test(rawLastId) ? Number(rawLastId) : undefined
    return streamSSE(c, async (stream) => {
      let dirty = false
      let wake: (() => void) | null = null
      const flushWake = () => {
        const current = wake
        wake = null
        current?.()
      }
      const unsubscribe = events.subscribe(projectId, (event) => {
        if (event.kind !== 'message' && event.kind !== 'rejection') return
        dirty = true
        flushWake()
      })
      let done = false
      const stop = () => {
        if (done) return
        done = true
        unsubscribe()
        flushWake()
      }
      stream.onAbort(stop)
      c.req.raw.signal.addEventListener('abort', stop, { once: true })
      const heartbeat = setInterval(() => {
        if (!done && !stream.closed && !stream.aborted) {
          void stream.writeSSE({ event: 'ping', data: '' }).catch(stop)
        }
      }, 20_000)
      heartbeat.unref?.()
      const isStopped = () => done || c.req.raw.signal.aborted || stream.closed || stream.aborted
      try {
        const newest = await store.cursor(projectId)
        let messageCursor = Math.min(parsedLastId ?? query.after ?? newest, newest)
        let rejectionCursor = (await store.listRejections(projectId, { limit: 1 }))[0]?.id ?? 0
        await stream.writeSSE({ event: 'ready', data: JSON.stringify({ cursor: messageCursor }) })
        const drain = async () => {
          while (!isStopped()) {
            const messages = await store.listMessages(projectId, { after: messageCursor, order: 'asc', limit: 100 })
            for (const m of messages) {
              if (isStopped()) return
              if (m.id <= messageCursor) continue
              messageCursor = m.id
              await stream.writeSSE({ event: 'message', data: JSON.stringify(serializeMessage(m)), id: String(m.id) })
            }
            if (messages.length < 100) break
          }
          while (!isStopped()) {
            const rejections = await store.listRejections(projectId, { after: rejectionCursor, order: 'asc', limit: 100 })
            for (const r of rejections) {
              if (isStopped()) return
              if (r.id <= rejectionCursor) continue
              rejectionCursor = r.id
              await stream.writeSSE({ event: 'rejection', data: JSON.stringify(serializeRejection(r)) })
            }
            if (rejections.length < 100) break
          }
        }
        while (!isStopped()) {
          dirty = false
          await drain()
          if (isStopped()) break
          if (dirty) continue
          await new Promise<void>((resolve) => {
            wake = resolve
          })
        }
      } finally {
        clearInterval(heartbeat)
        c.req.raw.signal.removeEventListener('abort', stop)
        stop()
      }
    })
  })

  app.get('/providers', (c) => {
    return c.json({
      providers: options.providers.map((p) => ({ name: p.name, label: p.label, setup: p.setup })),
      smtpPort: options.getSmtpPort(),
      webhooks: Object.keys(options.webhooks),
    })
  })

  app.get('/openapi.json', (c) => c.json(openapi(options.version)))

  return app
}
