import { randomBytes } from 'node:crypto'
import { z } from 'zod'
import type { NewMessage, Recipient } from '../types.js'
import { attachmentFrom, bearer, isRecord, normalizeAddress, parseMailbox, recipientsFrom, stringHeaders } from './shared.js'
import { SendError, type Provider, type SendRoute } from './types.js'

const name = 'sendgrid'
const help = 'http://sendgrid.com/docs/API_Reference/Web_API_v3/Mail/errors.html'

function error(status: number, message: string, field: string | null, to: string[] = []): SendError {
  return new SendError({ status, body: { errors: [{ message, field, help: field ? `${help}#message.${field}` : null }] } }, to, message)
}

const address = z.object({ email: z.string(), name: z.string().optional() })
const addresses = z.array(address)

const personalizationSchema = z.object({
  to: addresses.optional(),
  cc: addresses.optional(),
  bcc: addresses.optional(),
  from: address.optional(),
  subject: z.string().optional(),
  headers: z.record(z.string(), z.unknown()).optional(),
  substitutions: z.record(z.string(), z.unknown()).optional(),
  dynamic_template_data: z.record(z.string(), z.unknown()).optional(),
  custom_args: z.record(z.string(), z.unknown()).optional(),
  send_at: z.number().optional(),
})

const sendSchema = z
  .object({
    personalizations: z.array(personalizationSchema).max(1000).optional(),
    from: address.optional(),
    reply_to: address.optional(),
    reply_to_list: addresses.optional(),
    subject: z.string().optional(),
    content: z.array(z.object({ type: z.string(), value: z.string() })).optional(),
    attachments: z
      .array(
        z.object({
          content: z.string(),
          filename: z.string(),
          type: z.string().optional(),
          disposition: z.string().optional(),
          content_id: z.string().optional(),
        }),
      )
      .optional(),
    template_id: z.string().optional(),
    headers: z.record(z.string(), z.unknown()).optional(),
    categories: z.array(z.string()).optional(),
    custom_args: z.record(z.string(), z.unknown()).optional(),
    send_at: z.number().optional(),
    batch_id: z.string().optional(),
    mail_settings: z.object({ sandbox_mode: z.object({ enable: z.boolean().optional() }).optional() }).passthrough().optional(),
  })
  .passthrough()

type SendBody = z.infer<typeof sendSchema>
type Personalization = z.infer<typeof personalizationSchema>

function checkAddress(email: string, field: string, to: string[]) {
  if (!/^[^\s@<>",]+@[^\s@<>",]+\.[^\s@<>",]+$/.test(email.trim())) throw error(400, 'Does not contain a valid address.', field, to)
}

function recipients(p: Personalization, field: string, to: string[]): Recipient[] {
  const seen = new Set<string>()
  return (['to', 'cc', 'bcc'] as const).flatMap((kind) => {
    const list = p[kind] ?? []
    for (const [j, a] of list.entries()) {
      checkAddress(a.email, `${field}.${kind}.${j}.email`, to)
      const address = normalizeAddress(a.email)
      if (seen.has(address)) {
        const message = `Each email address in the personalization block should be unique between to, cc, and bcc. We found the first duplicate instance of [${address}] in the ${field}.${kind} field.`
        throw error(400, message, `${field}.${kind}`, to)
      }
      seen.add(address)
    }
    return recipientsFrom(list.map((a) => ({ address: a.email, name: a.name })), kind)
  })
}

function substitute(value: string | null | undefined, substitutions: Record<string, unknown> | undefined): string | null {
  if (value === null || value === undefined) return null
  let out = value
  for (const [key, replacement] of Object.entries(substitutions ?? {})) out = out.split(key).join(String(replacement))
  return out
}

function formatAddress(a: { email: string; name?: string | undefined }): string {
  return a.name ? `${a.name} <${normalizeAddress(a.email)}>` : normalizeAddress(a.email)
}

function build(data: SendBody, p: Personalization, i: number, id: string, raw: string): NewMessage {
  const field = `personalizations.${i}`
  const to = (p.to ?? []).map((a) => parseMailbox(a.email)?.address ?? normalizeAddress(a.email))
  if (to.length === 0) {
    throw error(400, 'The to array is required for all personalization objects, and must have at least one email object with a valid email address.', `${field}.to`)
  }
  const from = p.from ?? data.from
  if (!from?.email) {
    throw error(400, 'The from object must be provided for every email send. It is an object that requires the email parameter, but may also contain a name parameter.', 'from.email', to)
  }
  checkAddress(from.email, 'from.email', to)
  const list = recipients(p, field, to)
  if (data.reply_to && data.reply_to_list) {
    throw error(400, 'The reply_to and reply_to_list parameters cannot be used together.', 'reply_to', to)
  }
  const replyTo = data.reply_to_list ?? (data.reply_to ? [data.reply_to] : [])
  for (const [j, a] of replyTo.entries()) checkAddress(a.email, data.reply_to_list ? `reply_to_list.${j}.email` : 'reply_to.email', to)
  const subject = p.subject ?? data.subject
  if (!subject && !data.template_id) {
    throw error(400, 'The subject is required. You can get around this requirement if you use a template with a subject defined or if every personalization has a subject defined.', 'subject', to)
  }
  if (!data.template_id && !data.content?.some((c) => c.value)) {
    throw error(400, 'Unless a valid template_id is provided, the content parameter is required. There must be at least one defined content block. We typically suggest both text/plain and text/html blocks are included, but only one block is required.', 'content', to)
  }
  const plainAt = data.content?.findIndex((c) => c.type === 'text/plain') ?? -1
  if (plainAt > 0) {
    throw error(400, 'If present, text/plain content must be first, followed by text/html, followed by any other content.', 'content.0.type', to)
  }
  const text = data.content?.[plainAt]?.value
  const html = data.content?.find((c) => c.type === 'text/html')?.value
  const meta: Record<string, unknown> = {}
  if (data.template_id) meta.templateId = data.template_id
  const variables = p.dynamic_template_data ?? p.substitutions
  if (variables) meta.variables = variables
  if (data.categories) meta.tags = data.categories
  const customArgs = { ...data.custom_args, ...p.custom_args }
  if (Object.keys(customArgs).length > 0) meta.customArgs = customArgs
  const sendAt = p.send_at ?? data.send_at
  if (sendAt) meta.scheduledAt = new Date(sendAt * 1000).toISOString()
  if (data.batch_id) meta.batchId = data.batch_id
  if (data.mail_settings?.sandbox_mode?.enable) meta.sandbox = true
  return {
    provider: name,
    providerId: `${id}.${i}`,
    from: formatAddress(from),
    replyTo: replyTo.map((a) => normalizeAddress(a.email)),
    recipients: list,
    subject: substitute(subject, p.substitutions) ?? '',
    text: substitute(text, p.substitutions),
    html: substitute(html, p.substitutions),
    headers: { ...stringHeaders(data.headers), ...stringHeaders(p.headers) },
    attachments: (data.attachments ?? []).map((a) =>
      attachmentFrom(a.filename, a.content, a.type, a.disposition === 'inline' ? a.content_id : null),
    ),
    raw,
    meta,
    idempotencyKey: null,
  }
}

const send: SendRoute = {
  kind: 'send',
  method: 'POST',
  path: '/v3/mail/send',
  parse(req) {
    if (!isRecord(req.body)) throw error(400, 'Bad Request', null)
    const result = sendSchema.safeParse(req.body)
    if (!result.success) {
      const field = result.error.issues[0]?.path.join('.') || null
      throw error(400, 'Invalid type.', field)
    }
    const data = result.data
    if (!data.personalizations?.length) {
      throw error(400, 'The personalizations field is required and must have at least one personalization.', 'personalizations')
    }
    const id = randomBytes(16).toString('base64url').slice(0, 22)
    return data.personalizations.map((p, i) => build(data, p, i, id, req.rawBody))
  },
  reply(messages) {
    const id = messages[0]?.providerId.split('.')[0] ?? ''
    return { status: 202, body: null, headers: { 'x-message-id': id } }
  },
}

export const sendgrid: Provider = {
  name,
  label: 'SendGrid',
  credential: bearer,
  unauthorized() {
    return {
      status: 401,
      body: { errors: [{ message: 'The provided authorization grant is invalid, expired, or revoked', field: null, help: null }] },
    }
  },
  routes: [send],
  setup: {
    env: "sgMail.client.setDefaultRequest('baseUrl', 'http://127.0.0.1:4400')",
    note: 'Call it after sgMail.setApiKey. Other SDKs: set the API host to http://127.0.0.1:4400.',
  },
}
