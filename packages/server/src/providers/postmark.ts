import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import type { Message, NewMessage, Recipient } from '../types.js'
import { attachmentFrom, header, isRecord, looseAddresses, mailboxes, parseMailbox, splitAddresses, toAddresses } from './shared.js'
import { SendError, type Provider, type SendRoute } from './types.js'

const name = 'postmark'

function error(code: number, message: string, to: string[] = []): SendError {
  return new SendError({ status: 422, body: { ErrorCode: code, Message: message } }, to, message)
}

const emailSchema = z
  .object({
    From: z.string().nullish(),
    To: z.string().nullish(),
    Cc: z.string().nullish(),
    Bcc: z.string().nullish(),
    Subject: z.string().nullish(),
    Tag: z.string().nullish(),
    HtmlBody: z.string().nullish(),
    TextBody: z.string().nullish(),
    ReplyTo: z.string().nullish(),
    Headers: z.array(z.object({ Name: z.string(), Value: z.string() })).nullish(),
    Metadata: z.record(z.string(), z.unknown()).nullish(),
    Attachments: z
      .array(
        z.object({
          Name: z.string().nullish(),
          Content: z.string().nullish(),
          ContentType: z.string().nullish(),
          ContentID: z.string().nullish(),
        }),
      )
      .nullish(),
    MessageStream: z.string().nullish(),
    TemplateId: z.number().nullish(),
    TemplateAlias: z.string().nullish(),
    TemplateModel: z.record(z.string(), z.unknown()).nullish(),
  })
  .passthrough()

function addresses(value: string | null | undefined, kind: Recipient['kind'], field: string, to: string[]): Recipient[] {
  return mailboxes(splitAddresses(value ?? ''), kind, (v) =>
    error(300, `Error parsing '${field}': Illegal email address '${v}'. It must contain the '@' symbol.`, to),
  )
}

function toMessage(body: unknown, templated: boolean, raw: string): NewMessage {
  if (!isRecord(body)) throw error(402, 'Received invalid JSON input.')
  const to = rawTo(body)
  const result = emailSchema.safeParse(body)
  if (!result.success) throw error(300, `Invalid '${String(result.error.issues[0]?.path[0] ?? 'body')}' field.`, to)
  const data = result.data
  if (to.length === 0) throw error(300, 'Zero recipients specified', to)
  if (!data.From || !parseMailbox(data.From)) {
    throw error(300, `Error parsing 'From': Illegal email address '${data.From ?? ''}'. It must contain the '@' symbol.`, to)
  }
  if (templated && data.TemplateId == null && !data.TemplateAlias) {
    throw error(1101, "The 'TemplateId' or 'TemplateAlias' must be specified.", to)
  }
  if (!templated && !data.HtmlBody && !data.TextBody) {
    throw error(300, 'Provide either email TextBody or HtmlBody or both.', to)
  }
  const recipients = [
    ...addresses(data.To, 'to', 'To', to),
    ...addresses(data.Cc, 'cc', 'Cc', to),
    ...addresses(data.Bcc, 'bcc', 'Bcc', to),
  ]
  const replyTo = addresses(data.ReplyTo, 'to', 'ReplyTo', to).map((r) => r.address)
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
    replyTo,
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
    idempotencyKey: null,
  }
}

function receipt(m: Message) {
  const to = toAddresses(m.recipients, 'to')
  return {
    ...(to.length > 0 ? { To: to.join(', ') } : {}),
    SubmittedAt: m.createdAt,
    MessageID: m.providerId,
    ErrorCode: 0,
    Message: 'OK',
  }
}

function rawTo(body: unknown): string[] {
  return isRecord(body) ? [body.To, body.Cc, body.Bcc].flatMap((v) => (typeof v === 'string' ? looseAddresses(v) : [])) : []
}

function batchItems(list: unknown, templated: boolean): Array<NewMessage | SendError> {
  if (!Array.isArray(list)) throw error(402, 'Received invalid JSON input.')
  if (list.length > 500) throw error(300, 'Batch requests are limited to 500 messages.', list.flatMap(rawTo))
  return list.map((item) => {
    try {
      return toMessage(item, templated, JSON.stringify(item))
    } catch (err) {
      if (err instanceof SendError) return err
      throw err
    }
  })
}

const single = (path: string, templated: boolean): SendRoute => ({
  kind: 'send',
  method: 'POST',
  path,
  parse: (req) => [toMessage(req.body, templated, req.rawBody)],
  reply: (messages) => ({ status: 200, body: receipt(messages[0]!) }),
})

const batch = (path: string, templated: boolean): SendRoute => ({
  kind: 'send',
  method: 'POST',
  path,
  parse: (req) => batchItems(templated ? (isRecord(req.body) ? req.body.Messages : undefined) : req.body, templated),
  reply: (_messages, outcomes) => ({
    status: 200,
    body: outcomes.map((o) => (o instanceof SendError ? o.reply.body : receipt(o))),
  }),
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
    env: "new postmark.ServerClient(token, { useHttps: false, requestHost: '127.0.0.1:4400' })",
    note: 'requestHost takes a host and port, not a URL.',
  },
}
