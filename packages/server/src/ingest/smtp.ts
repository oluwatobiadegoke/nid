import type { AddressInfo } from 'node:net'
import { simpleParser, type AddressObject } from 'mailparser'
import { SMTPServer, type SMTPServerSession } from 'smtp-server'
import type { Attachment, NewMessage, Project, Recipient } from '../types.js'
import { normalizeAddress } from '../providers/shared.js'
import type { Ingest } from './types.js'

export interface SmtpOptions {
  ingest: Ingest
  maxBodyBytes: number
  onError?: ((err: Error) => void) | undefined
}

function addresses(value: AddressObject | AddressObject[] | undefined): string[] {
  const list = Array.isArray(value) ? value : value ? [value] : []
  return list.flatMap((a) => a.value.map((v) => normalizeAddress(v.address ?? '')).filter(Boolean))
}

function formatFrom(value: AddressObject | undefined): string {
  const first = value?.value[0]
  if (!first?.address) return ''
  return first.name ? `${first.name} <${normalizeAddress(first.address)}>` : normalizeAddress(first.address)
}

async function toMessage(raw: Buffer, session: SMTPServerSession): Promise<NewMessage> {
  const parsed = await simpleParser(raw)
  const to = new Set(addresses(parsed.to))
  const cc = new Set(addresses(parsed.cc))
  const names = new Map<string, string>()
  for (const group of [parsed.to, parsed.cc].flat()) {
    for (const v of group?.value ?? []) if (v.address && v.name) names.set(normalizeAddress(v.address), v.name)
  }
  const recipients: Recipient[] = session.envelope.rcptTo.map((r) => {
    const address = normalizeAddress(r.address)
    const kind: Recipient['kind'] = to.has(address) ? 'to' : cc.has(address) ? 'cc' : 'bcc'
    return { address, name: names.get(address) ?? null, kind }
  })
  const headers: Record<string, string> = {}
  for (const [key, value] of parsed.headers) {
    if (typeof value === 'string') headers[key] = value
    else if (value && typeof value === 'object' && 'text' in value && typeof value.text === 'string') headers[key] = value.text
  }
  const attachments: Attachment[] = parsed.attachments.map((a) => ({
    filename: a.filename ?? 'attachment',
    contentType: a.contentType,
    contentId: a.contentId ?? null,
    content: new Uint8Array(a.content),
  }))
  return {
    provider: 'smtp',
    providerId: parsed.messageId ?? `<${Date.now()}.${Math.random().toString(16).slice(2)}@nid.local>`,
    from: formatFrom(parsed.from),
    replyTo: addresses(parsed.replyTo),
    recipients,
    subject: parsed.subject ?? '',
    text: parsed.text ?? null,
    html: typeof parsed.html === 'string' ? parsed.html : null,
    headers,
    attachments,
    raw: raw.toString('utf8'),
    meta: { envelope: { from: session.envelope.mailFrom ? session.envelope.mailFrom.address : null, to: session.envelope.rcptTo.map((r) => r.address) } },
    idempotencyKey: null,
  }
}

export function createSmtpServer(options: SmtpOptions): SMTPServer {
  const projects = new WeakMap<SMTPServerSession, Project>()
  const server = new SMTPServer({
    authOptional: true,
    disabledCommands: ['STARTTLS'],
    size: options.maxBodyBytes,
    disableReverseLookup: true,
    onAuth(auth, session, callback) {
      options.ingest
        .resolveProject({ kind: 'smtp', provider: 'smtp', value: auth.username ?? '' })
        .then((project) => {
          if (!project) return callback(new Error('Invalid username or password'))
          projects.set(session, project)
          callback(null, { user: project.projectId })
        })
        .catch((err: Error) => callback(err))
    },
    onData(stream, session, callback) {
      const chunks: Buffer[] = []
      stream.on('data', (chunk: Buffer) => chunks.push(chunk))
      stream.on('end', () => {
        if (stream.sizeExceeded) {
          const err = Object.assign(new Error('Message exceeds the size limit'), { responseCode: 552 })
          return callback(err)
        }
        const raw = Buffer.concat(chunks)
        const resolve = projects.get(session)
          ? Promise.resolve(projects.get(session) as Project)
          : options.ingest.resolveProject({ kind: 'smtp', provider: 'smtp', value: '' })
        resolve
          .then(async (project) => {
            if (!project) throw Object.assign(new Error('Authentication required'), { responseCode: 530 })
            const message = await toMessage(raw, session)
            await options.ingest.accept(project, message)
            callback()
          })
          .catch((err: Error) => {
            options.onError?.(err)
            callback(err)
          })
      })
    },
  })
  server.on('error', (err) => options.onError?.(err))
  return server
}

export function listenSmtp(server: SMTPServer, port: number, host: string): Promise<number> {
  return new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(port, host, () => {
      server.off('error', reject)
      resolve((server.server.address() as AddressInfo).port)
    })
  })
}
