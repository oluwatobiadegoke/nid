import type { Message, Rejection } from '../types.js'
import { toAddresses } from '../providers/shared.js'

export function serializeMessage(m: Message, options: { raw?: boolean } = {}) {
  const base = {
    id: m.id,
    provider: m.provider,
    providerId: m.providerId,
    from: m.from,
    replyTo: m.replyTo,
    to: toAddresses(m.recipients, 'to'),
    cc: toAddresses(m.recipients, 'cc'),
    bcc: toAddresses(m.recipients, 'bcc'),
    recipients: m.recipients,
    subject: m.subject,
    text: m.text,
    html: m.html,
    headers: m.headers,
    attachments: m.attachments.map((a) => ({ ...a, url: `/api/messages/${m.id}/attachments/${a.n}` })),
    extracted: m.extracted,
    meta: m.meta,
    createdAt: m.createdAt,
    expiresAt: m.expiresAt,
  }
  return options.raw ? { ...base, raw: m.raw } : base
}

export function serializeRejection(r: Rejection, options: { raw?: boolean } = {}) {
  const base = {
    id: r.id,
    provider: r.provider,
    to: r.to,
    status: r.status,
    error: r.error,
    createdAt: r.createdAt,
  }
  return options.raw ? { ...base, raw: r.raw } : base
}

export type SerializedMessage = ReturnType<typeof serializeMessage>
export type SerializedRejection = ReturnType<typeof serializeRejection>
