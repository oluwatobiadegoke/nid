import { Hono } from 'hono'
import { originCheck } from '../security/host.js'
import type { ApiFetch } from './tools.js'

export function mcpRoutes(api: ApiFetch, allowHosts: string[]): Hono {
  let loader: Promise<{ fetch(request: Request): Promise<Response> }> | null = null
  const getHandler = () =>
    (loader ??= Promise.all([import('@modelcontextprotocol/server'), import('./tools.js')]).then(
      ([{ createMcpHandler }, { createMcpServer }]) =>
        createMcpHandler(({ requestInfo }) =>
          createMcpServer(api, requestInfo?.headers.get('authorization') ?? undefined),
        ),
    ))
  return new Hono()
    .use(originCheck(allowHosts))
    .all('/', async (c) => (await getHandler()).fetch(c.req.raw))
}
