import type { Store } from './types.js'
import type { SqliteStoreOptions } from './sqlite-store.js'

export type { Store, MessageQuery, RejectionQuery } from './types.js'
export type { Database } from './schema.js'
export type { SqliteStoreOptions } from './sqlite-store.js'
export { MemoryStore, createMemoryStore, type MemoryStoreOptions } from './memory-store.js'

export async function createSqliteStore(options: SqliteStoreOptions = {}): Promise<Store> {
  const { createSqliteStore: open } = await import('./sqlite-store.js')
  return open(options)
}
