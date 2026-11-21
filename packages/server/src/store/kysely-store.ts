import { sql, type Kysely } from 'kysely'
import { Migrator } from 'kysely/migration'
import type {
  Attachment,
  AttachmentInfo,
  Extracted,
  Message,
  NewMessage,
  NewRejection,
  NewWebhookDelivery,
  Recipient,
  Rejection,
  WebhookDelivery,
} from '../types.js'
import { migrationProvider, type Database, type MessagesTable } from './schema.js'
import type { MessageQuery, RejectionQuery, Store } from './types.js'

type MessageRow = {
  [K in keyof MessagesTable]: MessagesTable[K] extends { __select__: infer S } ? S : MessagesTable[K]
}

const defaultLimit = 50
const maxLimit = 500

export class KyselyStore implements Store {
  readonly db: Kysely<Database>

  constructor(db: Kysely<Database>) {
    this.db = db
  }

  async migrate() {
    const migrator = new Migrator({ db: this.db, provider: migrationProvider })
    const { error } = await migrator.migrateToLatest()
    if (error) throw error
  }

  async cursor(projectId: string) {
    const row = await this.db
      .selectFrom('messages')
      .select(({ fn }) => fn.max('id').as('id'))
      .where('project_id', '=', projectId)
      .executeTakeFirst()
    return row?.id ?? 0
  }

  async insertMessage(
    projectId: string,
    message: NewMessage,
    extracted: Extracted,
    expiresAt: string | null,
  ): Promise<Message> {
    const createdAt = new Date().toISOString()
    const id = await this.db.transaction().execute(async (trx) => {
      const inserted = await trx
        .insertInto('messages')
        .values({
          project_id: projectId,
          provider: message.provider,
          provider_id: message.providerId,
          from_address: message.from,
          reply_to: JSON.stringify(message.replyTo),
          subject: message.subject,
          text: message.text,
          html: message.html,
          headers: JSON.stringify(message.headers),
          raw: message.raw,
          extracted: JSON.stringify(extracted),
          meta: JSON.stringify(message.meta),
          idempotency_key: message.idempotencyKey,
          has_code: extracted.code ? 1 : 0,
          created_at: createdAt,
          expires_at: expiresAt,
        })
        .executeTakeFirstOrThrow()
      const messageId = Number(inserted.insertId)
      if (message.recipients.length > 0) {
        await trx
          .insertInto('recipients')
          .values(
            message.recipients.map((r) => ({
              message_id: messageId,
              project_id: projectId,
              address: r.address,
              name: r.name,
              kind: r.kind,
            })),
          )
          .execute()
      }
      if (message.attachments.length > 0) {
        await trx
          .insertInto('attachments')
          .values(
            message.attachments.map((a, n) => ({
              message_id: messageId,
              project_id: projectId,
              n,
              filename: a.filename,
              content_type: a.contentType,
              content_id: a.contentId,
              size: a.content.byteLength,
              content: a.content,
            })),
          )
          .execute()
      }
      return messageId
    })
    const row = await this.db
      .selectFrom('messages')
      .selectAll()
      .where('project_id', '=', projectId)
      .where('id', '=', id)
      .executeTakeFirst()
    if (!row) throw new Error(`message ${id} vanished after insert`)
    const [stored] = await this.hydrate(projectId, [row])
    if (!stored) throw new Error(`message ${id} vanished after insert`)
    return stored
  }

  async getMessage(projectId: string, id: number) {
    const now = new Date().toISOString()
    const row = await this.db
      .selectFrom('messages')
      .selectAll()
      .where('project_id', '=', projectId)
      .where('id', '=', id)
      .where((eb) => eb.or([eb('expires_at', 'is', null), eb('expires_at', '>', now)]))
      .executeTakeFirst()
    if (!row) return null
    const [message] = await this.hydrate(projectId, [row])
    return message ?? null
  }

  async findByProviderId(projectId: string, provider: string, providerId: string) {
    const now = new Date().toISOString()
    const row = await this.db
      .selectFrom('messages')
      .selectAll()
      .where('project_id', '=', projectId)
      .where('provider', '=', provider)
      .where('provider_id', '=', providerId)
      .where((eb) => eb.or([eb('expires_at', 'is', null), eb('expires_at', '>', now)]))
      .orderBy('id')
      .executeTakeFirst()
    if (!row) return null
    const [message] = await this.hydrate(projectId, [row])
    return message ?? null
  }

  async findByIdempotencyKey(projectId: string, provider: string, key: string) {
    const now = new Date().toISOString()
    const row = await this.db
      .selectFrom('messages')
      .selectAll()
      .where('project_id', '=', projectId)
      .where('provider', '=', provider)
      .where('idempotency_key', '=', key)
      .where((eb) => eb.or([eb('expires_at', 'is', null), eb('expires_at', '>', now)]))
      .orderBy('id', 'desc')
      .executeTakeFirst()
    if (!row) return null
    const [message] = await this.hydrate(projectId, [row])
    return message ?? null
  }

  async listMessages(projectId: string, query: MessageQuery) {
    const now = new Date().toISOString()
    let q = this.db
      .selectFrom('messages')
      .selectAll('messages')
      .where('messages.project_id', '=', projectId)
      .where((eb) => eb.or([eb('messages.expires_at', 'is', null), eb('messages.expires_at', '>', now)]))
    if (query.to) {
      const address = query.to.trim().toLowerCase()
      q = q.where(({ exists, selectFrom }) =>
        exists(
          selectFrom('recipients')
            .select('recipients.message_id')
            .where('recipients.project_id', '=', projectId)
            .whereRef('recipients.message_id', '=', 'messages.id')
            .where('recipients.address', '=', address),
        ),
      )
    }
    if (query.subject) {
      const escaped = query.subject.toLowerCase().replace(/[\\%_]/g, '\\$&')
      q = q.where(sql<boolean>`lower(messages.subject) like ${'%' + escaped + '%'} escape '\\'`)
    }
    if (query.provider) q = q.where('messages.provider', '=', query.provider)
    if (query.after !== undefined) q = q.where('messages.id', '>', query.after)
    if (query.hasCode) q = q.where('messages.has_code', '=', 1)
    const limit = Math.min(query.limit ?? defaultLimit, maxLimit)
    const rows = await q.orderBy('messages.id', query.order ?? 'desc').limit(limit).execute()
    return this.hydrate(projectId, rows)
  }

  async getAttachment(projectId: string, messageId: number, n: number): Promise<Attachment | null> {
    const now = new Date().toISOString()
    const row = await this.db
      .selectFrom('attachments')
      .innerJoin('messages', 'messages.id', 'attachments.message_id')
      .select([
        'attachments.filename',
        'attachments.content_type',
        'attachments.content_id',
        'attachments.content',
      ])
      .where('attachments.project_id', '=', projectId)
      .where('attachments.message_id', '=', messageId)
      .where('attachments.n', '=', n)
      .where('messages.project_id', '=', projectId)
      .where((eb) => eb.or([eb('messages.expires_at', 'is', null), eb('messages.expires_at', '>', now)]))
      .executeTakeFirst()
    if (!row) return null
    return {
      filename: row.filename,
      contentType: row.content_type,
      contentId: row.content_id,
      content: row.content,
    }
  }

  async deleteMessage(projectId: string, id: number): Promise<boolean> {
    return this.db.transaction().execute(async (trx) => {
      await trx.deleteFrom('webhook_deliveries').where('project_id', '=', projectId).where('message_id', '=', id).execute()
      await trx.deleteFrom('attachments').where('project_id', '=', projectId).where('message_id', '=', id).execute()
      await trx.deleteFrom('recipients').where('project_id', '=', projectId).where('message_id', '=', id).execute()
      const deleted = await trx.deleteFrom('messages').where('project_id', '=', projectId).where('id', '=', id).executeTakeFirst()
      return Number(deleted.numDeletedRows) > 0
    })
  }

  async deleteMessages(projectId: string, to?: string) {
    const ids = to
      ? (
          await this.db
            .selectFrom('recipients')
            .select('message_id')
            .where('project_id', '=', projectId)
            .where('address', '=', to.trim().toLowerCase())
            .execute()
        ).map((r) => r.message_id)
      : (
          await this.db.selectFrom('messages').select('id').where('project_id', '=', projectId).execute()
        ).map((r) => r.id)
    const uniqueIds = [...new Set(ids)]
    if (uniqueIds.length === 0) return 0
    await this.db.transaction().execute(async (trx) => {
      await trx.deleteFrom('webhook_deliveries').where('project_id', '=', projectId).where('message_id', 'in', uniqueIds).execute()
      await trx.deleteFrom('attachments').where('project_id', '=', projectId).where('message_id', 'in', uniqueIds).execute()
      await trx.deleteFrom('recipients').where('project_id', '=', projectId).where('message_id', 'in', uniqueIds).execute()
      await trx.deleteFrom('messages').where('project_id', '=', projectId).where('id', 'in', uniqueIds).execute()
    })
    return uniqueIds.length
  }

  async insertRejection(projectId: string, rejection: NewRejection): Promise<Rejection> {
    const createdAt = new Date().toISOString()
    const to = rejection.to.map((a) => a.trim().toLowerCase())
    const addresses = [...new Set(to.filter(Boolean))]
    const id = await this.db.transaction().execute(async (trx) => {
      const inserted = await trx
        .insertInto('rejections')
        .values({
          project_id: projectId,
          provider: rejection.provider,
          to_addresses: JSON.stringify(to),
          status: rejection.status,
          error: rejection.error,
          raw: rejection.raw,
          created_at: createdAt,
        })
        .executeTakeFirstOrThrow()
      const rejectionId = Number(inserted.insertId)
      if (addresses.length > 0) {
        await trx
          .insertInto('rejection_recipients')
          .values(addresses.map((address) => ({ rejection_id: rejectionId, project_id: projectId, address })))
          .execute()
      }
      return rejectionId
    })
    return { ...rejection, to, id, projectId, createdAt }
  }

  async listRejections(projectId: string, query: RejectionQuery): Promise<Rejection[]> {
    let q = this.db.selectFrom('rejections').selectAll().where('project_id', '=', projectId)
    if (query.after !== undefined) q = q.where('id', '>', query.after)
    if (query.since) q = q.where('created_at', '>=', query.since)
    const address = query.to?.trim().toLowerCase()
    if (address) {
      q = q.where(({ exists, selectFrom }) =>
        exists(
          selectFrom('rejection_recipients')
            .select('rejection_recipients.rejection_id')
            .where('rejection_recipients.project_id', '=', projectId)
            .whereRef('rejection_recipients.rejection_id', '=', 'rejections.id')
            .where('rejection_recipients.address', '=', address),
        ),
      )
    }
    const limit = Math.min(query.limit ?? defaultLimit, maxLimit)
    const rows = await q.orderBy('id', query.order ?? 'desc').limit(limit).execute()
    return rows.map((row) => ({
      id: row.id,
      projectId: row.project_id,
      provider: row.provider,
      to: JSON.parse(row.to_addresses) as string[],
      status: row.status,
      error: row.error,
      raw: row.raw,
      createdAt: row.created_at,
    }))
  }

  async deleteRejections(projectId: string, to?: string): Promise<number> {
    const ids = to
      ? (
          await this.db
            .selectFrom('rejection_recipients')
            .select('rejection_id')
            .where('project_id', '=', projectId)
            .where('address', '=', to.trim().toLowerCase())
            .execute()
        ).map((r) => r.rejection_id)
      : (
          await this.db.selectFrom('rejections').select('id').where('project_id', '=', projectId).execute()
        ).map((r) => r.id)
    const uniqueIds = [...new Set(ids)]
    if (uniqueIds.length === 0) return 0
    await this.db.transaction().execute(async (trx) => {
      await trx.deleteFrom('rejection_recipients').where('project_id', '=', projectId).where('rejection_id', 'in', uniqueIds).execute()
      await trx.deleteFrom('rejections').where('project_id', '=', projectId).where('id', 'in', uniqueIds).execute()
    })
    return uniqueIds.length
  }

  async insertWebhookDelivery(projectId: string, delivery: NewWebhookDelivery): Promise<WebhookDelivery> {
    const createdAt = new Date().toISOString()
    const inserted = await this.db
      .insertInto('webhook_deliveries')
      .values({
        project_id: projectId,
        message_id: delivery.messageId,
        provider: delivery.provider,
        event: delivery.event,
        recipient: delivery.recipient,
        url: delivery.url,
        delivered: delivery.delivered ? 1 : 0,
        app_status: delivery.appStatus,
        app_body: delivery.appBody,
        duration_ms: delivery.durationMs,
        error: delivery.error,
        created_at: createdAt,
      })
      .executeTakeFirstOrThrow()
    return { ...delivery, id: Number(inserted.insertId), projectId, createdAt }
  }

  async listWebhookDeliveries(projectId: string, messageId: number): Promise<WebhookDelivery[]> {
    const rows = await this.db
      .selectFrom('webhook_deliveries')
      .selectAll()
      .where('project_id', '=', projectId)
      .where('message_id', '=', messageId)
      .orderBy('id', 'asc')
      .execute()
    return rows.map((row) => ({
      id: row.id,
      projectId: row.project_id,
      messageId: row.message_id,
      provider: row.provider,
      event: row.event,
      recipient: row.recipient,
      url: row.url,
      delivered: row.delivered === 1,
      appStatus: row.app_status,
      appBody: row.app_body,
      durationMs: row.duration_ms,
      error: row.error,
      createdAt: row.created_at,
    }))
  }

  async latestWebhookEvent(projectId: string, messageId: number): Promise<string | null> {
    const row = await this.db
      .selectFrom('webhook_deliveries')
      .select('event')
      .where('project_id', '=', projectId)
      .where('message_id', '=', messageId)
      .orderBy('id', 'desc')
      .limit(1)
      .executeTakeFirst()
    return row?.event ?? null
  }

  async deleteExpired(now: string) {
    const expired = await this.db
      .selectFrom('messages')
      .select(['id', 'project_id'])
      .where('expires_at', 'is not', null)
      .where('expires_at', '<=', now)
      .execute()
    if (expired.length === 0) return 0
    const byProject = new Map<string, number[]>()
    for (const row of expired) {
      const list = byProject.get(row.project_id) ?? []
      list.push(row.id)
      byProject.set(row.project_id, list)
    }
    await this.db.transaction().execute(async (trx) => {
      for (const [projectId, ids] of byProject) {
        await trx.deleteFrom('webhook_deliveries').where('project_id', '=', projectId).where('message_id', 'in', ids).execute()
        await trx.deleteFrom('attachments').where('project_id', '=', projectId).where('message_id', 'in', ids).execute()
        await trx.deleteFrom('recipients').where('project_id', '=', projectId).where('message_id', 'in', ids).execute()
        await trx.deleteFrom('messages').where('project_id', '=', projectId).where('id', 'in', ids).execute()
      }
    })
    return expired.length
  }

  async close() {
    await this.db.destroy()
  }

  private async hydrate(projectId: string, rows: MessageRow[]): Promise<Message[]> {
    if (rows.length === 0) return []
    const ids = rows.map((r) => r.id)
    const recipients = await this.db
      .selectFrom('recipients')
      .select(['message_id', 'address', 'name', 'kind'])
      .where('project_id', '=', projectId)
      .where('message_id', 'in', ids)
      .orderBy(sql`rowid`)
      .execute()
    const attachments = await this.db
      .selectFrom('attachments')
      .select(['message_id', 'n', 'filename', 'content_type', 'content_id', 'size'])
      .where('project_id', '=', projectId)
      .where('message_id', 'in', ids)
      .orderBy('n')
      .execute()
    const recipientsByMessage = new Map<number, Recipient[]>()
    for (const r of recipients) {
      const list = recipientsByMessage.get(r.message_id) ?? []
      list.push({ address: r.address, name: r.name, kind: r.kind as Recipient['kind'] })
      recipientsByMessage.set(r.message_id, list)
    }
    const attachmentsByMessage = new Map<number, AttachmentInfo[]>()
    for (const a of attachments) {
      const list = attachmentsByMessage.get(a.message_id) ?? []
      list.push({
        n: a.n,
        filename: a.filename,
        contentType: a.content_type,
        contentId: a.content_id,
        size: a.size,
      })
      attachmentsByMessage.set(a.message_id, list)
    }
    return rows.map((row) => ({
      id: row.id,
      projectId: row.project_id,
      provider: row.provider,
      providerId: row.provider_id,
      from: row.from_address,
      replyTo: JSON.parse(row.reply_to) as string[],
      recipients: recipientsByMessage.get(row.id) ?? [],
      subject: row.subject,
      text: row.text,
      html: row.html,
      headers: JSON.parse(row.headers) as Record<string, string>,
      attachments: attachmentsByMessage.get(row.id) ?? [],
      raw: row.raw,
      extracted: JSON.parse(row.extracted) as Extracted,
      meta: JSON.parse(row.meta) as Record<string, unknown>,
      idempotencyKey: row.idempotency_key,
      createdAt: row.created_at,
      expiresAt: row.expires_at,
    }))
  }
}
