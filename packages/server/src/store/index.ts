import { Kysely } from 'kysely'
import type { Database } from './schema.js'
import { KyselyStore } from './kysely-store.js'
import { NodeSqliteDialect, openSqlite } from './sqlite-dialect.js'

export type { Store, MessageQuery, RejectionQuery } from './types.js'
export type { Database } from './schema.js'
export { KyselyStore } from './kysely-store.js'
export { NodeSqliteDialect } from './sqlite-dialect.js'

export interface SqliteStoreOptions {
  path?: string
}

export async function createSqliteStore(options: SqliteStoreOptions = {}): Promise<KyselyStore> {
  const db = new Kysely<Database>({ dialect: new NodeSqliteDialect(openSqlite(options.path ?? ':memory:')) })
  const store = new KyselyStore(db)
  await store.migrate()
  return store
}
