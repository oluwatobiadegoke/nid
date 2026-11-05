import { createMcpHandler } from '@modelcontextprotocol/server'
import { Hono } from 'hono'
import { hostAllowed } from '../security/host.js'
import { createMcpServer, type ApiFetch } from './tools.js'

function originAllowed(origin: string | undefined, allowHosts: string[]): boolean {
  if (!origin) return true
  try {
    return hostAllowed(new URL(origin).host, allowHosts)
  } catch {
    return false
  }
}

export function mcpRoute(api: ApiFetch, allowHosts: string[]): Hono {
  const handler = createMcpHandler(({ requestInfo }) => {
    const authorization = requestInfo?.headers.get('authorization')
    return createMcpServer((path, init) => {
      const headers = new Headers(init?.headers)
      if (authorization) headers.set('authorization', authorization)
      return api(path, { ...init, headers })
    })
  })
  const app = new Hono()
  app.all('/mcp', async (c) => {
    if (!originAllowed(c.req.header('origin'), allowHosts)) {
      return c.json({ error: 'This origin is not allowed. Start the server with --allow-host <name> to accept it.' }, 403)
    }
    return handler.fetch(c.req.raw)
  })
  return app
}
