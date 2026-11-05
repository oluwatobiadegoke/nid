import type { Message, NewMessage } from '../types.js'
import type { Store } from '../store/types.js'

export interface IncomingRequest {
  method: string
  path: string
  params: Record<string, string>
  query: URLSearchParams
  headers: Headers
  contentType: string
  body: unknown
  rawBody: string
}

export interface ProviderReply {
  status: number
  body: unknown
  headers?: Record<string, string>
}

export class SendError extends Error {
  readonly reply: ProviderReply
  readonly to: string[]

  constructor(reply: ProviderReply, to: string[], message: string) {
    super(message)
    this.name = 'SendError'
    this.reply = reply
    this.to = to
  }
}

export interface SendRoute {
  kind: 'send'
  method: 'POST'
  path: string
  parse(req: IncomingRequest): Array<NewMessage | SendError> | Promise<Array<NewMessage | SendError>>
  reply(messages: Message[], outcomes: Array<Message | SendError>): ProviderReply
}

export interface ReadContext {
  store: Store
  projectId: string
}

export interface ReadRoute {
  kind: 'read'
  method: 'GET' | 'POST'
  path: string
  handle(req: IncomingRequest, ctx: ReadContext): Promise<ProviderReply>
}

export type ProviderRoute = SendRoute | ReadRoute

export interface Provider {
  name: string
  label: string
  credential(req: IncomingRequest): string | null
  unauthorized(): ProviderReply
  routes: ProviderRoute[]
  setup: { env: string; note: string }
}
