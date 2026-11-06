import { createHmac, randomBytes } from 'node:crypto'
import type { Attachment, NewMessage, Recipient } from '../types.js'
import {
  basic,
  bounceReason,
  deferReason,
  isRecord,
  looseAddress,
  looseAddresses,
  mailboxes,
  parseMailbox,
  rejectedFor,
  senderAddress,
  splitAddresses,
  timestampId,
  webhookSecret,
} from './shared.js'
import { fromMime } from './mime.js'
import { SendError, type IncomingRequest, type Provider, type SendRoute, type WebhookEvent, type WebhookInput } from './types.js'

const name = 'mailgun'

type Field = string | File | Array<string | File>

function error(message: string): SendError {
  return new SendError({ status: 400, body: { message } }, [], message)
}

function values(body: Record<string, Field>, key: string): Array<string | File> {
  const value = body[key]
  if (value === undefined) return []
  return Array.isArray(value) ? value : [value]
}

function texts(body: Record<string, Field>, key: string): string[] {
  return values(body, key).filter((v): v is string => typeof v === 'string')
}

function text(body: Record<string, Field>, key: string): string | null {
  return texts(body, key)[0] || null
}

function addresses(body: Record<string, Field>, key: string): string[] {
  return texts(body, key).flatMap(splitAddresses)
}

function recipients(list: string[], kind: Recipient['kind']): Recipient[] {
  return mailboxes(list, kind, () => error(`${kind} parameter is not a valid address. please check documentation`))
}

function jsonObject(value: string | null, field: string): Record<string, unknown> | null {
  if (!value) return null
  try {
    const parsed: unknown = JSON.parse(value)
    if (isRecord(parsed)) return parsed
  } catch {}
  throw error(`${field} parameter should be a valid JSON`)
}

async function files(body: Record<string, Field>, key: string, inline: boolean): Promise<Attachment[]> {
  const list = values(body, key).filter((v): v is File => v instanceof File)
  return Promise.all(
    list.map(async (f) => ({
      filename: f.name || 'attachment',
      contentType: f.type || 'application/octet-stream',
      contentId: inline ? f.name || null : null,
      content: new Uint8Array(await f.arrayBuffer()),
    })),
  )
}

function substitute(value: string | null, vars: Record<string, unknown>): string | null {
  if (value === null) return null
  return value.replace(/%recipient\.([\w-]+)%/g, (whole, key: string) => (key in vars ? String(vars[key]) : whole))
}

function formBody(req: IncomingRequest): Record<string, Field> {
  if (!isRecord(req.body) || !/multipart\/form-data|x-www-form-urlencoded/.test(req.contentType)) {
    throw error('Expected multipart/form-data or application/x-www-form-urlencoded body')
  }
  return req.body as Record<string, Field>
}

function headerValue(headers: Record<string, string>, name: string): string | null {
  return Object.entries(headers).find(([k]) => k.toLowerCase() === name)?.[1] ?? null
}

function options(body: Record<string, Field>, domain: string) {
  const headers: Record<string, string> = {}
  const custom: Record<string, string> = {}
  for (const key of Object.keys(body)) {
    const value = text(body, key)
    if (value === null) continue
    if (key.startsWith('h:')) headers[key.slice(2)] = value
    else if (key.startsWith('v:')) custom[key.slice(2)] = value
  }
  const meta: Record<string, unknown> = { domain }
  const tags = texts(body, 'o:tag')
  if (tags.length > 0) meta.tags = tags
  if (Object.keys(custom).length > 0) meta.customVariables = custom
  const deliveryTime = text(body, 'o:deliverytime')
  if (deliveryTime) meta.scheduledAt = deliveryTime
  if (/^(yes|true)$/i.test(text(body, 'o:testmode') ?? '')) meta.sandbox = true
  const variables = jsonObject(headerValue(headers, 'x-mailgun-variables'), 'h:X-Mailgun-Variables')
  return { headers, meta, custom, variables }
}

function messageId(domain: string): string {
  return `<${timestampId()}.${randomBytes(8).toString('hex')}@${domain}>`
}

function substituteValues<T>(record: Record<string, T>, vars: Record<string, unknown>): Record<string, T> {
  return Object.fromEntries(Object.entries(record).map(([k, v]) => [k, typeof v === 'string' ? substitute(v, vars) : v])) as Record<string, T>
}

function substituteMeta(meta: Record<string, unknown>, vars: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = { ...meta, recipientVariables: vars }
  for (const key of ['variables', 'customVariables']) {
    if (isRecord(meta[key])) out[key] = substituteValues(meta[key], vars)
  }
  return out
}

type Build = (req: IncomingRequest, body: Record<string, Field>, toList: string[]) => Promise<NewMessage[]>

function formRoute(path: string, build: Build): SendRoute {
  return {
    kind: 'send',
    method: 'POST',
    path,
    parse(req) {
      const body = formBody(req)
      const toList = addresses(body, 'to')
      const everyone = [...toList, ...addresses(body, 'cc'), ...addresses(body, 'bcc')]
      return rejectedFor(everyone.map(looseAddress), () => {
        if (toList.length > 1000) throw error('Too many recipients. The maximum is 1000.')
        return build(req, body, toList)
      })
    },
    reply: (messages) => ({ status: 200, body: { id: messages[0]?.providerId, message: 'Queued. Thank you.' } }),
  }
}

async function buildSend(req: IncomingRequest, body: Record<string, Field>, toList: string[]): Promise<NewMessage[]> {
  const from = text(body, 'from')
  if (!from) throw error("'from' parameter is missing")
  if (!parseMailbox(from)) throw error('from parameter is not a valid address. please check documentation')
  if (toList.length === 0) throw error("'to' parameter is missing")
  const template = text(body, 'template')
  const html = text(body, 'html')
  const plain = text(body, 'text')
  if (!html && !plain && !template) throw error("Need at least one of 'text', 'html' or 'template' parameters specified")

  const domain = req.params.domain ?? ''
  const { headers, meta, custom, variables } = options(body, domain)
  const providerId = messageId(domain)
  const templateVariables = jsonObject(text(body, 't:variables'), 't:variables')
  if (template) {
    meta.templateId = template
    meta.variables = { ...custom, ...variables, ...templateVariables }
  }
  const perRecipient = jsonObject(text(body, 'recipient-variables'), 'recipient-variables')
  const cc = recipients(addresses(body, 'cc'), 'cc')
  const bcc = recipients(addresses(body, 'bcc'), 'bcc')
  const attachments = [...(await files(body, 'attachment', false)), ...(await files(body, 'inline', true))]
  const replyTo = looseAddresses(headerValue(headers, 'reply-to'))

  const message = (toRecipients: Recipient[], vars: Record<string, unknown>): NewMessage => ({
    provider: name,
    providerId,
    from,
    replyTo,
    recipients: [...toRecipients, ...cc, ...bcc],
    subject: substitute(text(body, 'subject'), vars) ?? '',
    text: substitute(plain, vars),
    html: substitute(html, vars),
    headers: substituteValues(headers, vars),
    attachments,
    raw: req.rawBody,
    meta: Object.keys(vars).length > 0 ? substituteMeta(meta, vars) : meta,
    idempotencyKey: null,
  })

  const toRecipients = recipients(toList, 'to')
  if (!perRecipient) return [message(toRecipients, {})]
  const byAddress = new Map(Object.entries(perRecipient).map(([k, v]) => [k.toLowerCase(), v]))
  return toRecipients.map((r) => {
    const vars = byAddress.get(r.address)
    return message([r], isRecord(vars) ? vars : {})
  })
}

async function buildMime(req: IncomingRequest, body: Record<string, Field>, toList: string[]): Promise<NewMessage[]> {
  if (toList.length === 0) throw error("'to' parameter is missing")
  const to = recipients(toList, 'to').map((r) => r.address)
  const raw = values(body, 'message')[0]
  if (raw === undefined) throw error("'message' parameter is missing")
  const content = typeof raw === 'string' ? Buffer.from(raw) : Buffer.from(await raw.arrayBuffer())
  const message = await fromMime(content, to, name)
  const domain = req.params.domain ?? ''
  const { headers, meta, variables } = options(body, domain)
  if (variables) meta.variables = variables
  return [{ ...message, providerId: messageId(domain), headers: { ...message.headers, ...headers }, meta }]
}

const webhookTypes: Record<WebhookEvent, string> = {
  delivered: 'delivered',
  deferred: 'failed',
  bounced: 'failed',
  complained: 'complained',
  opened: 'opened',
  clicked: 'clicked',
}

function webhook({ message: m, event, recipient, secret, now }: WebhookInput) {
  const key = webhookSecret(secret, name, 'Mailgun')
  const timestamp = String(Math.floor(now.getTime() / 1000))
  const token = randomBytes(25).toString('hex')
  const data: Record<string, unknown> = {
    id: randomBytes(11).toString('base64url'),
    timestamp: now.getTime() / 1000,
    event: webhookTypes[event],
    recipient,
    'recipient-domain': recipient.split('@')[1] ?? '',
    tags: (m.meta.tags as string[] | undefined) ?? [],
    'user-variables': (m.meta.customVariables as Record<string, unknown> | undefined) ?? {},
    envelope: { sender: senderAddress(m.from), targets: recipient, transport: 'smtp' },
    message: { headers: { 'message-id': m.providerId.replace(/^<|>$/g, ''), from: m.from, to: recipient, subject: m.subject } },
  }
  if (event === 'delivered') data['delivery-status'] = { code: 250, message: 'OK', description: '' }
  if (event === 'bounced') {
    Object.assign(data, { severity: 'permanent', reason: 'bounce', 'delivery-status': { code: 550, message: bounceReason, description: '' } })
  }
  if (event === 'deferred') {
    Object.assign(data, { severity: 'temporary', reason: 'generic', 'delivery-status': { code: 421, message: deferReason, description: '' } })
  }
  if (event === 'clicked') data.url = m.extracted.link ?? ''
  const signature = createHmac('sha256', key).update(timestamp + token).digest('hex')
  return { body: JSON.stringify({ signature: { timestamp, token, signature }, 'event-data': data }), headers: {} }
}

export const mailgun: Provider = {
  name,
  label: 'Mailgun',
  credential(req) {
    const auth = basic(req)
    return auth?.user === 'api' ? auth.password : null
  },
  unauthorized() {
    return { status: 401, body: 'Forbidden' }
  },
  routes: [formRoute('/v3/:domain/messages', buildSend), formRoute('/v3/:domain/messages.mime', buildMime)],
  setup: {
    env: "mailgun.client({ username: 'api', key, url: 'http://127.0.0.1:4400' })",
    note: 'Other SDKs: set the API base URL to http://127.0.0.1:4400 (no /v3).',
  },
  webhook,
}
