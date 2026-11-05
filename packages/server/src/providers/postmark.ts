import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import type { Message, NewMessage, Recipient } from '../types.js'
import { attachmentFrom, header, isRecord, parseMailbox, recipientsFrom, splitAddresses } from './shared.js'
import { SendError, type IncomingRequest, type Provider, type SendRoute } from './types.js'

const name = 'postmark'

function error(code: number, message: string, to: string[] = []): SendError {
  return new SendError({ status: 422, body: { ErrorCode: code, Message: message } }, to, message)
}

const emailSchema = z
  .object({
    From: z.string().optional(),
    To: z.string().optional(),
    Cc: z.string().optional(),
    Bcc: z.string().optional(),
    Subject: z.string().optional(),
    Tag: z.string().optional(),
    HtmlBody: z.string().optional(),
    TextBody: z.string().optional(),
    ReplyTo: z.string().optional(),
    Headers: z.array(z.object({ Name: z.string(), Value: z.string() })).optional(),
    Metadata: z.record(z.string(), z.unknown()).optional(),
    Attachments: z
      .array(
        z.object({
          Name: z.string().optional(),
          Content: z.string().optional(),
          ContentType: z.string().optional(),
          ContentID: z.string().nullable().optional(),
        }),
      )
      .optional(),
    MessageStream: z.string().optional(),
    TemplateId: z.number().optional(),
    TemplateAlias: z.string().optional(),
    TemplateModel: z.record(z.string(), z.unknown()).optional(),
  })
  .passthrough()

function addresses(value: string | undefined, kind: Recipient['kind'], to: string[]): Recipient[] {
  const parsed = splitAddresses(value ?? '').map((v) => {
    const mailbox = parseMailbox(v)
    if (!mailbox) {
      throw error(300, `Error parsing '${kind[0]!.toUpperCase()}${kind.slice(1)}': Illegal email address '${v}'. It must contain the '@' symbol.`, to)
    }
    return mailbox
  })
  return recipientsFrom(parsed, kind)
}

function toMessage(body: unknown, templated: boolean, req: IncomingRequest, raw: string): NewMessage {
  if (!isRecord(body)) throw error(402, 'Received invalid JSON input.')
  const result = emailSchema.safeParse(body)
  if (!result.success) {
    const field = String(result.error.issues[0]?.path[0] ?? 'body')
    throw error(300, `Invalid '${field}' field.`)
  }
  const data = result.data
  const to = splitAddresses(data.To ?? '').map((v) => parseMailbox(v)?.address ?? v)
  if (to.length === 0) throw error(300, 'Zero recipients specified', to)
  if (!data.From || !parseMailbox(data.From)) {
    throw error(300, `Error parsing 'From': Illegal email address '${data.From ?? ''}'. It must contain the '@' symbol.`, to)
  }
  if (templated && data.TemplateId === undefined && !data.TemplateAlias) {
    throw error(1101, "The 'TemplateId' or 'TemplateAlias' must be specified.", to)
  }
  if (!templated && !data.HtmlBody && !data.TextBody) {
    throw error(300, 'Provide either email TextBody or HtmlBody or both.', to)
  }
  const recipients = [...addresses(data.To, 'to', to), ...addresses(data.Cc, 'cc', to), ...addresses(data.Bcc, 'bcc', to)]
  const meta: Record<string, unknown> = {}
  if (templated) {
    meta.templateId = data.TemplateId ?? data.TemplateAlias
    meta.variables = data.TemplateModel ?? {}
  }
  if (data.Tag) meta.tags = [data.Tag]
  if (data.Metadata) meta.metadata = data.Metadata
  if (data.MessageStream) meta.messageStream = data.MessageStream
  return {
    provider: name,
    providerId: randomUUID(),
    from: data.From,
    replyTo: splitAddresses(data.ReplyTo ?? '').map((v) => parseMailbox(v)?.address ?? v),
    recipients,
    subject: data.Subject ?? '',
    text: data.TextBody ?? null,
    html: data.HtmlBody ?? null,
    headers: Object.fromEntries((data.Headers ?? []).map((h) => [h.Name, h.Value])),
    attachments: (data.Attachments ?? []).map((a) =>
      attachmentFrom(a.Name, a.Content, a.ContentType, a.ContentID?.replace(/^cid:/i, '')),
    ),
    raw,
    meta,
    idempotencyKey: header(req, 'idempotency-key'),
  }
}

function receipt(m: Message) {
  return {
    To: m.recipients.filter((r) => r.kind === 'to').map((r) => r.address).join(', '),
    SubmittedAt: m.createdAt,
    MessageID: m.providerId,
    ErrorCode: 0,
    Message: 'OK',
  }
}

function batchItems(req: IncomingRequest, list: unknown, templated: boolean): NewMessage[] {
  if (!Array.isArray(list)) throw error(402, 'Received invalid JSON input.')
  if (list.length > 500) throw error(300, 'Batch requests are limited to 500 messages.')
  return list.map((item, i) => {
    const message = toMessage(item, templated, req, JSON.stringify(item))
    message.idempotencyKey = message.idempotencyKey ? `${message.idempotencyKey}:${i}` : null
    return message
  })
}

const single = (path: string, templated: boolean): SendRoute => ({
  kind: 'send',
  method: 'POST',
  path,
  parse: (req) => [toMessage(req.body, templated, req, req.rawBody)],
  reply: (messages) => ({ status: 200, body: receipt(messages[0]!) }),
})

const batch = (path: string, templated: boolean): SendRoute => ({
  kind: 'send',
  method: 'POST',
  path,
  parse: (req) => batchItems(req, templated && isRecord(req.body) ? req.body.Messages : req.body, templated),
  reply: (messages) => ({ status: 200, body: messages.map(receipt) }),
})

export const postmark: Provider = {
  name,
  label: 'Postmark',
  credential(req) {
    return header(req, 'x-postmark-server-token')
  },
  unauthorized() {
    return {
      status: 401,
      body: {
        ErrorCode: 10,
        Message:
          'No Account or Server API tokens were supplied in the HTTP headers. Please add a header for either X-Postmark-Server-Token or X-Postmark-Account-Token.',
      },
    }
  },
  routes: [
    single('/email', false),
    batch('/email/batch', false),
    single('/email/withTemplate', true),
    batch('/email/batchWithTemplates', true),
  ],
  setup: {
    env: "new postmark.ServerClient(token, { useHttps: false, requestHost: 'localhost:4400' })",
    note: 'requestHost takes a host and port, not a URL.',
  },
}
