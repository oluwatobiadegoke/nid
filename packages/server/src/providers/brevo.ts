import { z } from 'zod'
import type { NewMessage, Recipient } from '../types.js'
import {
  attachmentFrom,
  bounceReason,
  deferReason,
  findHeader,
  formatMailbox,
  header,
  isRecord,
  keyPerItem,
  looseAddress,
  normalizeAddress,
  recipientsFrom,
  rejectedFor,
  stringHeaders,
  timestampId,
} from './shared.js'
import { SendError, type IncomingRequest, type Provider, type SendRoute, type WebhookEvent, type WebhookInput } from './types.js'

const name = 'brevo'

function error(code: string, message: string): SendError {
  return new SendError({ status: 400, body: { code, message } }, [], message)
}

const contact = z.object({ email: z.string(), name: z.string().optional() })
const contacts = z.array(contact)

const versionSchema = z.object({
  to: contacts.optional(),
  cc: contacts.optional(),
  bcc: contacts.optional(),
  replyTo: contact.optional(),
  subject: z.string().optional(),
  htmlContent: z.string().optional(),
  textContent: z.string().optional(),
  params: z.record(z.string(), z.unknown()).optional(),
})

const sendSchema = z
  .object({
    sender: z.object({ email: z.string().optional(), name: z.string().optional(), id: z.number().optional() }).optional(),
    to: contacts.optional(),
    cc: contacts.optional(),
    bcc: contacts.optional(),
    replyTo: contact.optional(),
    subject: z.string().optional(),
    htmlContent: z.string().optional(),
    textContent: z.string().optional(),
    templateId: z.number().optional(),
    params: z.record(z.string(), z.unknown()).optional(),
    headers: z.record(z.string(), z.unknown()).optional(),
    attachment: z
      .array(z.object({ content: z.string().optional(), name: z.string().optional(), url: z.string().optional() }))
      .optional(),
    tags: z.array(z.string()).optional(),
    scheduledAt: z.string().optional(),
    batchId: z.string().optional(),
    messageVersions: z.array(versionSchema).optional(),
  })
  .passthrough()

type SendBody = z.infer<typeof sendSchema>
type Version = z.infer<typeof versionSchema>

function recipients(list: Array<{ email: string; name?: string | undefined }> | undefined, kind: Recipient['kind']) {
  for (const c of list ?? []) {
    if (!/^[^\s@]+@[^\s@.]+(?:\.[^\s@.]+)+$/.test(c.email)) {
      throw error('invalid_parameter', `email is invalid in ${kind}`)
    }
  }
  return recipientsFrom((list ?? []).map((c) => ({ address: c.email, name: c.name })), kind)
}

function messageId(): string {
  return `<${timestampId()}.${Math.random().toString(16).slice(2, 10)}@smtp-relay.mailin.fr>`
}

function build(data: SendBody, version: Version | null, req: IncomingRequest, raw: string): NewMessage {
  const merged = {
    to: version?.to ?? data.to,
    cc: version?.cc ?? data.cc,
    bcc: version?.bcc ?? data.bcc,
    replyTo: version?.replyTo ?? data.replyTo,
    subject: version?.subject ?? data.subject,
    htmlContent: version?.htmlContent ?? data.htmlContent,
    textContent: version?.textContent ?? data.textContent,
    params: version?.params ?? data.params,
  }
  if (!merged.to?.length) throw error('missing_parameter', 'to is missing')
  const templated = data.templateId !== undefined
  if (!templated) {
    if (!data.sender?.email) throw error('missing_parameter', 'sender is missing')
    if (!merged.subject) throw error('missing_parameter', 'subject is missing')
    if (!merged.htmlContent && !merged.textContent) {
      throw error('missing_parameter', 'htmlContent or textContent is missing')
    }
  }
  const from = data.sender?.email ? formatMailbox(data.sender.email, data.sender.name) : ''
  const meta: Record<string, unknown> = {}
  if (templated) {
    meta.templateId = data.templateId
    meta.variables = merged.params ?? {}
  } else if (merged.params) {
    meta.variables = merged.params
  }
  if (data.tags) meta.tags = data.tags
  if (data.scheduledAt) meta.scheduledAt = data.scheduledAt
  if (data.batchId) meta.batchId = data.batchId
  const headers = stringHeaders(data.headers)
  if (headers['X-Sib-Sandbox'] || headers['x-sib-sandbox']) meta.sandbox = true
  return {
    provider: name,
    providerId: messageId(),
    from,
    replyTo: merged.replyTo?.email ? [normalizeAddress(merged.replyTo.email)] : [],
    recipients: [
      ...recipients(merged.to, 'to'),
      ...recipients(merged.cc, 'cc'),
      ...recipients(merged.bcc, 'bcc'),
    ],
    subject: merged.subject ?? '',
    text: merged.textContent ?? null,
    html: merged.htmlContent ?? null,
    headers,
    attachments: (data.attachment ?? []).map((a) =>
      attachmentFrom(a.name ?? a.url?.split('/').pop(), a.content, null),
    ),
    raw,
    meta,
    idempotencyKey: header(req, 'idempotency-key'),
  }
}

function rawTo(body: Record<string, unknown>): string[] {
  const versions = Array.isArray(body.messageVersions) ? body.messageVersions : []
  return [body, ...versions]
    .flatMap((v) => (isRecord(v) ? ['to', 'cc', 'bcc'].flatMap((k) => (Array.isArray(v[k]) ? v[k] : [])) : []))
    .flatMap((c) => (isRecord(c) && typeof c.email === 'string' ? [looseAddress(c.email)] : []))
}

const send: SendRoute = {
  kind: 'send',
  method: 'POST',
  path: '/v3/smtp/email',
  parse(req) {
    const body = req.body
    if (!isRecord(body)) throw error('invalid_parameter', 'Invalid request body')
    return rejectedFor(rawTo(body), () => {
      const result = sendSchema.safeParse(body)
      if (!result.success) throw error('invalid_parameter', `${String(result.error.issues[0]?.path[0] ?? 'body')} is invalid`)
      const data = result.data
      const versions = data.messageVersions ?? []
      if (versions.length === 0) return [build(data, null, req, req.rawBody)]
      return keyPerItem(versions.map((v) => build(data, v, req, req.rawBody)))
    })
  },
  reply(messages) {
    if (messages.length > 1) return { status: 201, body: { messageIds: messages.map((m) => m.providerId) } }
    return { status: 201, body: { messageId: messages[0]?.providerId } }
  },
}

const webhookTypes: Record<WebhookEvent, string> = {
  delivered: 'delivered',
  deferred: 'deferred',
  bounced: 'hard_bounce',
  complained: 'spam',
  opened: 'opened',
  clicked: 'click',
}

function webhook({ message: m, event, recipient, secret, now }: WebhookInput) {
  const seconds = Math.floor(now.getTime() / 1000)
  const payload: Record<string, unknown> = {
    event: webhookTypes[event],
    email: recipient,
    id: 1,
    date: now.toISOString().slice(0, 19).replace('T', ' '),
    ts: seconds,
    'message-id': m.providerId,
    ts_event: seconds,
    ts_epoch: now.getTime(),
    subject: m.subject,
    tags: (m.meta.tags as string[] | undefined) ?? [],
    sending_ip: '127.0.0.1',
  }
  const custom = findHeader(m.headers, 'x-mailin-custom')
  if (custom !== undefined) payload['X-Mailin-custom'] = custom
  if (event === 'bounced') payload.reason = bounceReason
  if (event === 'deferred') payload.reason = deferReason
  if (event === 'clicked') payload.link = m.extracted.link ?? ''
  return { body: JSON.stringify(payload), headers: secret ? { authorization: `Bearer ${secret}` } : {} }
}

export const brevo: Provider = {
  name,
  label: 'Brevo',
  credential(req) {
    return header(req, 'api-key')
  },
  unauthorized() {
    return { status: 401, body: { code: 'unauthorized', message: 'Key not found' } }
  },
  routes: [send],
  setup: {
    env: "new BrevoClient({ apiKey, baseUrl: 'http://localhost:4400/v3' })",
    note: 'Older SDKs: api.basePath = "http://localhost:4400/v3". The /v3 is part of the base URL.',
  },
  webhook,
}
