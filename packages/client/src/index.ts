export interface InboxOptions {
  url?: string | undefined
  token?: string | undefined
  domain?: string | undefined
  fetch?: typeof fetch | undefined
}

export interface Link {
  href: string
  text: string
}

export interface Extracted {
  code: string | null
  codes: string[]
  link: string | null
  links: Link[]
}

export interface AttachmentInfo {
  n: number
  filename: string
  contentType: string
  contentId: string | null
  size: number
  url: string
}

export interface Recipient {
  address: string
  name: string | null
  kind: 'to' | 'cc' | 'bcc'
}

export interface Message {
  id: number
  provider: string
  providerId: string
  from: string
  replyTo: string[]
  to: string[]
  cc: string[]
  bcc: string[]
  recipients: Recipient[]
  subject: string
  text: string | null
  html: string | null
  headers: Record<string, string>
  attachments: AttachmentInfo[]
  extracted: Extracted
  meta: Record<string, unknown>
  createdAt: string
  expiresAt: string | null
}

export interface Email extends Message {
  code: string | null
  link: string | null
  links: Link[]
}

export interface FullEmail extends Email {
  raw: string
}

export interface Rejection {
  id: number
  provider: string
  to: string[]
  status: number
  error: string
  raw?: string
  createdAt: string
}

export interface WaitOptions {
  after?: number | undefined
  subject?: string | undefined
  provider?: string | undefined
  hasCode?: boolean | undefined
  codePattern?: RegExp | string | undefined
  timeout?: number | undefined
}

export interface ListOptions {
  to?: string | undefined
  subject?: string | undefined
  provider?: string | undefined
  after?: number | undefined
  hasCode?: boolean | undefined
  limit?: number | undefined
}

export interface AddressOptions {
  domain?: string | undefined
}

export class InboxError extends Error {
  readonly status: number
  readonly details: string[]

  constructor(message: string, status: number, details: string[] = []) {
    super(message)
    this.name = 'InboxError'
    this.status = status
    this.details = details
  }
}

export class InboxTimeoutError extends InboxError {
  readonly address: string
  readonly messages: Email[]
  readonly rejections: Rejection[]

  constructor(message: string, address: string, messages: Email[], rejections: Rejection[]) {
    super(message, 404)
    this.name = 'InboxTimeoutError'
    this.address = address
    this.messages = messages
    this.rejections = rejections
  }
}

function flatten(message: Message): Email {
  return { ...message, code: message.extracted.code, link: message.extracted.link, links: message.extracted.links }
}

function randomTag(): string {
  const bytes = new Uint8Array(4)
  crypto.getRandomValues(bytes)
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')
}

export class Inbox {
  readonly url: string
  readonly domain: string
  readonly #token: string | undefined
  readonly #fetch: typeof fetch
  readonly #cursors = new Map<string, number>()
  #start: number | null = null

  constructor(options: InboxOptions = {}) {
    this.url = (options.url ?? process.env.TESTINBOX_URL ?? 'http://127.0.0.1:4400').replace(/\/+$/, '')
    this.domain = options.domain ?? process.env.TESTINBOX_DOMAIN ?? 'inbox.test'
    this.#token = options.token ?? process.env.TESTINBOX_TOKEN
    this.#fetch = options.fetch ?? fetch
  }

  address(prefix = 'test', options: AddressOptions = {}): string {
    const clean = prefix.toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '') || 'test'
    return `${clean}.${randomTag()}@${options.domain ?? this.domain}`
  }

  async start(): Promise<number> {
    this.#start = await this.cursor()
    this.#cursors.clear()
    return this.#start
  }

  async cursor(): Promise<number> {
    const body = await this.#request<{ cursor: number }>('/api/cursor')
    return body.cursor
  }

  async waitFor(address: string, options: WaitOptions = {}): Promise<Email> {
    const key = address.trim().toLowerCase()
    const after = options.after ?? this.#cursors.get(key) ?? this.#start ?? undefined
    const params = new URLSearchParams({ to: key })
    if (after !== undefined) params.set('after', String(after))
    if (options.subject) params.set('subject', options.subject)
    if (options.provider) params.set('provider', options.provider)
    if (options.hasCode) params.set('has_code', 'true')
    if (options.codePattern) {
      params.set('code_pattern', options.codePattern instanceof RegExp ? options.codePattern.source : options.codePattern)
    }
    if (options.timeout !== undefined) params.set('timeout', String(options.timeout))
    const response = await this.#raw(`/api/wait?${params}`)
    const body = (await response.json()) as {
      message?: Message
      error?: string
      details?: string[]
      timedOut?: boolean
      messages?: Message[]
      recent_rejections?: Rejection[]
    }
    if (response.status === 404 && body.timedOut) {
      throw new InboxTimeoutError(
        body.error ?? `Timed out waiting for mail to ${key}`,
        key,
        (body.messages ?? []).map(flatten),
        body.recent_rejections ?? [],
      )
    }
    if (!response.ok || !body.message) throw new InboxError(body.error ?? `Request failed with ${response.status}`, response.status, body.details)
    this.#cursors.set(key, body.message.id)
    return flatten(body.message)
  }

  async list(options: ListOptions = {}): Promise<Email[]> {
    const params = new URLSearchParams()
    if (options.to) params.set('to', options.to.trim().toLowerCase())
    if (options.subject) params.set('subject', options.subject)
    if (options.provider) params.set('provider', options.provider)
    if (options.after !== undefined) params.set('after', String(options.after))
    if (options.hasCode) params.set('has_code', 'true')
    if (options.limit !== undefined) params.set('limit', String(options.limit))
    const query = params.size > 0 ? `?${params}` : ''
    const body = await this.#request<{ messages: Message[] }>(`/api/messages${query}`)
    return body.messages.map(flatten)
  }

  async get(id: number): Promise<FullEmail> {
    const body = await this.#request<{ message: Message & { raw: string } }>(`/api/messages/${id}`)
    return { ...flatten(body.message), raw: body.message.raw }
  }

  async rejections(to?: string): Promise<Rejection[]> {
    const query = to ? `?${new URLSearchParams({ to: to.trim().toLowerCase() })}` : ''
    const body = await this.#request<{ rejections: Rejection[] }>(`/api/rejections${query}`)
    return body.rejections
  }

  async clear(address?: string): Promise<number> {
    const query = address ? `?${new URLSearchParams({ to: address.trim().toLowerCase() })}` : ''
    const body = await this.#request<{ deleted: number }>(`/api/messages${query}`, { method: 'DELETE' })
    if (address) this.#cursors.delete(address.trim().toLowerCase())
    else this.#cursors.clear()
    return body.deleted
  }

  async #raw(path: string, init: RequestInit = {}): Promise<Response> {
    const headers = new Headers(init.headers)
    if (this.#token) headers.set('authorization', `Bearer ${this.#token}`)
    try {
      return await this.#fetch(`${this.url}${path}`, { ...init, headers })
    } catch (err) {
      throw new InboxError(`Could not reach testinbox at ${this.url}: ${(err as Error).message}`, 0)
    }
  }

  async #request<T>(path: string, init: RequestInit = {}): Promise<T> {
    const response = await this.#raw(path, init)
    const body = (await response.json().catch(() => ({}))) as T & { error?: string; details?: string[] }
    if (!response.ok) throw new InboxError(body.error ?? `Request failed with ${response.status}`, response.status, body.details)
    return body
  }
}

export function createInbox(options: InboxOptions = {}): Inbox {
  return new Inbox(options)
}
