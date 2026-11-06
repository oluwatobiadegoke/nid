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
