import { z } from 'zod'
import type { NewMessage, Recipient } from '../types.js'
import { attachmentFrom, header, isRecord, normalizeAddress, recipientsFrom, stringHeaders, timestampId } from './shared.js'
import { SendError, type IncomingRequest, type Provider, type SendRoute } from './types.js'

const name = 'brevo'

function error(status: number, code: string, message: string, to: string[] = []): SendError {
  return new SendError({ status, body: { code, message } }, to, message)
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

function recipients(list: Array<{ email: string; name?: string | undefined }> | undefined, kind: Recipient['kind'], to: string[]) {
  for (const c of list ?? []) {
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(c.email)) {
      throw error(400, 'invalid_parameter', `email is invalid in ${kind}`, to)
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
  const to = (merged.to ?? []).map((c) => normalizeAddress(c.email))
  if (to.length === 0) throw error(400, 'missing_parameter', 'to is missing')
  const templated = data.templateId !== undefined
  if (!templated) {
    if (!data.sender?.email) throw error(400, 'missing_parameter', 'sender is missing', to)
    if (!merged.subject) throw error(400, 'missing_parameter', 'subject is missing', to)
    if (!merged.htmlContent && !merged.textContent) {
      throw error(400, 'missing_parameter', 'htmlContent or textContent is missing', to)
    }
  }
  const from = data.sender?.email
    ? data.sender.name
      ? `${data.sender.name} <${normalizeAddress(data.sender.email)}>`
      : normalizeAddress(data.sender.email)
    : ''
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
      ...recipients(merged.to, 'to', to),
      ...recipients(merged.cc, 'cc', to),
      ...recipients(merged.bcc, 'bcc', to),
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

const send: SendRoute = {
  kind: 'send',
  method: 'POST',
  path: '/v3/smtp/email',
  parse(req) {
    if (!isRecord(req.body)) throw error(400, 'invalid_parameter', 'Invalid request body')
    const result = sendSchema.safeParse(req.body)
    if (!result.success) {
      const issue = result.error.issues[0]
      const field = issue?.path[0] ? String(issue.path[0]) : 'body'
      throw error(400, 'invalid_parameter', `${field} is invalid`)
    }
    const data = result.data
    if (data.messageVersions && data.messageVersions.length > 0) {
      return data.messageVersions.map((v) => build(data, v, req, req.rawBody))
    }
    return [build(data, null, req, req.rawBody)]
  },
  reply(messages) {
    if (messages.length > 1) return { status: 201, body: { messageIds: messages.map((m) => m.providerId) } }
    return { status: 201, body: { messageId: messages[0]?.providerId } }
  },
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
}
