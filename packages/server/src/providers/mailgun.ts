import { randomBytes } from 'node:crypto'
import type { Attachment, Message, NewMessage, Recipient } from '../types.js'
import { basic, isRecord, looseAddresses, mailboxes, parseMailbox, splitAddresses, timestampId } from './shared.js'
import { fromMime } from './mime.js'
import { SendError, type IncomingRequest, type Provider, type SendRoute } from './types.js'

const name = 'mailgun'

type Field = string | File | Array<string | File>

function error(status: number, message: string, to: string[] = []): SendError {
  return new SendError({ status, body: { message } }, to, message)
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

function recipients(list: string[], kind: Recipient['kind'], to: string[]): Recipient[] {
  return mailboxes(list, kind, () => error(400, `${kind} parameter is not a valid address. please check documentation`, to))
}

function jsonObject(value: string | null, field: string, to: string[]): Record<string, unknown> | null {
  if (!value) return null
  try {
    const parsed: unknown = JSON.parse(value)
    if (isRecord(parsed)) return parsed
  } catch {}
  throw error(400, `${field} parameter should be a valid JSON`, to)
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
    throw error(400, 'Expected multipart/form-data or application/x-www-form-urlencoded body')
  }
  return req.body as Record<string, Field>
}

function headerValue(headers: Record<string, string>, name: string): string | null {
  return Object.entries(headers).find(([k]) => k.toLowerCase() === name)?.[1] ?? null
}

function options(body: Record<string, Field>, domain: string, to: string[]) {
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
  const variables = jsonObject(headerValue(headers, 'x-mailgun-variables'), 'h:X-Mailgun-Variables', to)
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

const send: SendRoute = {
  kind: 'send',
  method: 'POST',
  path: '/v3/:domain/messages',
  async parse(req) {
    const body = formBody(req)
    const toList = addresses(body, 'to')
    const to = toList.map((v) => parseMailbox(v)?.address ?? v)
    const from = text(body, 'from')
    if (!from) throw error(400, "'from' parameter is missing", to)
    if (!parseMailbox(from)) throw error(400, 'from parameter is not a valid address. please check documentation', to)
    if (to.length === 0) throw error(400, "'to' parameter is missing", to)
    const template = text(body, 'template')
    const html = text(body, 'html')
    const plain = text(body, 'text')
    if (!html && !plain && !template) throw error(400, "Need at least one of 'text', 'html' or 'template' parameters specified", to)

    const domain = req.params.domain ?? ''
    const { headers, meta, custom, variables } = options(body, domain, to)
    const providerId = messageId(domain)
    const templateVariables = jsonObject(text(body, 't:variables'), 't:variables', to)
    if (template) {
      meta.templateId = template
      meta.variables = { ...custom, ...variables, ...templateVariables }
    }
    const perRecipient = jsonObject(text(body, 'recipient-variables'), 'recipient-variables', to)
    const cc = recipients(addresses(body, 'cc'), 'cc', to)
    const bcc = recipients(addresses(body, 'bcc'), 'bcc', to)
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

    const toRecipients = recipients(toList, 'to', to)
    if (!perRecipient) return [message(toRecipients, {})]
    return toRecipients.map((r) => {
      const vars = Object.entries(perRecipient).find(([k]) => k.toLowerCase() === r.address)?.[1]
      return message([r], isRecord(vars) ? vars : {})
    })
  },
  reply,
}

const mime: SendRoute = {
  kind: 'send',
  method: 'POST',
  path: '/v3/:domain/messages.mime',
  async parse(req) {
    const body = formBody(req)
    const toList = addresses(body, 'to')
    const to = toList.map((v) => parseMailbox(v)?.address ?? v)
    if (to.length === 0) throw error(400, "'to' parameter is missing", to)
    recipients(toList, 'to', to)
    const raw = values(body, 'message')[0]
    if (raw === undefined) throw error(400, "'message' parameter is missing", to)
    const content = typeof raw === 'string' ? Buffer.from(raw) : Buffer.from(await raw.arrayBuffer())
    const message = await fromMime(content, to, name)
    const domain = req.params.domain ?? ''
    const { headers, meta, variables } = options(body, domain, to)
    if (variables) meta.variables = variables
    return [{ ...message, providerId: messageId(domain), headers: { ...message.headers, ...headers }, meta }]
  },
  reply,
}

function reply(messages: Message[]) {
  return { status: 200, body: { id: messages[0]?.providerId, message: 'Queued. Thank you.' } }
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
  routes: [send, mime],
  setup: {
    env: "mailgun.client({ username: 'api', key, url: 'http://127.0.0.1:4400' })",
    note: 'Other SDKs: set the API base URL to http://127.0.0.1:4400 (no /v3).',
  },
}
