import { createMcpHandler } from '@modelcontextprotocol/server'
import { Hono } from 'hono'
import { originCheck } from '../security/host.js'
import { createMcpServer, type ApiFetch } from './tools.js'

export function mcpRoutes(api: ApiFetch, allowHosts: string[]): Hono {
  const handler = createMcpHandler(({ requestInfo }) => createMcpServer(api, requestInfo?.headers.get('authorization') ?? undefined))
  return new Hono().use(originCheck(allowHosts)).all('/', (c) => handler.fetch(c.req.raw))
}
