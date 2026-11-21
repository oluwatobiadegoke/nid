import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { sendResend, start } from './helpers.js'

const cli = fileURLToPath(new URL('../src/cli.ts', import.meta.url))

test('nid read prints an email as plain text, without the terminal codes it carried', async (t) => {
  const running = await start()
  t.after(() => running.close())
  await sendResend(running.server, {
    from: 'a@acme.com',
    to: 'ada@inbox.test',
    subject: 'Your code',
    text: '\u001b[2J\u001b]52;c;ZWNobyBwd25lZA==\u0007Your code is 604020\r\nThanks',
  })
  const { stdout } = await promisify(execFile)(process.execPath, ['--import', 'tsx', cli, 'read', 'ada@inbox.test', '--latest', '--url', running.url])
  assert.match(stdout, /^\[2J\]52;c;ZWNobyBwd25lZA==Your code is 604020\nThanks$/m)
})

test('a busy port ends nid with one line that says what to do, and nid run keeps its start lines out of standard output', async (t) => {
  const running = await start()
  t.after(() => running.close())
  const port = new URL(running.url).port
  const run = (args: string[]) => promisify(execFile)(process.execPath, ['--import', 'tsx', cli, ...args])
  const busy = await run(['serve', '--port', port, '--smtp-port', '0']).then(
    () => assert.fail('expected the busy port to stop nid'),
    (err: { code: number; stderr: string }) => err,
  )
  assert.equal(busy.code, 1)
  assert.equal(busy.stderr, `Port ${port} is already in use. Pass --port 0 and --smtp-port 0 to pick free ports, or with nid run pass --url to use the nid that is already running.\n`)

  const built = fileURLToPath(new URL('../dist/cli.js', import.meta.url))
  const child = await promisify(execFile)(process.execPath, [built, 'run', '--port', '0', '--smtp-port', '0', '--', process.execPath, '-e', 'console.log("child output")'])
  assert.equal(child.stdout, 'child output\n')
  assert.match(child.stderr, /web view/)
})
