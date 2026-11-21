import type { EventBus } from '../events/index.js'
import type { Provider, WebhookEvent, WebhookRequest } from '../providers/types.js'
import type { Store } from '../store/types.js'
import type { Message } from '../types.js'

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

export interface DispatchWebhookOptions {
  store: Store
  events: EventBus
  provider: Provider
  target: WebhookTarget
  projectId: string
  message: Message
  event: WebhookEvent
  recipient?: string | undefined
  url?: string | undefined
  reason?: string | undefined
}

const webhookTimeoutMs = 10_000

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

export async function dispatchWebhook(options: DispatchWebhookOptions): Promise<WebhookResult> {
  const recipient = options.recipient ?? options.message.recipients[0]?.address ?? ''
  const request = options.provider.webhook!({
    message: options.message,
    event: options.event,
    recipient,
    recipientOverride: options.recipient,
    secret: options.target.secret,
    now: new Date(),
    url: options.url,
    reason: options.reason,
  })
  const outcome = await sendWebhook(options.target, request)
  if (!(await options.store.getMessage(options.projectId, options.message.id))) return outcome
  const delivery = await options.store.insertWebhookDelivery(options.projectId, {
    messageId: options.message.id,
    provider: options.provider.name,
    event: options.event,
    recipient,
    url: outcome.url,
    delivered: outcome.delivered,
    appStatus: outcome.appStatus,
    appBody: outcome.appBody,
    durationMs: outcome.durationMs,
    error: outcome.error ?? null,
  })
  options.events.emit(options.projectId, { kind: 'webhook', delivery })
  return outcome
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
