import { createServer, type ServerOptions, type NidServer } from '../src/index.js'

export interface Running {
  server: NidServer
  url: string
  port: number
  smtpPort: number
  close(): Promise<void>
}

export async function start(options: ServerOptions = {}): Promise<Running> {
  const server = await createServer(options)
  const listening = await server.listen({ port: 0, smtpPort: 0 })
  return {
    server,
    url: listening.url,
    port: listening.port,
    smtpPort: listening.smtpPort,
    close: () => server.close(),
  }
}

export const resendHeaders = { authorization: 'Bearer re_test_123', 'content-type': 'application/json' }
export const brevoHeaders = { 'api-key': 'xkeysib-test', 'content-type': 'application/json' }

export function json(body: unknown, headers: Record<string, string>): RequestInit {
  return { method: 'POST', headers, body: JSON.stringify(body) }
}

export async function sendResend(server: NidServer, body: unknown, headers: Record<string, string> = resendHeaders) {
  const res = await server.app.request('/emails', json(body, headers))
  return { status: res.status, body: (await res.json()) as Record<string, unknown> }
}

export async function sendBrevo(server: NidServer, body: unknown, headers: Record<string, string> = brevoHeaders) {
  const res = await server.app.request('/v3/smtp/email', json(body, headers))
  return { status: res.status, body: (await res.json()) as Record<string, unknown> }
}

export async function get(server: NidServer, path: string, headers: Record<string, string> = {}) {
  const res = await server.app.request(path, { headers })
  return { status: res.status, body: (await res.json()) as Record<string, unknown> }
}

export function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
