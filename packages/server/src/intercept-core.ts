import http, { type ClientRequest, type IncomingMessage, type RequestOptions } from 'node:http'
import https from 'node:https'
import { createRequire, syncBuiltinESMExports } from 'node:module'

const require = createRequire(import.meta.url)
const cjsHttp = require('node:http') as typeof http
const cjsHttps = require('node:https') as typeof https

const interceptedHosts = new Set([
  'api.resend.com',
  'api.brevo.com',
  'api.sendinblue.com',
  'api.sendgrid.com',
  'api.eu.sendgrid.com',
  'api.postmarkapp.com',
  'api.mailgun.net',
  'api.eu.mailgun.net',
])

const sesHostPattern = /^email(?:-fips)?\.[a-z0-9-]+\.amazonaws\.com(?:\.cn)?$/i

const tlsOptionKeys = [
  'agent',
  'agents',
  'ca',
  'cert',
  'key',
  'pfx',
  'passphrase',
  'servername',
  'rejectUnauthorized',
  'checkServerIdentity',
  'minVersion',
  'maxVersion',
  'ciphers',
  'secureProtocol',
  'createConnection',
  'defaultPort',
  '_defaultAgent',
]

const stateKey = Symbol.for('nid.interceptor.state')

interface InterceptorState {
  url: string
  restore: () => void
}

export function shouldInterceptHost(hostname: string): boolean {
  const clean = hostname.trim().toLowerCase()
  return interceptedHosts.has(clean) || sesHostPattern.test(clean)
}

function stripPort(host: string): string {
  if (host.startsWith('[')) {
    const end = host.indexOf(']')
    return end === -1 ? host : host.slice(1, end)
  }
  const colon = host.lastIndexOf(':')
  return colon === -1 ? host : host.slice(0, colon)
}

function parseNodeArgs(
  a: string | URL | RequestOptions,
  b?: RequestOptions | ((res: IncomingMessage) => void),
  c?: (res: IncomingMessage) => void,
): {
  url: URL | null
  options: Record<string, unknown>
  callback: ((res: IncomingMessage) => void) | undefined
} {
  let url: URL | null = null
  let options: Record<string, unknown> = {}
  let callback: ((res: IncomingMessage) => void) | undefined
  if (typeof a === 'string') {
    url = URL.canParse(a) ? new URL(a) : null
    if (typeof b === 'function') callback = b
    else {
      if (b && typeof b === 'object') options = { ...(b as Record<string, unknown>) }
      if (typeof c === 'function') callback = c
    }
  } else if (a instanceof URL) {
    url = a
    if (typeof b === 'function') callback = b
    else {
      if (b && typeof b === 'object') options = { ...(b as Record<string, unknown>) }
      if (typeof c === 'function') callback = c
    }
  } else {
    if (a && typeof a === 'object') options = { ...(a as Record<string, unknown>) }
    if (typeof b === 'function') callback = b
  }
  return { url, options, callback }
}

function readHostHeader(headers: unknown): string {
  if (!headers || typeof headers !== 'object') return ''
  for (const [k, v] of Object.entries(headers as Record<string, unknown>)) {
    if (k.toLowerCase() === 'host' && typeof v === 'string') return stripPort(v)
  }
  return ''
}

function buildRewrittenHeaders(headers: unknown, targetHost: string): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  if (headers && typeof headers === 'object' && !Array.isArray(headers)) {
    for (const [k, v] of Object.entries(headers as Record<string, unknown>)) {
      if (k.toLowerCase() !== 'host') out[k] = v
    }
  }
  out.host = targetHost
  return out
}

function targetHostname(url: URL | null, options: Record<string, unknown>): string {
  if (typeof options.hostname === 'string' && options.hostname) return stripPort(options.hostname)
  if (typeof options.host === 'string' && options.host) return stripPort(options.host)
  if (url?.hostname) return url.hostname
  return readHostHeader(options.headers)
}

function joinTargetPath(targetBasePath: string, requestPath: string): string {
  const base = targetBasePath.replace(/\/+$/, '')
  const suffix = '/' + requestPath.replace(/^\/+/, '')
  return `${base}${suffix}`
}

export function installInterceptor(nidUrl: string): () => void {
  const g = globalThis as Record<symbol, InterceptorState | undefined>
  const existing = g[stateKey]
  if (existing) {
    if (existing.url === nidUrl) return existing.restore
    existing.restore()
  }

  const target = new URL(nidUrl)
  const targetPort = target.port ? Number(target.port) : target.protocol === 'https:' ? 443 : 80
  const originalFetch = globalThis.fetch
  const origHttpRequest = cjsHttp.request
  const origHttpGet = cjsHttp.get
  const origHttpsRequest = cjsHttps.request
  const origHttpsGet = cjsHttps.get

  globalThis.fetch = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const rawUrl = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
    const parsed = URL.canParse(rawUrl) ? new URL(rawUrl) : null
    if (!parsed || !shouldInterceptHost(parsed.hostname)) {
      return originalFetch(input, init)
    }
    const rewrittenUrl = new URL(target.origin)
    rewrittenUrl.pathname = joinTargetPath(target.pathname, parsed.pathname)
    rewrittenUrl.search = parsed.search
    const rewritten = rewrittenUrl.href
    if (input instanceof Request) {
      const nextRequest = new Request(rewritten, input)
      return originalFetch(nextRequest, init)
    }
    return originalFetch(rewritten, init)
  }

  const wrapNode = (
    original: typeof http.request,
    isGet: boolean,
  ) => {
    return function (
      a: string | URL | RequestOptions,
      b?: RequestOptions | ((res: IncomingMessage) => void),
      c?: (res: IncomingMessage) => void,
    ): ClientRequest {
      const { url, options, callback } = parseNodeArgs(a, b, c)
      const hostname = targetHostname(url, options)
      if (!hostname || !shouldInterceptHost(hostname)) {
        return (original as (...args: unknown[]) => ClientRequest)(a, b, c)
      }
      const nextOptions: Record<string, unknown> = { ...options }
      if (target.protocol === 'http:') {
        for (const key of tlsOptionKeys) delete nextOptions[key]
      }
      const rawPath =
        typeof nextOptions.path === 'string' && nextOptions.path
          ? nextOptions.path
          : url
            ? `${url.pathname}${url.search}`
            : '/'
      nextOptions.protocol = target.protocol
      nextOptions.hostname = target.hostname
      nextOptions.host = target.hostname
      nextOptions.port = targetPort
      nextOptions.path = joinTargetPath(target.pathname, rawPath)
      nextOptions.headers = buildRewrittenHeaders(options.headers, target.host)
      const transport =
        target.protocol === 'https:'
          ? isGet
            ? origHttpsGet
            : origHttpsRequest
          : isGet
            ? origHttpGet
            : origHttpRequest
      return callback ? transport(nextOptions as RequestOptions, callback) : transport(nextOptions as RequestOptions)
    }
  }

  cjsHttp.request = wrapNode(origHttpRequest, false) as typeof http.request
  cjsHttp.get = wrapNode(origHttpGet, true) as typeof http.get
  cjsHttps.request = wrapNode(origHttpsRequest, false) as typeof https.request
  cjsHttps.get = wrapNode(origHttpsGet, true) as typeof https.get
  syncBuiltinESMExports()

  const restore = () => {
    globalThis.fetch = originalFetch
    cjsHttp.request = origHttpRequest
    cjsHttp.get = origHttpGet
    cjsHttps.request = origHttpsRequest
    cjsHttps.get = origHttpsGet
    syncBuiltinESMExports()
    if (g[stateKey]?.restore === restore) delete g[stateKey]
  }

  g[stateKey] = { url: nidUrl, restore }
  return restore
}
