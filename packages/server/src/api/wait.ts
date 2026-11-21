import type { EventBus } from '../events/index.js'
import { matchesPattern } from '../extract/index.js'
import type { Store } from '../store/types.js'
import type { Message, Rejection } from '../types.js'

export const defaultTimeoutSeconds = 30
export const maxTimeoutSeconds = 120

const pageSize = 50

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

export function matchesMessage(message: Message, params: WaitParams): { matched: boolean; code: string | null } {
  const target = params.to.trim().toLowerCase()
  if (!message.recipients.some((r) => r.address.toLowerCase() === target)) return { matched: false, code: null }
  if (params.after !== undefined && message.id <= params.after) return { matched: false, code: null }
  if (params.provider && message.provider !== params.provider) return { matched: false, code: null }
  if (params.subject && !message.subject.toLowerCase().includes(params.subject.toLowerCase())) {
    return { matched: false, code: null }
  }
  if (params.hasCode && !message.extracted.code) return { matched: false, code: null }
  if (params.codePattern) {
    const code = matchesPattern(message, params.codePattern)
    if (code === null) return { matched: false, code: null }
    return { matched: true, code }
  }
  return { matched: true, code: message.extracted.code }
}

async function findExisting(
  store: Store,
  projectId: string,
  params: WaitParams,
): Promise<{ message: Message; code: string | null } | null> {
  let cursor = params.after
  while (true) {
    const candidates = await store.listMessages(projectId, {
      to: params.to,
      subject: params.subject,
      provider: params.provider,
      after: cursor,
      hasCode: params.hasCode,
      order: 'asc',
      limit: pageSize,
    })
    for (const message of candidates) {
      if (params.codePattern) {
        const code = matchesPattern(message, params.codePattern)
        if (code === null) continue
        return { message, code }
      }
      return { message, code: message.extracted.code }
    }
    if (candidates.length < pageSize) return null
    cursor = candidates[candidates.length - 1]!.id
  }
}

export async function waitForMessage(
  store: Store,
  events: EventBus,
  projectId: string,
  params: WaitParams,
): Promise<WaitResult> {
  const startedAt = new Date(Date.now() - 60_000).toISOString()
  const buffered: Array<{ message: Message; code: string | null }> = []
  let onMatch: ((hit: { message: Message; code: string | null }) => void) | null = null

  const unsubscribe = events.subscribe(projectId, (event) => {
    if (event.kind !== 'message') return
    const hit = matchesMessage(event.message, params)
    if (!hit.matched) return
    const match = { message: event.message, code: hit.code }
    if (onMatch) onMatch(match)
    else buffered.push(match)
  })

  const nextMatch = (ms: number) =>
    new Promise<{ message: Message; code: string | null } | null>((resolve) => {
      if (ms <= 0 || params.signal?.aborted) return resolve(null)
      const finish = (value: { message: Message; code: string | null } | null) => {
        clearTimeout(timer)
        params.signal?.removeEventListener('abort', onAbort)
        onMatch = null
        resolve(value)
      }
      const onAbort = () => finish(null)
      onMatch = finish
      const timer = setTimeout(() => finish(null), ms)
      params.signal?.addEventListener('abort', onAbort, { once: true })
    })

  try {
    const existing = await findExisting(store, projectId, params)
    if (existing) {
      return { message: existing.message, code: existing.code, timedOut: false, arrived: [], rejections: [] }
    }
    const deadline = Date.now() + params.timeoutMs
    while (true) {
      buffered.sort((a, b) => a.message.id - b.message.id)
      const match = buffered.shift() ?? (await nextMatch(deadline - Date.now()))
      if (params.signal?.aborted) return { message: null, code: null, timedOut: true, arrived: [], rejections: [] }
      if (!match) break
      const hit = params.subject ? await findExisting(store, projectId, { ...params, after: match.message.id - 1 }) : match
      if (hit) return { message: hit.message, code: hit.code, timedOut: false, arrived: [], rejections: [] }
    }
    const arrived = await store.listMessages(projectId, { to: params.to, after: params.after, limit: 10 })
    const rejections = await store.listRejections(projectId, { to: params.to, since: startedAt, limit: 10 })
    return { message: null, code: null, timedOut: true, arrived, rejections }
  } finally {
    unsubscribe()
  }
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
