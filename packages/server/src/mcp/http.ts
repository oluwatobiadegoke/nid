import { AsyncLocalStorage } from 'node:async_hooks'
import { Hono } from 'hono'
import { originCheck } from '../security/host.js'
import type { ApiFetch } from './tools.js'

export function mcpRoutes(api: ApiFetch, allowHosts: string[]): Hono {
  const requestSignals = new AsyncLocalStorage<AbortSignal>()
  const scopedApi: ApiFetch = (path, init) => {
    const httpSignal = requestSignals.getStore()
    const signals = [httpSignal, init?.signal].filter((s): s is AbortSignal => s !== undefined)
    const signal = signals.length > 1 ? AbortSignal.any(signals) : signals[0]
    return api(path, signal ? { ...init, signal } : init)
  }
  let loader: Promise<{ fetch(request: Request): Promise<Response> }> | null = null
  const getHandler = () =>
    (loader ??= Promise.all([import('@modelcontextprotocol/server'), import('./tools.js')]).then(
      ([{ createMcpHandler }, { createMcpServer }]) =>
        createMcpHandler(({ requestInfo }) =>
          createMcpServer(scopedApi, requestInfo?.headers.get('authorization') ?? undefined),
        ),
    ))
  return new Hono()
    .use(originCheck(allowHosts))
    .all('/', async (c) => requestSignals.run(c.req.raw.signal, async () => (await getHandler()).fetch(c.req.raw)))
}
