import { createMcpHandler } from '@modelcontextprotocol/server'
import { createMcpServer, type ApiFetch } from './tools.js'

export function mcpHandler(api: ApiFetch): (request: Request) => Promise<Response> {
  const handler = createMcpHandler(({ requestInfo }) => createMcpServer(api, requestInfo?.headers.get('authorization') ?? undefined))
  return (request) => handler.fetch(request)
}
