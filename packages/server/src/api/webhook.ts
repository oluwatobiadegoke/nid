import type { WebhookRequest } from '../providers/types.js'

export interface WebhookTarget {
  url: string
  secret?: string | undefined
}

export interface WebhookResult {
  url: string
  delivered: boolean
  appStatus: number | null
  appBody: string
  durationMs: number
  error?: string
}

export const webhookTimeoutMs = 10_000

export async function sendWebhook(target: WebhookTarget, request: WebhookRequest): Promise<WebhookResult> {
  const url = new URL(target.url)
  const headers: Record<string, string> = { 'content-type': 'application/json', 'user-agent': 'nid', ...request.headers }
  if (url.username || url.password) {
    const credentials = `${decode(url.username)}:${decode(url.password)}`
    headers.authorization = `Basic ${Buffer.from(credentials).toString('base64')}`
    url.username = ''
    url.password = ''
  }
  const started = performance.now()
  const result = (fields: Omit<WebhookResult, 'url' | 'durationMs'>): WebhookResult => ({
    url: url.href,
    ...fields,
    durationMs: Math.round(performance.now() - started),
  })
  try {
    const response = await fetch(url, {
      method: 'POST',
      headers,
      body: request.body,
      redirect: 'manual',
      signal: AbortSignal.timeout(webhookTimeoutMs),
    })
    return result({ delivered: response.ok, appStatus: response.status, appBody: await response.text() })
  } catch (err) {
    const reason = (err as Error).name === 'TimeoutError' ? `no answer within ${webhookTimeoutMs / 1000} seconds` : errorCause(err)
    return result({ delivered: false, appStatus: null, appBody: '', error: `Could not reach your app at ${url.href}: ${reason}` })
  }
}

function decode(value: string): string {
  try {
    return decodeURIComponent(value)
  } catch {
    return value
  }
}

function errorCause(err: unknown): string {
  const cause = (err as { cause?: { message?: string; code?: string } }).cause
  return cause?.message || cause?.code || (err as Error).message
}
