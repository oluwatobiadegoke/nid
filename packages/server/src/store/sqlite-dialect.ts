import { createRequire } from 'node:module'
import type { DatabaseSync } from 'node:sqlite'
import {
  CompiledQuery,
  SelectQueryNode,
  SqliteAdapter,
  SqliteIntrospector,
  SqliteQueryCompiler,
  type DatabaseConnection,
  type Dialect,
  type Driver,
  type Kysely,
  type QueryResult,
} from 'kysely'

type Param = null | number | bigint | string | Uint8Array

function loadSqlite(): typeof import('node:sqlite') {
  const require = createRequire(import.meta.url)
  const original = process.emitWarning
  process.emitWarning = ((warning: unknown, ...rest: unknown[]) => {
    if (String(warning).includes('SQLite')) return
    ;(original as (...args: unknown[]) => void).call(process, warning, ...rest)
  }) as typeof process.emitWarning
  try {
    return require('node:sqlite') as typeof import('node:sqlite')
  } finally {
    process.emitWarning = original
  }
}

const sqlite = loadSqlite()

const readPrefixes = ['select', 'pragma', 'with ', 'explain']

function isRead(compiled: CompiledQuery): boolean {
  const query = compiled.query as { kind?: string; returning?: unknown }
  if (SelectQueryNode.is(compiled.query)) return true
  if (query.returning) return true
  const head = compiled.sql.trimStart().slice(0, 7).toLowerCase()
  return readPrefixes.some((p) => head.startsWith(p))
}

function toParam(value: unknown): Param {
  if (value === null || value === undefined) return null
  if (typeof value === 'boolean') return value ? 1 : 0
  if (value instanceof Date) return value.toISOString()
  if (typeof value === 'number' || typeof value === 'bigint' || typeof value === 'string') return value
  if (value instanceof Uint8Array) return value
  return JSON.stringify(value)
}

class NodeSqliteConnection implements DatabaseConnection {
  readonly #db: DatabaseSync

  constructor(db: DatabaseSync) {
    this.#db = db
  }

  async executeQuery<R>(compiled: CompiledQuery): Promise<QueryResult<R>> {
    const statement = this.#db.prepare(compiled.sql)
    const params = compiled.parameters.map(toParam)
    if (isRead(compiled)) {
      return { rows: statement.all(...params) as R[] }
    }
    const result = statement.run(...params)
    return {
      insertId: BigInt(result.lastInsertRowid),
      numAffectedRows: BigInt(result.changes),
      rows: [],
    }
  }

  async *streamQuery<R>(compiled: CompiledQuery): AsyncIterableIterator<QueryResult<R>> {
    const statement = this.#db.prepare(compiled.sql)
    for (const row of statement.iterate(...compiled.parameters.map(toParam))) {
      yield { rows: [row as R] }
    }
  }
}

class NodeSqliteDriver implements Driver {
  readonly #db: DatabaseSync
  readonly #connection: NodeSqliteConnection

  constructor(db: DatabaseSync) {
    this.#db = db
    this.#connection = new NodeSqliteConnection(db)
  }

  async init() {}

  async acquireConnection() {
    return this.#connection
  }

  async beginTransaction(connection: DatabaseConnection) {
    await connection.executeQuery(CompiledQuery.raw('begin'))
  }

  async commitTransaction(connection: DatabaseConnection) {
    await connection.executeQuery(CompiledQuery.raw('commit'))
  }

  async rollbackTransaction(connection: DatabaseConnection) {
    await connection.executeQuery(CompiledQuery.raw('rollback'))
  }

  async releaseConnection() {}

  async destroy() {
    this.#db.close()
  }
}

export class NodeSqliteDialect implements Dialect {
  readonly #db: DatabaseSync

  constructor(db: DatabaseSync) {
    this.#db = db
  }

  createAdapter() {
    return new SqliteAdapter()
  }

  createDriver() {
    return new NodeSqliteDriver(this.#db)
  }

  createQueryCompiler() {
    return new SqliteQueryCompiler()
  }

  createIntrospector(db: Kysely<unknown>) {
    return new SqliteIntrospector(db)
  }
}

export function openSqlite(path: string): DatabaseSync {
  const db = new sqlite.DatabaseSync(path)
  db.exec('pragma journal_mode = wal')
  db.exec('pragma foreign_keys = on')
  return db
}
