import { sql, type Kysely } from 'kysely'
import { Migrator } from 'kysely/migration'
import type {
  Attachment,
  AttachmentInfo,
  Extracted,
  Message,
  NewMessage,
  NewRejection,
  Recipient,
  Rejection,
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
    const stored = await this.getMessage(projectId, id)
    if (!stored) throw new Error(`message ${id} vanished after insert`)
    return stored
  }

  async getMessage(projectId: string, id: number) {
    const row = await this.db
      .selectFrom('messages')
      .selectAll()
      .where('project_id', '=', projectId)
      .where('id', '=', id)
      .executeTakeFirst()
    if (!row) return null
    const [message] = await this.hydrate([row])
    return message ?? null
  }

  async findByProviderId(projectId: string, provider: string, providerId: string) {
    const row = await this.db
      .selectFrom('messages')
      .selectAll()
      .where('project_id', '=', projectId)
      .where('provider', '=', provider)
      .where('provider_id', '=', providerId)
      .executeTakeFirst()
    if (!row) return null
    const [message] = await this.hydrate([row])
    return message ?? null
  }

  async findByIdempotencyKey(projectId: string, provider: string, key: string) {
    const row = await this.db
      .selectFrom('messages')
      .selectAll()
      .where('project_id', '=', projectId)
      .where('provider', '=', provider)
      .where('idempotency_key', '=', key)
      .orderBy('id', 'desc')
      .executeTakeFirst()
    if (!row) return null
    const [message] = await this.hydrate([row])
    return message ?? null
  }

  async listMessages(projectId: string, query: MessageQuery) {
    let q = this.db.selectFrom('messages').selectAll('messages').where('messages.project_id', '=', projectId)
    if (query.to) {
      const address = query.to.trim().toLowerCase()
      q = q.where(({ exists, selectFrom }) =>
        exists(
          selectFrom('recipients')
            .select('recipients.message_id')
            .whereRef('recipients.message_id', '=', 'messages.id')
            .where('recipients.address', '=', address),
        ),
      )
    }
    if (query.subject) {
      q = q.where(sql<boolean>`lower(messages.subject) like ${'%' + query.subject.toLowerCase() + '%'}`)
    }
    if (query.provider) q = q.where('messages.provider', '=', query.provider)
    if (query.after !== undefined) q = q.where('messages.id', '>', query.after)
    if (query.hasCode) q = q.where('messages.has_code', '=', 1)
    const limit = Math.min(query.limit ?? defaultLimit, maxLimit)
    const rows = await q.orderBy('messages.id', query.order ?? 'desc').limit(limit).execute()
    return this.hydrate(rows)
  }

  async getAttachment(projectId: string, messageId: number, n: number): Promise<Attachment | null> {
    const row = await this.db
      .selectFrom('attachments')
      .selectAll()
      .where('project_id', '=', projectId)
      .where('message_id', '=', messageId)
      .where('n', '=', n)
      .executeTakeFirst()
    if (!row) return null
    return {
      filename: row.filename,
      contentType: row.content_type,
      contentId: row.content_id,
      content: row.content,
    }
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
    if (ids.length === 0) return 0
    await this.db.transaction().execute(async (trx) => {
      await trx.deleteFrom('attachments').where('message_id', 'in', ids).execute()
      await trx.deleteFrom('recipients').where('message_id', 'in', ids).execute()
      await trx.deleteFrom('messages').where('id', 'in', ids).execute()
    })
    return ids.length
  }

  async insertRejection(projectId: string, rejection: NewRejection): Promise<Rejection> {
    const createdAt = new Date().toISOString()
    const inserted = await this.db
      .insertInto('rejections')
      .values({
        project_id: projectId,
        provider: rejection.provider,
        to_addresses: JSON.stringify(rejection.to.map((a) => a.toLowerCase())),
        status: rejection.status,
        error: rejection.error,
        raw: rejection.raw,
        created_at: createdAt,
      })
      .executeTakeFirstOrThrow()
    return { ...rejection, id: Number(inserted.insertId), projectId, createdAt }
  }

  async listRejections(projectId: string, query: RejectionQuery): Promise<Rejection[]> {
    let q = this.db.selectFrom('rejections').selectAll().where('project_id', '=', projectId)
    if (query.after !== undefined) q = q.where('id', '>', query.after)
    if (query.since) q = q.where('created_at', '>=', query.since)
    const address = query.to?.trim().toLowerCase()
    if (address) {
      q = q.where(sql<boolean>`exists (select 1 from json_each(rejections.to_addresses) where lower(value) = ${address})`)
    }
    const limit = Math.min(query.limit ?? defaultLimit, maxLimit)
    const rows = await q.orderBy('id', 'desc').limit(limit).execute()
    return rows
      .map((row) => ({
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

  async deleteExpired(now: string) {
    const ids = (
      await this.db
        .selectFrom('messages')
        .select('id')
        .where('expires_at', 'is not', null)
        .where('expires_at', '<=', now)
        .execute()
    ).map((r) => r.id)
    if (ids.length === 0) return 0
    await this.db.transaction().execute(async (trx) => {
      await trx.deleteFrom('attachments').where('message_id', 'in', ids).execute()
      await trx.deleteFrom('recipients').where('message_id', 'in', ids).execute()
      await trx.deleteFrom('messages').where('id', 'in', ids).execute()
    })
    return ids.length
  }

  async close() {
    await this.db.destroy()
  }

  private async hydrate(rows: MessageRow[]): Promise<Message[]> {
    if (rows.length === 0) return []
    const ids = rows.map((r) => r.id)
    const recipients = await this.db
      .selectFrom('recipients')
      .select(['message_id', 'address', 'name', 'kind'])
      .where('message_id', 'in', ids)
      .execute()
    const attachments = await this.db
      .selectFrom('attachments')
      .select(['message_id', 'n', 'filename', 'content_type', 'content_id', 'size'])
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
