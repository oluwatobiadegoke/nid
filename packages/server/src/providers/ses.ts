import { randomBytes, randomUUID } from 'node:crypto'
import { z } from 'zod'
import type { Message, NewMessage, Recipient } from '../types.js'
import { fromMime } from './mime.js'
import {
  bounceReason,
  deferReason,
  attachmentFrom,
  isRecord,
  looseAddress,
  mailboxes,
  normalizeAddress,
  parseMailbox,
  rejectedFor,
  senderAddress,
  toAddresses,
} from './shared.js'
import { SendError, type IncomingRequest, type Provider, type SendRoute, type WebhookEvent, type WebhookInput } from './types.js'

const name = 'ses'
const xmlNs = 'http://ses.amazonaws.com/doc/2010-12-01/'

function error(type: 'BadRequestException' | 'MessageRejected', message: string, to: string[] = []): SendError {
  return new SendError({ status: 400, headers: { 'x-amzn-errortype': type }, body: { message } }, to, message)
}

function escapeXml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;')
}

function xmlError(code: string, message: string, to: string[] = []): SendError {
  const body = `<ErrorResponse xmlns="${xmlNs}"><Error><Type>Sender</Type><Code>${escapeXml(code)}</Code><Message>${escapeXml(message)}</Message></Error><RequestId>${randomUUID()}</RequestId></ErrorResponse>`
  return new SendError(
    { status: 400, headers: { 'content-type': 'text/xml; charset=utf-8', 'x-amzn-errortype': code }, body },
    to,
    message,
  )
}

function messageId(): string {
  return `010001${randomBytes(5).toString('hex')}-${randomUUID()}-000000`
}

const destinationSchema = z.object({
  ToAddresses: z.array(z.string()).optional(),
  CcAddresses: z.array(z.string()).optional(),
  BccAddresses: z.array(z.string()).optional(),
})

const headerItemSchema = z.object({ Name: z.string(), Value: z.string() })
const tagItemSchema = z.object({ Name: z.string(), Value: z.string() })
const textPartSchema = z.object({ Data: z.string().optional(), Charset: z.string().optional() })

const sendV2Schema = z
  .object({
    FromEmailAddress: z.string().optional(),
    Destination: destinationSchema.optional(),
    ReplyToAddresses: z.array(z.string()).optional(),
    ConfigurationSetName: z.string().optional(),
    EmailTags: z.array(tagItemSchema).optional(),
    Content: z
      .object({
        Simple: z
          .object({
            Subject: textPartSchema.optional(),
            Body: z.object({ Text: textPartSchema.optional(), Html: textPartSchema.optional() }).optional(),
            Headers: z.array(headerItemSchema).optional(),
            Attachments: z
              .array(
                z.object({
                  FileName: z.string(),
                  RawContent: z.string(),
                  ContentType: z.string().optional(),
                  ContentId: z.string().optional(),
                }),
              )
              .optional(),
          })
          .optional(),
        Raw: z.object({ Data: z.union([z.string(), z.array(z.number())]).optional() }).optional(),
        Template: z
          .object({
            TemplateName: z.string().optional(),
            TemplateArn: z.string().optional(),
            TemplateData: z.string().optional(),
            Headers: z.array(headerItemSchema).optional(),
          })
          .optional(),
      })
      .optional(),
  })
  .passthrough()

const bulkV2Schema = z
  .object({
    FromEmailAddress: z.string().optional(),
    ReplyToAddresses: z.array(z.string()).optional(),
    ConfigurationSetName: z.string().optional(),
    DefaultEmailTags: z.array(tagItemSchema).optional(),
    DefaultContent: z
      .object({
        Template: z
          .object({
            TemplateName: z.string().optional(),
            TemplateArn: z.string().optional(),
            TemplateData: z.string().optional(),
            Headers: z.array(headerItemSchema).optional(),
          })
          .optional(),
      })
      .optional(),
    BulkEmailEntries: z
      .array(
        z.object({
          Destination: destinationSchema.optional(),
          ReplacementTags: z.array(tagItemSchema).optional(),
          ReplacementEmailContent: z
            .object({
              ReplacementTemplate: z
                .object({
                  ReplacementTemplateData: z.string().optional(),
                })
                .optional(),
            })
            .optional(),
          ReplacementHeaders: z.array(headerItemSchema).optional(),
        }),
      )
      .optional(),
  })
  .passthrough()

function destinationAddresses(dest: z.infer<typeof destinationSchema> | undefined): string[] {
  if (!isRecord(dest)) return []
  return [dest.ToAddresses, dest.CcAddresses, dest.BccAddresses]
    .flatMap((list) => (Array.isArray(list) ? list : []))
    .filter((value) => typeof value === 'string')
    .map(looseAddress)
}

function parseDestination(dest: z.infer<typeof destinationSchema> | undefined): Recipient[] {
  const invalid = (v: string) => error('MessageRejected', `Invalid email address: ${v}`)
  const to = mailboxes(dest?.ToAddresses ?? [], 'to', invalid)
  const cc = mailboxes(dest?.CcAddresses ?? [], 'cc', invalid)
  const bcc = mailboxes(dest?.BccAddresses ?? [], 'bcc', invalid)
  return [...to, ...cc, ...bcc]
}

function parseTemplateData(raw: string | undefined): Record<string, unknown> {
  if (!raw) return {}
  try {
    const parsed: unknown = JSON.parse(raw)
    if (isRecord(parsed)) return parsed
  } catch {}
  throw error('BadRequestException', 'TemplateData must be a valid JSON object.')
}

function headersFrom(items: Array<{ Name: string; Value: string }> | undefined): Record<string, string> {
  return Object.fromEntries((items ?? []).map((h) => [h.Name, h.Value]))
}

function validateFrom(from: string | undefined): string {
  if (!from) throw error('BadRequestException', 'Missing FromEmailAddress.')
  if (!parseMailbox(from)) throw error('MessageRejected', `Invalid FromEmailAddress: ${from}`)
  return from
}

function validateReplyTo(values: string[] | undefined): string[] {
  return (values ?? []).map((v) => {
    const parsed = parseMailbox(v)
    if (!parsed) throw error('MessageRejected', `Invalid ReplyToAddresses entry: ${v}`)
    return parsed.address
  })
}

async function parseV2Message(body: unknown, raw: string): Promise<NewMessage> {
  if (!isRecord(body)) throw error('BadRequestException', 'Invalid request body.')
  const parsed = sendV2Schema.safeParse(body)
  if (!parsed.success) throw error('BadRequestException', 'Invalid request body.')
  const data = parsed.data
  const content = data.Content
  if (!content || (!content.Simple && !content.Raw && !content.Template)) {
    throw error('BadRequestException', 'Content must specify Simple, Raw, or Template.')
  }

  const meta: Record<string, unknown> = {}
  if (data.EmailTags && data.EmailTags.length > 0) {
    meta.tags = data.EmailTags.map((t) => ({ name: t.Name, value: t.Value }))
  }
  if (data.ConfigurationSetName) meta.configurationSet = data.ConfigurationSetName

  if (content.Raw) {
    if (!content.Raw.Data) throw error('BadRequestException', 'Content.Raw.Data is required.')
    const buf =
      typeof content.Raw.Data === 'string'
        ? Buffer.from(content.Raw.Data, 'base64')
        : Buffer.from(content.Raw.Data)
    const recipients = parseDestination(data.Destination)
    const mime = await fromMime(buf, recipients.map((r) => r.address), name)
    const from = data.FromEmailAddress ? validateFrom(data.FromEmailAddress) : mime.from
    if (!from) throw error('BadRequestException', 'Missing FromEmailAddress.')
    if (mime.recipients.length === 0) throw error('BadRequestException', 'Missing recipients.')
    return {
      ...mime,
      recipients: mime.recipients.map((r, i) => ({ ...r, kind: recipients[i]?.kind ?? r.kind })),
      providerId: messageId(),
      from,
      replyTo: data.ReplyToAddresses?.length ? validateReplyTo(data.ReplyToAddresses) : mime.replyTo,
      raw,
      meta: { ...mime.meta, ...meta },
    }
  }

  const from = validateFrom(data.FromEmailAddress)
  const recipients = parseDestination(data.Destination)
  if (recipients.length === 0) throw error('BadRequestException', 'Destination must include at least one recipient.')
  const replyTo = validateReplyTo(data.ReplyToAddresses)

  if (content.Template) {
    const templateId = content.Template.TemplateName ?? content.Template.TemplateArn
    if (!templateId) throw error('BadRequestException', 'TemplateName or TemplateArn is required.')
    meta.templateId = templateId
    meta.variables = parseTemplateData(content.Template.TemplateData)
    return {
      provider: name,
      providerId: messageId(),
      from,
      replyTo,
      recipients,
      subject: '',
      text: null,
      html: null,
      headers: headersFrom(content.Template.Headers),
      attachments: [],
      raw,
      meta,
      idempotencyKey: null,
    }
  }

  const simple = content.Simple!
  const subject = simple.Subject?.Data ?? ''
  const text = simple.Body?.Text?.Data ?? null
  const html = simple.Body?.Html?.Data ?? null
  if (!subject) throw error('BadRequestException', 'Content.Simple.Subject.Data is required.')
  if (!text && !html) throw error('BadRequestException', 'Content.Simple.Body requires Text or Html.')
  return {
    provider: name,
    providerId: messageId(),
    from,
    replyTo,
    recipients,
    subject,
    text,
    html,
    headers: headersFrom(simple.Headers),
    attachments: (simple.Attachments ?? []).map((a) => attachmentFrom(a.FileName, a.RawContent, a.ContentType, a.ContentId)),
    raw,
    meta,
    idempotencyKey: null,
  }
}

const sendV2: SendRoute = {
  kind: 'send',
  method: 'POST',
  path: '/v2/email/outbound-emails',
  parse(req) {
    const dest = isRecord(req.body) && isRecord(req.body.Destination) ? (req.body.Destination as z.infer<typeof destinationSchema>) : undefined
    return rejectedFor(destinationAddresses(dest), async () => [await parseV2Message(req.body, req.rawBody)])
  },
  reply(messages) {
    return { status: 200, body: { MessageId: messages[0]?.providerId } }
  },
}

const bulkV2: SendRoute = {
  kind: 'send',
  method: 'POST',
  path: '/v2/email/outbound-bulk-emails',
  parse(req) {
    const body = req.body
    if (!isRecord(body)) throw error('BadRequestException', 'Invalid request body.')
    const rawEntries = Array.isArray(body.BulkEmailEntries) ? body.BulkEmailEntries : []
    const allTo = rawEntries.flatMap((entry) =>
      isRecord(entry) && isRecord(entry.Destination)
        ? destinationAddresses(entry.Destination as z.infer<typeof destinationSchema>)
        : [],
    )
    return rejectedFor(allTo, () => {
      const parsed = bulkV2Schema.safeParse(body)
      if (!parsed.success) throw error('BadRequestException', 'Invalid request body.')
      const data = parsed.data
      const from = validateFrom(data.FromEmailAddress)
      const replyTo = validateReplyTo(data.ReplyToAddresses)
      const tpl = data.DefaultContent?.Template
      const templateId = tpl?.TemplateName ?? tpl?.TemplateArn
      if (!templateId) throw error('BadRequestException', 'DefaultContent.Template.TemplateName or TemplateArn is required.')
      const entries = data.BulkEmailEntries ?? []
      if (entries.length === 0) throw error('BadRequestException', 'BulkEmailEntries must contain at least one entry.')
      if (entries.length > 50) throw error('BadRequestException', 'BulkEmailEntries is limited to 50 entries.')
      const defaultVars = parseTemplateData(tpl?.TemplateData)
      const defaultTags = data.DefaultEmailTags ?? []
      const baseHeaders = headersFrom(tpl?.Headers)
      return entries.map((entry) => {
        const entryTo = destinationAddresses(entry.Destination)
        try {
          const recipients = parseDestination(entry.Destination)
          if (recipients.length === 0) throw error('BadRequestException', 'Destination must include at least one recipient.', entryTo)
          const entryVars = parseTemplateData(entry.ReplacementEmailContent?.ReplacementTemplate?.ReplacementTemplateData)
          const mergedTags = [...defaultTags, ...(entry.ReplacementTags ?? [])]
          const meta: Record<string, unknown> = {
            templateId,
            variables: { ...defaultVars, ...entryVars },
          }
          if (mergedTags.length > 0) meta.tags = mergedTags.map((t) => ({ name: t.Name, value: t.Value }))
          if (data.ConfigurationSetName) meta.configurationSet = data.ConfigurationSetName
          return {
            provider: name,
            providerId: messageId(),
            from,
            replyTo,
            recipients,
            subject: '',
            text: null,
            html: null,
            headers: { ...baseHeaders, ...headersFrom(entry.ReplacementHeaders) },
            attachments: [],
            raw: JSON.stringify(entry),
            meta,
            idempotencyKey: null,
          }
        } catch (err) {
          if (err instanceof SendError) return new SendError(err.reply, entryTo, err.message)
          throw err
        }
      })
    })
  },
  reply(_messages, outcomes) {
    return {
      status: 200,
      body: {
        BulkEmailEntryResults: outcomes.map((o) =>
          o instanceof SendError
            ? { Status: 'MESSAGE_REJECTED', Error: o.message }
            : { Status: 'SUCCESS', MessageId: o.providerId },
        ),
      },
    }
  },
}

function formField(body: Record<string, unknown>, key: string): string | undefined {
  const value = body[key]
  if (typeof value === 'string') return value
  if (Array.isArray(value) && typeof value[0] === 'string') return value[0]
  return undefined
}

function memberList(body: Record<string, unknown>, prefix: string): string[] {
  const pattern = new RegExp(`^${prefix.replace(/\./g, '\\.')}\\.member\\.(\\d+)$`)
  const entries: Array<[number, string]> = []
  for (const [k, v] of Object.entries(body)) {
    const match = k.match(pattern)
    if (!match) continue
    const val = typeof v === 'string' ? v : Array.isArray(v) && typeof v[0] === 'string' ? v[0] : undefined
    if (val !== undefined) entries.push([Number(match[1]), val])
  }
  entries.sort((a, b) => a[0] - b[0])
  return entries.map(([, v]) => v)
}

function memberTags(body: Record<string, unknown>, prefix: string): Array<{ name: string; value: string }> {
  const pattern = new RegExp(`^${prefix.replace(/\./g, '\\.')}\\.member\\.(\\d+)\\.(Name|Value)$`)
  const map = new Map<number, { name?: string; value?: string }>()
  for (const [k, v] of Object.entries(body)) {
    const match = k.match(pattern)
    if (!match) continue
    const idx = Number(match[1])
    const val = typeof v === 'string' ? v : undefined
    if (val === undefined) continue
    const item = map.get(idx) ?? {}
    if (match[2] === 'Name') item.name = val
    else item.value = val
    map.set(idx, item)
  }
  return [...map.entries()]
    .sort((a, b) => a[0] - b[0])
    .flatMap(([, t]) => (t.name ? [{ name: t.name, value: t.value ?? '' }] : []))
}

const sendV1: SendRoute = {
  kind: 'send',
  method: 'POST',
  path: '/',
  async parse(req) {
    if (!isRecord(req.body) || !req.contentType.includes('application/x-www-form-urlencoded')) {
      throw xmlError('InvalidAction', 'Expected application/x-www-form-urlencoded SES v1 request.')
    }
    const body = req.body
    const action = formField(body, 'Action')
    if (action === 'SendRawEmail') {
      const destinations = memberList(body, 'Destinations')
      return rejectedFor(destinations.map(looseAddress), async () => {
        const rawData = formField(body, 'RawMessage.Data')
        if (!rawData) throw xmlError('MissingParameter', 'RawMessage.Data is required.')
        const invalid = (v: string) => xmlError('InvalidParameterValue', `Invalid email address: ${v}`)
        const rcpt = mailboxes(destinations, 'to', invalid).map((r) => r.address)
        const mime = await fromMime(Buffer.from(rawData, 'base64'), rcpt, name)
        const source = formField(body, 'Source')
        if (source && !parseMailbox(source)) throw xmlError('InvalidParameterValue', `Invalid Source: ${source}`)
        const from = source || mime.from
        if (!from) throw xmlError('MissingParameter', 'Source is required.')
        if (mime.recipients.length === 0) throw xmlError('MissingParameter', 'At least one recipient is required.')
        const tags = memberTags(body, 'Tags')
        const configSet = formField(body, 'ConfigurationSetName')
        const meta: Record<string, unknown> = { ...mime.meta, sesAction: 'SendRawEmail' }
        if (tags.length > 0) meta.tags = tags
        if (configSet) meta.configurationSet = configSet
        return [{ ...mime, providerId: messageId(), from, raw: req.rawBody, meta }]
      })
    }
    if (action !== 'SendEmail') {
      throw xmlError('InvalidAction', `Unsupported SES Action: ${action ?? ''}`)
    }
    const toList = memberList(body, 'Destination.ToAddresses')
    const ccList = memberList(body, 'Destination.CcAddresses')
    const bccList = memberList(body, 'Destination.BccAddresses')
    const everyone = [...toList, ...ccList, ...bccList].map(looseAddress)
    return rejectedFor(everyone, () => {
      const source = formField(body, 'Source')
      if (!source) throw xmlError('MissingParameter', 'Source is required.')
      if (!parseMailbox(source)) throw xmlError('InvalidParameterValue', `Invalid Source: ${source}`)
      const invalid = (v: string) => xmlError('InvalidParameterValue', `Invalid email address: ${v}`)
      const recipients = [
        ...mailboxes(toList, 'to', invalid),
        ...mailboxes(ccList, 'cc', invalid),
        ...mailboxes(bccList, 'bcc', invalid),
      ]
      if (recipients.length === 0) throw xmlError('MissingParameter', 'Destination must include at least one recipient.')
      const replyTo = mailboxes(memberList(body, 'ReplyToAddresses'), 'to', invalid).map((r) => r.address)
      const subject = formField(body, 'Message.Subject.Data')
      const text = formField(body, 'Message.Body.Text.Data') ?? null
      const html = formField(body, 'Message.Body.Html.Data') ?? null
      if (!subject) throw xmlError('MissingParameter', 'Message.Subject.Data is required.')
      if (!text && !html) throw xmlError('MissingParameter', 'Message.Body requires Text.Data or Html.Data.')
      const tags = memberTags(body, 'Tags')
      const configSet = formField(body, 'ConfigurationSetName')
      const meta: Record<string, unknown> = { sesAction: 'SendEmail' }
      if (tags.length > 0) meta.tags = tags
      if (configSet) meta.configurationSet = configSet
      return [
        {
          provider: name,
          providerId: messageId(),
          from: source,
          replyTo,
          recipients,
          subject,
          text,
          html,
          headers: {},
          attachments: [],
          raw: req.rawBody,
          meta,
          idempotencyKey: null,
        },
      ]
    })
  },
  reply(messages) {
    const m = messages[0]!
    const action = m.meta.sesAction === 'SendRawEmail' ? 'SendRawEmail' : 'SendEmail'
    const body = `<${action}Response xmlns="${xmlNs}"><${action}Result><MessageId>${escapeXml(m.providerId)}</MessageId></${action}Result><ResponseMetadata><RequestId>${randomUUID()}</RequestId></ResponseMetadata></${action}Response>`
    return { status: 200, headers: { 'content-type': 'text/xml; charset=utf-8' }, body }
  },
}

const webhookTypes: Record<WebhookEvent, string> = {
  delivered: 'Delivery',
  deferred: 'DeliveryDelay',
  bounced: 'Bounce',
  complained: 'Complaint',
  opened: 'Open',
  clicked: 'Click',
}

function webhook({ message: m, event, recipient, secret, now, url, reason }: WebhookInput) {
  const at = now.toISOString()
  const rawTags = (m.meta.tags as Array<{ name: string; value: string }> | undefined) ?? []
  const tags = Object.fromEntries(rawTags.map((t) => [t.name, [t.value]]))
  const payload: Record<string, unknown> = {
    eventType: webhookTypes[event],
    mail: {
      timestamp: m.createdAt,
      messageId: m.providerId,
      source: senderAddress(m.from),
      destination: [recipient],
      headersTruncated: false,
      commonHeaders: {
        from: m.from ? [m.from] : [],
        to: toAddresses(m.recipients, 'to'),
        subject: m.subject,
      },
      tags,
    },
  }
  if (event === 'delivered') {
    payload.delivery = {
      timestamp: at,
      processingTimeMillis: 12,
      recipients: [recipient],
      smtpResponse: '250 2.0.0 OK',
    }
  } else if (event === 'deferred') {
    payload.deliveryDelay = {
      timestamp: at,
      delayType: 'TransientCommunicationFailure',
      expirationTime: at,
      delayedRecipients: [{ emailAddress: recipient, status: '4.7.0', diagnosticCode: reason ?? deferReason }],
    }
  } else if (event === 'bounced') {
    payload.bounce = {
      bounceType: 'Permanent',
      bounceSubType: 'General',
      bouncedRecipients: [{ emailAddress: recipient, action: 'failed', status: '5.1.1', diagnosticCode: reason ?? bounceReason }],
      timestamp: at,
      feedbackId: randomUUID(),
    }
  } else if (event === 'complained') {
    payload.complaint = {
      complainedRecipients: [{ emailAddress: recipient }],
      timestamp: at,
      feedbackId: randomUUID(),
      complaintFeedbackType: 'abuse',
    }
  } else if (event === 'opened') {
    payload.open = { timestamp: at, userAgent: 'nid', ipAddress: '127.0.0.1' }
  } else if (event === 'clicked') {
    payload.click = { timestamp: at, userAgent: 'nid', ipAddress: '127.0.0.1', link: url ?? m.extracted.link ?? '', linkTags: {} }
  }
  return {
    body: JSON.stringify(payload),
    headers: secret ? { authorization: `Bearer ${secret}` } : {},
  }
}

export const ses: Provider = {
  name,
  label: 'Amazon SES',
  credential(req: IncomingRequest) {
    const auth = req.headers.get('authorization') ?? ''
    if (!auth.startsWith('AWS4-HMAC-SHA256 ')) return null
    const match = auth.match(/\bCredential=([^/,\s]+)\//)
    return match?.[1] ?? null
  },
  unauthorized() {
    return {
      status: 403,
      headers: { 'x-amzn-errortype': 'MissingAuthenticationTokenException' },
      body: { message: 'Missing Authentication Token' },
    }
  },
  routes: [sendV2, bulkV2, sendV1],
  setup: {
    env: 'AWS_ENDPOINT_URL_SESV2=http://127.0.0.1:4400',
    note: 'AWS SDK v3 SESv2Client reads AWS_ENDPOINT_URL_SESV2. Legacy SES v1 clients read AWS_ENDPOINT_URL_SES.',
  },
  webhook,
}
