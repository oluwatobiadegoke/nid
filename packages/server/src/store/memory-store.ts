import type {
  Attachment,
  Extracted,
  Message,
  NewMessage,
  NewRejection,
  NewWebhookDelivery,
  Rejection,
  WebhookDelivery,
} from '../types.js'
import type { MessageQuery, RejectionQuery, Store } from './types.js'

export interface MemoryStoreOptions {
  maxMessages?: number
  maxRejections?: number
}

interface StoredEntry {
  message: Message
  attachments: Attachment[]
}

interface ProjectBucket {
  messages: Map<number, StoredEntry>
  byRecipient: Map<string, Set<number>>
  byProviderId: Map<string, number>
  byIdempotencyKey: Map<string, number>
  rejections: Rejection[]
  webhooks: Map<number, WebhookDelivery[]>
}

const defaultLimit = 50
const maxLimit = 500
const defaultMaxMessages = 5000
const defaultMaxRejections = 1000

function isExpired(expiresAt: string | null, nowIso: string): boolean {
  return expiresAt !== null && expiresAt <= nowIso
}

function compositeKey(provider: string, value: string): string {
  return `${provider}\0${value}`
}

export class MemoryStore implements Store {
  readonly #buckets = new Map<string, ProjectBucket>()
  readonly #maxMessages: number
  readonly #maxRejections: number
  #nextMessageId = 0
  #nextRejectionId = 0
  #nextWebhookId = 0

  constructor(options: MemoryStoreOptions = {}) {
    this.#maxMessages = options.maxMessages ?? defaultMaxMessages
    this.#maxRejections = options.maxRejections ?? defaultMaxRejections
  }

  async migrate() {}

  async cursor(projectId: string): Promise<number> {
    const bucket = this.#buckets.get(projectId)
    if (!bucket || bucket.messages.size === 0) return 0
    let max = 0
    for (const id of bucket.messages.keys()) max = id
    return max
  }

  async insertMessage(
    projectId: string,
    message: NewMessage,
    extracted: Extracted,
    expiresAt: string | null,
  ): Promise<Message> {
    const bucket = this.#bucket(projectId)
    const id = ++this.#nextMessageId
    const stored: Message = {
      id,
      projectId,
      provider: message.provider,
      providerId: message.providerId,
      from: message.from,
      replyTo: [...message.replyTo],
      recipients: message.recipients.map((r) => ({ ...r })),
      subject: message.subject,
      text: message.text,
      html: message.html,
      headers: { ...message.headers },
      attachments: message.attachments.map((a, n) => ({
        n,
        filename: a.filename,
        contentType: a.contentType,
        contentId: a.contentId,
        size: a.content.byteLength,
      })),
      raw: message.raw,
      extracted,
      meta: { ...message.meta },
      idempotencyKey: message.idempotencyKey,
      createdAt: new Date().toISOString(),
      expiresAt,
    }
    bucket.messages.set(id, { message: stored, attachments: message.attachments })
    for (const r of message.recipients) {
      const address = r.address.trim().toLowerCase()
      let ids = bucket.byRecipient.get(address)
      if (!ids) {
        ids = new Set()
        bucket.byRecipient.set(address, ids)
      }
      ids.add(id)
    }
    bucket.byProviderId.set(compositeKey(message.provider, message.providerId), id)
    if (message.idempotencyKey) {
      bucket.byIdempotencyKey.set(compositeKey(message.provider, message.idempotencyKey), id)
    }
    while (bucket.messages.size > this.#maxMessages) {
      const oldest = bucket.messages.keys().next().value
      if (oldest === undefined) break
      this.#removeMessage(bucket, oldest)
    }
    return stored
  }

  async getMessage(projectId: string, id: number): Promise<Message | null> {
    const bucket = this.#buckets.get(projectId)
    if (!bucket) return null
    const entry = bucket.messages.get(id)
    if (!entry || isExpired(entry.message.expiresAt, new Date().toISOString())) return null
    return entry.message
  }

  async findByProviderId(projectId: string, provider: string, providerId: string): Promise<Message | null> {
    const bucket = this.#buckets.get(projectId)
    if (!bucket) return null
    const id = bucket.byProviderId.get(compositeKey(provider, providerId))
    if (id === undefined) return null
    return this.getMessage(projectId, id)
  }

  async findByIdempotencyKey(projectId: string, provider: string, key: string): Promise<Message | null> {
    const bucket = this.#buckets.get(projectId)
    if (!bucket) return null
    const id = bucket.byIdempotencyKey.get(compositeKey(provider, key))
    if (id === undefined) return null
    return this.getMessage(projectId, id)
  }

  async listMessages(projectId: string, query: MessageQuery): Promise<Message[]> {
    const bucket = this.#buckets.get(projectId)
    if (!bucket) return []
    const nowIso = new Date().toISOString()
    const limit = Math.min(query.limit ?? defaultLimit, maxLimit)
    const subjectNeedle = query.subject?.toLowerCase()
    const matches = (m: Message): boolean => {
      if (isExpired(m.expiresAt, nowIso)) return false
      if (query.provider && m.provider !== query.provider) return false
      if (query.after !== undefined && m.id <= query.after) return false
      if (query.hasCode && !m.extracted.code) return false
      if (subjectNeedle && !m.subject.toLowerCase().includes(subjectNeedle)) return false
      return true
    }

    if (query.to) {
      const ids = bucket.byRecipient.get(query.to.trim().toLowerCase())
      if (!ids || ids.size === 0) return []
      const list = [...ids]
      if (query.order !== 'asc') list.reverse()
      const out: Message[] = []
      for (const id of list) {
        const entry = bucket.messages.get(id)
        if (!entry || !matches(entry.message)) continue
        out.push(entry.message)
        if (out.length >= limit) break
      }
      return out
    }

    if (query.order === 'asc') {
      const out: Message[] = []
      for (const entry of bucket.messages.values()) {
        if (!matches(entry.message)) continue
        out.push(entry.message)
        if (out.length >= limit) break
      }
      return out
    }

    const entries = [...bucket.messages.values()]
    const out: Message[] = []
    for (let i = entries.length - 1; i >= 0; i--) {
      const entry = entries[i]!
      if (!matches(entry.message)) continue
      out.push(entry.message)
      if (out.length >= limit) break
    }
    return out
  }

  async getAttachment(projectId: string, messageId: number, n: number): Promise<Attachment | null> {
    const bucket = this.#buckets.get(projectId)
    if (!bucket) return null
    const entry = bucket.messages.get(messageId)
    if (!entry || isExpired(entry.message.expiresAt, new Date().toISOString())) return null
    return entry.attachments[n] ?? null
  }

  async deleteMessage(projectId: string, id: number): Promise<boolean> {
    const bucket = this.#buckets.get(projectId)
    if (!bucket || !bucket.messages.has(id)) return false
    this.#removeMessage(bucket, id)
    return true
  }

  async deleteMessages(projectId: string, to?: string): Promise<number> {
    const bucket = this.#buckets.get(projectId)
    if (!bucket) return 0
    if (!to) {
      const count = bucket.messages.size
      bucket.messages.clear()
      bucket.byRecipient.clear()
      bucket.byProviderId.clear()
      bucket.byIdempotencyKey.clear()
      bucket.webhooks.clear()
      return count
    }
    const address = to.trim().toLowerCase()
    const ids = bucket.byRecipient.get(address)
    if (!ids || ids.size === 0) return 0
    const targets = [...ids]
    for (const id of targets) this.#removeMessage(bucket, id)
    return targets.length
  }

  async insertRejection(projectId: string, rejection: NewRejection): Promise<Rejection> {
    const bucket = this.#bucket(projectId)
    const id = ++this.#nextRejectionId
    const stored: Rejection = {
      ...rejection,
      to: [...rejection.to],
      id,
      projectId,
      createdAt: new Date().toISOString(),
    }
    bucket.rejections.push(stored)
    if (bucket.rejections.length > this.#maxRejections) {
      bucket.rejections.splice(0, bucket.rejections.length - this.#maxRejections)
    }
    return stored
  }

  async listRejections(projectId: string, query: RejectionQuery): Promise<Rejection[]> {
    const bucket = this.#buckets.get(projectId)
    if (!bucket || bucket.rejections.length === 0) return []
    const address = query.to?.trim().toLowerCase()
    const limit = Math.min(query.limit ?? defaultLimit, maxLimit)
    const out: Rejection[] = []
    if (query.order === 'asc') {
      for (const r of bucket.rejections) {
        if (query.after !== undefined && r.id <= query.after) continue
        if (query.since && r.createdAt < query.since) continue
        if (address && !r.to.some((a) => a.toLowerCase() === address)) continue
        out.push(r)
        if (out.length >= limit) break
      }
      return out
    }
    for (let i = bucket.rejections.length - 1; i >= 0; i--) {
      const r = bucket.rejections[i]!
      if (query.after !== undefined && r.id <= query.after) continue
      if (query.since && r.createdAt < query.since) continue
      if (address && !r.to.some((a) => a.toLowerCase() === address)) continue
      out.push(r)
      if (out.length >= limit) break
    }
    return out
  }

  async deleteRejections(projectId: string, to?: string): Promise<number> {
    const bucket = this.#buckets.get(projectId)
    if (!bucket || bucket.rejections.length === 0) return 0
    if (!to) {
      const count = bucket.rejections.length
      bucket.rejections = []
      return count
    }
    const address = to.trim().toLowerCase()
    const before = bucket.rejections.length
    bucket.rejections = bucket.rejections.filter((r) => !r.to.some((a) => a.toLowerCase() === address))
    return before - bucket.rejections.length
  }

  async insertWebhookDelivery(projectId: string, delivery: NewWebhookDelivery): Promise<WebhookDelivery> {
    const bucket = this.#bucket(projectId)
    const id = ++this.#nextWebhookId
    const stored: WebhookDelivery = {
      ...delivery,
      id,
      projectId,
      createdAt: new Date().toISOString(),
    }
    const list = bucket.webhooks.get(delivery.messageId) ?? []
    list.push(stored)
    bucket.webhooks.set(delivery.messageId, list)
    return stored
  }

  async listWebhookDeliveries(projectId: string, messageId: number): Promise<WebhookDelivery[]> {
    const bucket = this.#buckets.get(projectId)
    if (!bucket) return []
    return [...(bucket.webhooks.get(messageId) ?? [])]
  }

  async latestWebhookEvent(projectId: string, messageId: number): Promise<string | null> {
    const bucket = this.#buckets.get(projectId)
    const list = bucket?.webhooks.get(messageId)
    if (!list || list.length === 0) return null
    return list[list.length - 1]!.event
  }

  async deleteExpired(now: string): Promise<number> {
    let deleted = 0
    for (const bucket of this.#buckets.values()) {
      const expiredIds: number[] = []
      for (const [id, entry] of bucket.messages) {
        if (isExpired(entry.message.expiresAt, now)) expiredIds.push(id)
      }
      for (const id of expiredIds) {
        this.#removeMessage(bucket, id)
        deleted++
      }
    }
    return deleted
  }

  async close() {}

  #bucket(projectId: string): ProjectBucket {
    let bucket = this.#buckets.get(projectId)
    if (!bucket) {
      bucket = {
        messages: new Map(),
        byRecipient: new Map(),
        byProviderId: new Map(),
        byIdempotencyKey: new Map(),
        rejections: [],
        webhooks: new Map(),
      }
      this.#buckets.set(projectId, bucket)
    }
    return bucket
  }

  #removeMessage(bucket: ProjectBucket, id: number) {
    const entry = bucket.messages.get(id)
    if (!entry) return
    bucket.messages.delete(id)
    for (const r of entry.message.recipients) {
      const address = r.address.trim().toLowerCase()
      const ids = bucket.byRecipient.get(address)
      if (!ids) continue
      ids.delete(id)
      if (ids.size === 0) bucket.byRecipient.delete(address)
    }
    const pidKey = compositeKey(entry.message.provider, entry.message.providerId)
    if (bucket.byProviderId.get(pidKey) === id) bucket.byProviderId.delete(pidKey)
    if (entry.message.idempotencyKey) {
      const idemKey = compositeKey(entry.message.provider, entry.message.idempotencyKey)
      if (bucket.byIdempotencyKey.get(idemKey) === id) bucket.byIdempotencyKey.delete(idemKey)
    }
    bucket.webhooks.delete(id)
  }
}

export function createMemoryStore(options: MemoryStoreOptions = {}): MemoryStore {
  return new MemoryStore(options)
}
