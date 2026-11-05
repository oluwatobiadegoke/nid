import { simpleParser, type AddressObject } from 'mailparser'
import { normalizeAddress } from '../providers/shared.js'
import type { Attachment, NewMessage, Recipient } from '../types.js'

function addresses(value: AddressObject | AddressObject[] | undefined): string[] {
  const list = Array.isArray(value) ? value : value ? [value] : []
  return list.flatMap((a) => a.value.map((v) => normalizeAddress(v.address ?? '')).filter(Boolean))
}

function formatFrom(value: AddressObject | undefined): string {
  const first = value?.value[0]
  if (!first?.address) return ''
  return first.name ? `${first.name} <${normalizeAddress(first.address)}>` : normalizeAddress(first.address)
}

export async function fromMime(raw: Buffer, rcptTo: string[], provider: string): Promise<NewMessage> {
  const parsed = await simpleParser(raw)
  const to = new Set(addresses(parsed.to))
  const cc = new Set(addresses(parsed.cc))
  const names = new Map<string, string>()
  for (const group of [parsed.to, parsed.cc].flat()) {
    for (const v of group?.value ?? []) if (v.address && v.name) names.set(normalizeAddress(v.address), v.name)
  }
  const recipients: Recipient[] = rcptTo.map((r) => {
    const address = normalizeAddress(r)
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
    provider,
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
    meta: {},
    idempotencyKey: null,
  }
}
