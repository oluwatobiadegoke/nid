import { matchesPattern } from '../extract/index.js'
import type { Store } from '../store/types.js'
import type { Message, Rejection } from '../types.js'

export const pollIntervalMs = 250
export const defaultTimeoutSeconds = 30
export const maxTimeoutSeconds = 120

export interface WaitParams {
  to: string
  after?: number | undefined
  subject?: string | undefined
  provider?: string | undefined
  hasCode?: boolean | undefined
  codePattern?: RegExp | null | undefined
  timeoutMs: number
  signal?: AbortSignal | undefined
}

export interface WaitResult {
  message: Message | null
  code: string | null
  timedOut: boolean
  arrived: Message[]
  rejections: Rejection[]
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(done, ms)
    function done() {
      signal?.removeEventListener('abort', done)
      clearTimeout(timer)
      resolve()
    }
    signal?.addEventListener('abort', done, { once: true })
  })
}

async function find(store: Store, projectId: string, params: WaitParams): Promise<{ message: Message; code: string | null } | null> {
  const candidates = await store.listMessages(projectId, {
    to: params.to,
    subject: params.subject,
    provider: params.provider,
    after: params.after,
    hasCode: params.hasCode,
    order: 'asc',
    limit: 50,
  })
  for (const message of candidates) {
    if (params.codePattern) {
      const code = matchesPattern(message, params.codePattern)
      if (code === null) continue
      return { message, code }
    }
    return { message, code: message.extracted.code }
  }
  return null
}

export async function waitForMessage(store: Store, projectId: string, params: WaitParams): Promise<WaitResult> {
  const deadline = Date.now() + params.timeoutMs
  const startedAt = new Date(Date.now() - 60_000).toISOString()
  while (true) {
    const found = await find(store, projectId, params)
    if (found) return { message: found.message, code: found.code, timedOut: false, arrived: [], rejections: [] }
    if (Date.now() >= deadline || params.signal?.aborted) break
    await sleep(Math.min(pollIntervalMs, Math.max(0, deadline - Date.now())), params.signal)
  }
  const arrived = await store.listMessages(projectId, { to: params.to, after: params.after, limit: 10 })
  const rejections = await store.listRejections(projectId, { to: params.to, since: startedAt, limit: 10 })
  return { message: null, code: null, timedOut: true, arrived, rejections }
}

function ago(iso: string): string {
  const seconds = Math.max(0, Math.round((Date.now() - Date.parse(iso)) / 1000))
  if (seconds < 60) return `${seconds}s ago`
  return `${Math.round(seconds / 60)}m ago`
}

export function describeTimeout(params: WaitParams, result: WaitResult): string {
  const parts = [`Timed out waiting for mail to ${params.to} after ${Math.round(params.timeoutMs / 1000)}s.`]
  if (result.arrived.length > 0) {
    const n = result.arrived.length
    parts.push(`${n} message${n === 1 ? '' : 's'} to that address arrived but did not match the filters.`)
  }
  for (const r of result.rejections.slice(0, 3)) {
    parts.push(`1 ${r.provider} request was rejected ${ago(r.createdAt)} with ${r.status}: ${r.error}`)
  }
  return parts.join(' ')
}
