import type { Generated, Kysely } from 'kysely'
import type { Migration, MigrationProvider } from 'kysely/migration'

export interface MessagesTable {
  id: Generated<number>
  project_id: string
  provider: string
  provider_id: string
  from_address: string
  reply_to: string
  subject: string
  text: string | null
  html: string | null
  headers: string
  raw: string
  extracted: string
  meta: string
  idempotency_key: string | null
  has_code: number
  created_at: string
  expires_at: string | null
}

export interface RecipientsTable {
  message_id: number
  project_id: string
  address: string
  name: string | null
  kind: string
}

export interface AttachmentsTable {
  message_id: number
  project_id: string
  n: number
  filename: string
  content_type: string
  content_id: string | null
  size: number
  content: Uint8Array
}

export interface RejectionsTable {
  id: Generated<number>
  project_id: string
  provider: string
  to_addresses: string
  status: number
  error: string
  raw: string
  created_at: string
}

export interface Database {
  messages: MessagesTable
  recipients: RecipientsTable
  attachments: AttachmentsTable
  rejections: RejectionsTable
}

const migrations: Record<string, Migration> = {
  '0001_messages': {
    async up(db: Kysely<Database>) {
      await db.schema
        .createTable('messages')
        .addColumn('id', 'integer', (c) => c.primaryKey().autoIncrement())
        .addColumn('project_id', 'text', (c) => c.notNull())
        .addColumn('provider', 'text', (c) => c.notNull())
        .addColumn('provider_id', 'text', (c) => c.notNull())
        .addColumn('from_address', 'text', (c) => c.notNull())
        .addColumn('reply_to', 'text', (c) => c.notNull())
        .addColumn('subject', 'text', (c) => c.notNull())
        .addColumn('text', 'text')
        .addColumn('html', 'text')
        .addColumn('headers', 'text', (c) => c.notNull())
        .addColumn('raw', 'text', (c) => c.notNull())
        .addColumn('extracted', 'text', (c) => c.notNull())
        .addColumn('meta', 'text', (c) => c.notNull())
        .addColumn('idempotency_key', 'text')
        .addColumn('has_code', 'integer', (c) => c.notNull())
        .addColumn('created_at', 'text', (c) => c.notNull())
        .addColumn('expires_at', 'text')
        .execute()
      await db.schema
        .createIndex('messages_project_id_id')
        .on('messages')
        .columns(['project_id', 'id'])
        .execute()
      await db.schema
        .createIndex('messages_provider_id')
        .on('messages')
        .columns(['project_id', 'provider', 'provider_id'])
        .execute()
      await db.schema
        .createIndex('messages_idempotency_key')
        .on('messages')
        .columns(['project_id', 'provider', 'idempotency_key'])
        .execute()
      await db.schema
        .createIndex('messages_expires_at')
        .on('messages')
        .column('expires_at')
        .execute()

      await db.schema
        .createTable('recipients')
        .addColumn('message_id', 'integer', (c) => c.notNull())
        .addColumn('project_id', 'text', (c) => c.notNull())
        .addColumn('address', 'text', (c) => c.notNull())
        .addColumn('name', 'text')
        .addColumn('kind', 'text', (c) => c.notNull())
        .execute()
      await db.schema
        .createIndex('recipients_address')
        .on('recipients')
        .columns(['project_id', 'address', 'message_id'])
        .execute()
      await db.schema
        .createIndex('recipients_message_id')
        .on('recipients')
        .column('message_id')
        .execute()

      await db.schema
        .createTable('attachments')
        .addColumn('message_id', 'integer', (c) => c.notNull())
        .addColumn('project_id', 'text', (c) => c.notNull())
        .addColumn('n', 'integer', (c) => c.notNull())
        .addColumn('filename', 'text', (c) => c.notNull())
        .addColumn('content_type', 'text', (c) => c.notNull())
        .addColumn('content_id', 'text')
        .addColumn('size', 'integer', (c) => c.notNull())
        .addColumn('content', 'blob', (c) => c.notNull())
        .execute()
      await db.schema
        .createIndex('attachments_message_id')
        .on('attachments')
        .columns(['message_id', 'n'])
        .execute()

      await db.schema
        .createTable('rejections')
        .addColumn('id', 'integer', (c) => c.primaryKey().autoIncrement())
        .addColumn('project_id', 'text', (c) => c.notNull())
        .addColumn('provider', 'text', (c) => c.notNull())
        .addColumn('to_addresses', 'text', (c) => c.notNull())
        .addColumn('status', 'integer', (c) => c.notNull())
        .addColumn('error', 'text', (c) => c.notNull())
        .addColumn('raw', 'text', (c) => c.notNull())
        .addColumn('created_at', 'text', (c) => c.notNull())
        .execute()
      await db.schema
        .createIndex('rejections_project_id_id')
        .on('rejections')
        .columns(['project_id', 'id'])
        .execute()
    },
  },
}

export const migrationProvider: MigrationProvider = {
  async getMigrations() {
    return migrations
  },
}
