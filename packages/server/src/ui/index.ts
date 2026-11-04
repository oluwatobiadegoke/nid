import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { Hono } from 'hono'

const pagePath = fileURLToPath(new URL('../../ui/index.html', import.meta.url))

export function webView(): Hono {
  const app = new Hono()
  let cached: string | null = null
  app.get('/', (c) => {
    cached ??= readFileSync(pagePath, 'utf8')
    return c.html(cached, 200, {
      'content-security-policy':
        "default-src 'self'; style-src 'self' 'unsafe-inline'; script-src 'self' 'unsafe-inline'; img-src 'self' data:; frame-src 'self' data: about:; connect-src 'self'",
      'referrer-policy': 'no-referrer',
    })
  })
  return app
}
