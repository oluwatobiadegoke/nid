import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { createServer } from '../src/index.js'

test('with CORS origins set, only the named page can read mail from another origin', async (t) => {
  const server = await createServer({ cors: ['http://localhost:3000/'] })
  t.after(() => server.close())
  const read = (origin: string) => server.app.request('/api/messages', { headers: { origin } })
  assert.equal((await read('http://localhost:3000')).headers.get('access-control-allow-origin'), 'http://localhost:3000')
  assert.equal((await read('https://evil.example')).headers.get('access-control-allow-origin'), null)
})

test('a CORS origin without a scheme, or the old cors: true, stops nid at startup and says what to give', async () => {
  await assert.rejects(createServer({ cors: ['localhost:3000'] }), /The CORS origin "localhost:3000" is not an http:\/\/ or https:\/\/ origin, such as http:\/\/localhost:3000\./)
  await assert.rejects(createServer({ cors: true as unknown as string[] }), /cors takes the origins to allow, such as \["http:\/\/localhost:3000"\]\./)
})

test('plain --cors with no origin says what is missing instead of crashing', async () => {
  const cli = fileURLToPath(new URL('../src/cli.ts', import.meta.url))
  const run = promisify(execFile)(process.execPath, ['--import', 'tsx', cli, 'serve', '--port', '0', '--smtp-port', '0', '--cors'], { timeout: 10_000 })
  const err = (await run.catch((e: unknown) => e)) as { code: number; stderr: string }
  assert.equal(err.code, 1)
  assert.match(err.stderr, /^Option '--cors <value>' argument missing\n/)
  assert.match(err.stderr, /--cors origin/)
})
