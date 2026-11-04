import type { MiddlewareHandler } from 'hono'

const ipv4 = /^\d{1,3}(\.\d{1,3}){3}$/

export function hostAllowed(hostHeader: string | undefined, allowHosts: string[]): boolean {
  if (!hostHeader) return true
  let host = hostHeader.trim().toLowerCase()
  if (host.startsWith('[')) {
    const end = host.indexOf(']')
    host = end === -1 ? host : host.slice(1, end)
  } else {
    const colon = host.lastIndexOf(':')
    if (colon !== -1 && !host.slice(colon + 1).includes(']')) host = host.slice(0, colon)
  }
  if (host === 'localhost' || host.endsWith('.localhost')) return true
  if (ipv4.test(host) || host.includes(':')) return true
  if (!host.includes('.')) return true
  return allowHosts.some((allowed) => allowed.toLowerCase() === host)
}

export function hostCheck(allowHosts: string[]): MiddlewareHandler {
  return async (c, next) => {
    if (!hostAllowed(c.req.header('host'), allowHosts)) {
      return c.json(
        { error: 'This host is not allowed. Start the server with --allow-host <name> to accept it.' },
        403,
      )
    }
    await next()
  }
}
