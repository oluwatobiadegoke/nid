import { execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { performance } from 'node:perf_hooks'
import { fileURLToPath, pathToFileURL } from 'node:url'

const serverEntryPath = fileURLToPath(new URL('../packages/server/dist/index.js', import.meta.url))
if (!existsSync(serverEntryPath)) {
  console.error('Missing packages/server/dist/index.js. Run "pnpm build" first.')
  process.exit(1)
}
const serverEntryUrl = pathToFileURL(serverEntryPath).href

function measureBoot(withListen) {
  const listenStep = withListen ? 'await server.listen({ port: 0, smtpPort: 0 });' : ''
  const script = `
    import { performance } from 'node:perf_hooks'
    const start = performance.now()
    const { createServer } = await import(${JSON.stringify(serverEntryUrl)})
    const server = await createServer()
    ${listenStep}
    const bootMs = performance.now() - start
    const rssMb = process.memoryUsage().rss / (1024 * 1024)
    await server.close()
    console.log(JSON.stringify({ bootMs, rssMb }))
  `
  const stdout = execFileSync(process.execPath, ['--input-type=module', '-e', script], { encoding: 'utf8' })
  return JSON.parse(stdout.trim())
}

function checkLazyModules(withListen) {
  const listenStep = withListen ? 'await server.listen({ port: 0, smtpPort: 0 });' : ''
  const script = `
    import * as moduleApi from 'node:module'
    if (typeof moduleApi.registerHooks !== 'function') {
      console.log(JSON.stringify({ supported: false, hits: [] }))
      process.exit(0)
    }
    const loaded = new Set()
    moduleApi.registerHooks({
      load(url, context, nextLoad) {
        loaded.add(url)
        return nextLoad(url, context)
      },
    })
    const { createServer } = await import(${JSON.stringify(serverEntryUrl)})
    const server = await createServer()
    ${listenStep}
    await server.close()
    const req = moduleApi.createRequire(import.meta.url)
    for (const id of Object.keys(req.cache)) loaded.add(id)
    for (const entry of process.moduleLoadList ?? []) loaded.add(entry)
    const lazyTargets = ['node:sqlite', 'kysely', 'mailparser', 'smtp-server', '@modelcontextprotocol/server']
    const hits = lazyTargets.filter((pkg) => [...loaded].some((entry) => entry.includes(pkg)))
    console.log(JSON.stringify({ supported: true, hits }))
  `
  const stdout = execFileSync(process.execPath, ['--input-type=module', '-e', script], { encoding: 'utf8' })
  return JSON.parse(stdout.trim())
}

function formatLazy(audit) {
  if (!audit.supported) return 'skipped (Node runtime lacks module.registerHooks)'
  return audit.hits.length === 0 ? 'none' : audit.hits.join(', ')
}

function percentile(sorted, p) {
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1))
  return sorted[index]
}

const boot = measureBoot(false)
const listenBoot = measureBoot(true)
const lazyOnBoot = checkLazyModules(false)
const lazyOnListen = checkLazyModules(true)

const { createServer } = await import(serverEntryUrl)

const ingestServer = await createServer()
const ingestListening = await ingestServer.listen({ port: 0, smtpPort: false })
const sendBody = JSON.stringify({
  from: 'Acme <hello@acme.com>',
  to: 'bench@inbox.test',
  subject: 'Benchmark code',
  text: 'Your code is 482913.',
})
const sendCount = 1000
const ingestStart = performance.now()
for (let i = 0; i < sendCount; i++) {
  const res = await fetch(`${ingestListening.url}/emails`, {
    method: 'POST',
    headers: {
      authorization: 'Bearer re_bench',
      'content-type': 'application/json',
    },
    body: sendBody,
  })
  if (!res.ok) throw new Error(`Ingest failed with status ${res.status}`)
  await res.arrayBuffer()
}
const ingestMs = performance.now() - ingestStart
const ingestRate = (sendCount / ingestMs) * 1000
await ingestServer.close()

const waitServer = await createServer()
const waitListening = await waitServer.listen({ port: 0, smtpPort: false })
const waitIterations = 100
const latencies = []
for (let i = 0; i < waitIterations; i++) {
  const recipient = `wait-${i}@inbox.test`
  const waitPromise = fetch(
    `${waitListening.url}/api/wait?to=${encodeURIComponent(recipient)}&timeout=5`,
  )
  await new Promise((resolve) => setTimeout(resolve, 1))
  const sentAt = performance.now()
  const sendPromise = fetch(`${waitListening.url}/emails`, {
    method: 'POST',
    headers: {
      authorization: 'Bearer re_bench',
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      from: 'Acme <hello@acme.com>',
      to: recipient,
      subject: 'Your code',
      text: 'Your code is 482913.',
    }),
  })
  const [waitRes, sendRes] = await Promise.all([waitPromise, sendPromise])
  const elapsed = performance.now() - sentAt
  if (!waitRes.ok) throw new Error(`Wait failed with status ${waitRes.status}`)
  if (!sendRes.ok) throw new Error(`Send failed with status ${sendRes.status}`)
  await Promise.all([waitRes.arrayBuffer(), sendRes.arrayBuffer()])
  latencies.push(elapsed)
}
await waitServer.close()

latencies.sort((a, b) => a - b)
const waitP50 = percentile(latencies, 50)
const waitP99 = percentile(latencies, 99)

console.log(`Cold boot (createServer): ${boot.bootMs.toFixed(1)} ms (${boot.rssMb.toFixed(1)} MB RSS)`)
console.log(`Default listen (createServer + HTTP/SMTP): ${listenBoot.bootMs.toFixed(1)} ms (${listenBoot.rssMb.toFixed(1)} MB RSS)`)
console.log(`Lazy deps loaded on boot: ${formatLazy(lazyOnBoot)}`)
console.log(`Lazy deps loaded on listen: ${formatLazy(lazyOnListen)}`)
console.log(`HTTP ingest over loopback (${sendCount} Resend sends): ${ingestMs.toFixed(1)} ms (${Math.round(ingestRate)} req/s)`)
console.log(`waitFor wakeup over loopback (${waitIterations} runs): p50 ${waitP50.toFixed(2)} ms, p99 ${waitP99.toFixed(2)} ms`)
