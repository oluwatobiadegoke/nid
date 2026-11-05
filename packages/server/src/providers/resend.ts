import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import type { Message, NewMessage, Recipient } from '../types.js'
import {
  addressList,
  attachmentFrom,
  bearer,
  header,
  isRecord,
  keyPerItem,
  looseAddress,
  mailboxes,
  rejectedFor,
  parseMailbox,
  stringHeaders,
  toAddresses,
} from './shared.js'
import { SendError, type IncomingRequest, type Provider, type ProviderReply, type ReadRoute, type SendRoute } from './types.js'

const name = 'resend'

function error(status: number, code: string, message: string): SendError {
  return new SendError({ status, body: { statusCode: status, message, name: code } }, [], message)
}

function rawRecipients(items: unknown[]): string[] {
  return items
    .flatMap((item) => (isRecord(item) ? [item.to, item.cc, item.bcc].flatMap((v) => addressList(v as string | string[] | undefined)) : []))
    .map(looseAddress)
}

const addressField = z.union([z.string(), z.array(z.string()).max(50)])

const sendSchema = z
  .object({
    from: z.string().optional(),
    to: addressField.optional(),
    cc: addressField.optional(),
    bcc: addressField.optional(),
    reply_to: addressField.optional(),
    subject: z.string().optional(),
    html: z.string().optional(),
    text: z.string().optional(),
    headers: z.record(z.string(), z.unknown()).optional(),
    attachments: z
      .array(
        z.object({
          content: z.union([z.string(), z.array(z.number())]).optional(),
          filename: z.union([z.string(), z.literal(false)]).optional(),
          path: z.string().optional(),
          content_type: z.string().optional(),
          contentType: z.string().optional(),
          content_id: z.string().optional(),
          contentId: z.string().optional(),
        }),
      )
      .optional(),
    tags: z.array(z.object({ name: z.string(), value: z.string() })).optional(),
    scheduled_at: z.string().optional(),
    template: z
      .object({
        id: z.string(),
        variables: z.record(z.string(), z.unknown()).optional(),
      })
      .optional(),
    topic_id: z.string().nullable().optional(),
  })
  .passthrough()

type SendBody = z.infer<typeof sendSchema>

function parseRecipients(values: string[], kind: Recipient['kind']): Recipient[] {
  return mailboxes(values, kind, () =>
    error(422, 'validation_error', `Invalid \`${kind}\` field. The email address needs to follow the \`email@example.com\` or \`Name <email@example.com>\` format.`),
  )
}

function toMessage(body: unknown, req: IncomingRequest, raw: string): NewMessage {
  if (!isRecord(body)) throw error(422, 'validation_error', 'Invalid request body.')
  const result = sendSchema.safeParse(body)
  if (!result.success) {
    const issue = result.error.issues[0]
    const field = issue?.path[0] ? String(issue.path[0]) : 'body'
    throw error(422, 'validation_error', `Invalid \`${field}\` field.`)
  }
  const data: SendBody = result.data
  const to = addressList(data.to)
  if (to.length === 0) throw error(422, 'validation_error', 'Missing `to` field.')
  const templated = !!data.template
  if (!data.from && !templated) throw error(422, 'validation_error', 'Missing `from` field.')
  if (!data.subject && !templated) throw error(422, 'validation_error', 'Missing `subject` field.')
  if (!data.html && !data.text && !templated && !('react' in body)) {
    throw error(422, 'validation_error', 'Missing `html` or `text` field.')
  }
  const from = data.from ? parseMailbox(data.from) : null
  if (data.from && !from) {
    throw error(422, 'validation_error', 'Invalid `from` field. The email address needs to follow the `email@example.com` or `Name <email@example.com>` format.')
  }
  const recipients = [
    ...parseRecipients(to, 'to'),
    ...parseRecipients(addressList(data.cc), 'cc'),
    ...parseRecipients(addressList(data.bcc), 'bcc'),
  ]
  const attachments = (data.attachments ?? []).map((a) =>
    attachmentFrom(
      typeof a.filename === 'string' ? a.filename : a.path?.split('/').pop(),
      typeof a.content === 'string' ? a.content : a.content ? Buffer.from(a.content).toString('base64') : null,
      a.content_type ?? a.contentType,
      a.content_id ?? a.contentId,
    ),
  )
  const meta: Record<string, unknown> = {}
  if (data.tags) meta.tags = data.tags
  if (data.scheduled_at) meta.scheduledAt = data.scheduled_at
  if (data.template) {
    meta.templateId = data.template.id
    meta.variables = data.template.variables ?? {}
  }
  if (data.topic_id) meta.topicId = data.topic_id
  return {
    provider: name,
    providerId: randomUUID(),
    from: data.from ?? '',
    replyTo: addressList(data.reply_to),
    recipients,
    subject: data.subject ?? '',
    text: data.text ?? null,
    html: data.html ?? null,
    headers: stringHeaders(data.headers),
    attachments,
    raw,
    meta,
    idempotencyKey: header(req, 'idempotency-key'),
  }
}

const send: SendRoute = {
  kind: 'send',
  method: 'POST',
  path: '/emails',
  parse(req) {
    return rejectedFor(rawRecipients([req.body]), () => [toMessage(req.body, req, req.rawBody)])
  },
  reply(messages) {
    return { status: 200, body: { id: messages[0]?.providerId } }
  },
}

const batch: SendRoute = {
  kind: 'send',
  method: 'POST',
  path: '/emails/batch',
  parse(req) {
    const items = req.body
    if (!Array.isArray(items)) throw error(422, 'validation_error', 'Request body must be an array of emails.')
    return rejectedFor(rawRecipients(items), () => {
      if (items.length === 0) throw error(422, 'validation_error', 'Request body must contain at least one email.')
      if (items.length > 100) throw error(422, 'validation_error', 'Batch requests are limited to 100 emails.')
      return keyPerItem(items.map((item) => toMessage(item, req, JSON.stringify(item))))
    })
  },
  reply(messages) {
    return { status: 200, body: { data: messages.map((m) => ({ id: m.providerId })) } }
  },
}

function emailShape(m: Message) {
  const list = (kind: Recipient['kind']) => {
    const addresses = toAddresses(m.recipients, kind)
    return addresses.length > 0 ? addresses : null
  }
  return {
    object: 'email',
    id: m.providerId,
    to: toAddresses(m.recipients, 'to'),
    from: m.from,
    created_at: m.createdAt,
    subject: m.subject,
    html: m.html,
    text: m.text,
    bcc: list('bcc'),
    cc: list('cc'),
    reply_to: m.replyTo.length > 0 ? m.replyTo : null,
    last_event: 'delivered',
    scheduled_at: (m.meta.scheduledAt as string | undefined) ?? null,
    tags: (m.meta.tags as unknown[] | undefined) ?? [],
    message_id: `<${m.providerId}@nid.local>`,
  }
}

const get: ReadRoute = {
  kind: 'read',
  method: 'GET',
  path: '/emails/:id',
  async handle(req, { store, projectId }): Promise<ProviderReply> {
    const message = await store.findByProviderId(projectId, name, req.params.id ?? '')
    if (!message) return { status: 404, body: { statusCode: 404, message: 'Email not found', name: 'not_found' } }
    return { status: 200, body: emailShape(message) }
  },
}

export const resend: Provider = {
  name,
  label: 'Resend',
  credential: bearer,
  unauthorized() {
    return { status: 401, body: { statusCode: 401, message: 'Missing API key in the authorization header.', name: 'missing_api_key' } }
  },
  routes: [send, batch, get],
  setup: {
    env: 'RESEND_BASE_URL=http://localhost:4400',
    note: 'Node SDK reads RESEND_BASE_URL. Python reads RESEND_API_URL.',
  },
}
