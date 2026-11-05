import assert from 'node:assert/strict'
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const read = (path) => readFileSync(join(root, path), 'utf8')

function filesUnder(dir, ext) {
  return readdirSync(join(root, dir)).flatMap((name) => {
    const path = join(dir, name)
    if (statSync(join(root, path)).isDirectory()) return filesUnder(path, ext)
    return path.endsWith(ext) ? [path] : []
  })
}

function missing(doc, names) {
  const text = read(doc)
  return [...new Set(names)].filter((name) => !text.includes(name))
}

test('every read API route is in the read API reference', () => {
  const routes = [...read('packages/server/src/api/openapi.ts').matchAll(/^\s+'(\/[^']+)': \{/gm)].map((m) => m[1])
  assert.ok(routes.length > 0)
  assert.deepEqual(missing('docs/reference/read-api.md', [...routes, '/api/openapi.json']), [])
})

test('every CLI option is in the CLI reference', () => {
  const options = [...read('packages/server/src/cli.ts').matchAll(/^\s+'?([a-z][a-z-]*)'?: \{ type: '(?:string|boolean)'/gm)].map(
    (m) => `--${m[1]}`,
  )
  assert.ok(options.length > 0)
  assert.deepEqual(missing('docs/reference/cli.md', options), [])
})

test('every environment variable is in the configuration reference', () => {
  const sources = [...filesUnder('packages/server/src', '.ts'), ...filesUnder('packages/client/src', '.ts'), 'Dockerfile']
  const vars = sources.flatMap((path) => [...read(path).matchAll(/\bNID_[A-Z_]+\b/g)].map((m) => m[0]))
  assert.ok(vars.length > 0)
  assert.deepEqual(missing('docs/reference/configuration.md', vars), [])
})

test('every provider and provider route is in the providers reference', () => {
  const names = []
  for (const path of filesUnder('packages/server/src/providers', '.ts')) {
    const source = read(path)
    for (const m of source.matchAll(/^const name = '([^']+)'/gm)) names.push(`\`${m[1]}\``)
    for (const m of source.matchAll(/^\s+path: '([^']+)'/gm)) names.push(m[1].replace(/:(\w+)/g, '{$1}'))
  }
  assert.ok(names.length > 0)
  assert.deepEqual(missing('docs/reference/providers.md', names), [])
})

test('every createServer option is in the configuration reference', () => {
  const block = read('packages/server/src/server.ts').match(/export interface ServerOptions \{([\s\S]*?)\n\}/)?.[1] ?? ''
  const options = [...block.matchAll(/^\s+(\w+)\??:/gm)].map((m) => `| \`${m[1]}\` |`)
  assert.ok(options.length > 0)
  assert.deepEqual(missing('docs/reference/configuration.md', options), [])
})

test('every public client method is in the client reference', () => {
  const block = read('packages/client/src/index.ts').match(/export class Inbox \{([\s\S]*?)\n\}/)?.[1] ?? ''
  const methods = [...block.matchAll(/^ {2}(?:async )?([a-z]\w*)\(/gm)].map((m) => m[1]).filter((name) => name !== 'constructor').map((name) => `### ${name}(`)
  assert.ok(methods.length > 0)
  assert.deepEqual(missing('docs/reference/client.md', methods), [])
})

test('every relative link in the docs points at a file that exists', () => {
  const pages = ['README.md', 'CONTRIBUTING.md', 'AGENTS.md', ...filesUnder('docs', '.md')]
  const broken = []
  for (const page of pages) {
    const text = read(page).replace(/```[\s\S]*?```/g, '')
    for (const m of text.matchAll(/\]\(([^)\s]+)\)/g)) {
      const target = m[1].split('#')[0]
      if (!target || /^[a-z]+:/i.test(target)) continue
      const path = join(dirname(join(root, page)), target)
      if (!existsSync(path)) broken.push(`${page} -> ${m[1]}`)
    }
  }
  assert.deepEqual(broken, [])
})

test('every docs page is linked from the docs index', () => {
  const index = read('docs/README.md')
  const pages = filesUnder('docs', '.md')
    .filter((p) => p !== join('docs', 'README.md'))
    .map((p) => relative('docs', p))
  assert.deepEqual(
    pages.filter((p) => !index.includes(`(${p})`)),
    [],
  )
})

test('the root README and the npm README are the same', () => {
  assert.equal(read('packages/server/README.md'), read('README.md'))
})
