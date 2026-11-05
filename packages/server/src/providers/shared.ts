import type { Attachment, NewMessage, Recipient, RecipientKind } from '../types.js'
import { SendError, type IncomingRequest } from './types.js'

export function bearer(req: IncomingRequest): string | null {
  const header = req.headers.get('authorization') ?? ''
  const match = header.match(/^Bearer\s+(\S+)$/i)
  return match?.[1] ?? null
}

export function basic(req: IncomingRequest): { user: string; password: string } | null {
  const match = (req.headers.get('authorization') ?? '').match(/^Basic\s+(\S+)$/i)
  if (!match?.[1]) return null
  const decoded = Buffer.from(match[1], 'base64').toString('utf8')
  const colon = decoded.indexOf(':')
  return colon >= 0 && decoded.slice(colon + 1) ? { user: decoded.slice(0, colon), password: decoded.slice(colon + 1) } : null
}

export function header(req: IncomingRequest, name: string): string | null {
  const value = req.headers.get(name)
  return value && value.trim() ? value.trim() : null
}

export function normalizeAddress(address: string): string {
  return address.trim().toLowerCase()
}

const bareAddress = /^[^<>\s@]+@[^<>\s@]+$/

export function parseMailbox(value: string): { address: string; name: string | null } | null {
  const trimmed = value.trim()
  if (bareAddress.test(trimmed)) return { address: normalizeAddress(trimmed), name: null }
  const open = trimmed.lastIndexOf('<')
  if (open < 0 || !trimmed.endsWith('>')) return null
  const address = trimmed.slice(open + 1, -1)
  const name = trimmed.slice(0, open).trim().replace(/^"(.*)"$/, '$1').trim()
  if (!bareAddress.test(address) || /["<]/.test(name)) return null
  return { address: normalizeAddress(address), name: name || null }
}

export async function rejectedFor<T>(to: string[], work: () => T | Promise<T>): Promise<T> {
  try {
    return await work()
  } catch (err) {
    if (err instanceof SendError) throw new SendError(err.reply, [...new Set(to)], err.message)
    throw err
  }
}

export function keyPerItem(messages: NewMessage[]): NewMessage[] {
  return messages.map((m, i) => ({ ...m, idempotencyKey: m.idempotencyKey ? `${m.idempotencyKey}:${i}` : null }))
}

export function formatMailbox(address: string, name: string | null | undefined): string {
  return name ? `${name} <${normalizeAddress(address)}>` : normalizeAddress(address)
}

export function mailboxes(values: string[], kind: RecipientKind, invalid: (value: string) => Error): Recipient[] {
  return recipientsFrom(
    values.map((v) => {
      const mailbox = parseMailbox(v)
      if (!mailbox) throw invalid(v)
      return mailbox
    }),
    kind,
  )
}

export function looseAddress(value: string): string {
  return parseMailbox(value)?.address ?? normalizeAddress(value)
}

export function looseAddresses(value: string | null | undefined): string[] {
  return splitAddresses(value ?? '').map(looseAddress)
}

export function recipientsFrom(
  values: Array<{ address: string; name?: string | null | undefined }>,
  kind: RecipientKind,
): Recipient[] {
  return values.map((v) => ({ address: normalizeAddress(v.address), name: v.name?.trim() || null, kind }))
}

export function addressList(value: unknown): string[] {
  if (!value) return []
  const list = Array.isArray(value) ? value : [value]
  return list.flatMap((v) => (typeof v === 'string' ? [v] : [])).map((v) => v.trim()).filter(Boolean)
}

export function splitAddresses(value: string): string[] {
  const out: string[] = []
  let current = ''
  let quoted = false
  let angled = false
  for (const ch of value) {
    if (ch === '"') quoted = !quoted
    else if (ch === '<' && !quoted) angled = true
    else if (ch === '>' && !quoted) angled = false
    if (ch === ',' && !quoted && !angled) {
      out.push(current)
      current = ''
    } else {
      current += ch
    }
  }
  out.push(current)
  return out.map((v) => v.trim()).filter(Boolean)
}

export function toAddresses(recipients: Recipient[], kind: RecipientKind): string[] {
  return recipients.filter((r) => r.kind === kind).map((r) => r.address)
}

export function decodeBase64(content: string): Uint8Array {
  return new Uint8Array(Buffer.from(content, 'base64'))
}

export function attachmentFrom(
  filename: string | null | undefined,
  content: string | null | undefined,
  contentType: string | null | undefined,
  contentId?: string | null | undefined,
): Attachment {
  return {
    filename: filename?.trim() || 'attachment',
    contentType: contentType?.trim() || 'application/octet-stream',
    contentId: contentId?.trim() || null,
    content: content ? decodeBase64(content) : new Uint8Array(),
  }
}

export function stringHeaders(value: unknown): Record<string, string> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {}
  const out: Record<string, string> = {}
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') out[k] = String(v)
  }
  return out
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}

export function timestampId(): string {
  const now = new Date()
  const pad = (n: number, width = 2) => String(n).padStart(width, '0')
  return (
    `${now.getUTCFullYear()}${pad(now.getUTCMonth() + 1)}${pad(now.getUTCDate())}` +
    `${pad(now.getUTCHours())}${pad(now.getUTCMinutes())}${pad(now.getUTCSeconds())}` +
    `${pad(now.getUTCMilliseconds(), 3)}`
  )
}
