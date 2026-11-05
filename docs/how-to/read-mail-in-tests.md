# Read mail in tests

This guide shows how a test waits for an email from your app and reads the code or link inside it. It uses the `@nid-inbox/client` package, which works in any JavaScript test runner and has a ready-made Playwright fixture.

Before you start:

- [Run nid](run-nid.md).
- [Point your app at nid](connect-your-app.md).

For other languages, call the [read API](../reference/read-api.md) directly. The client is a thin wrapper over it.

## Install the client

```sh
npm install --save-dev @nid-inbox/client
```

It has no dependencies of its own. It needs Node.js 22.13 or later.

## Use the Playwright fixture

Import `test` and `expect` from `@nid-inbox/client/playwright` instead of from `@playwright/test`. Each test then gets an `inbox`:

```ts
import { test, expect } from '@nid-inbox/client/playwright'

test('sign up with a code', async ({ page, inbox }) => {
  const email = inbox.address('signup')

  await page.goto('/signup')
  await page.fill('#email', email)
  await page.click('text=Send code')

  const message = await inbox.waitFor(email, { hasCode: true })
  await page.fill('#code', message.code!)
  await expect(page.getByText('Welcome')).toBeVisible()
})
```

The fixture calls `inbox.start()` for you before each test.

To point the fixture at a different server, set `inboxOptions` in `playwright.config.ts`:

```ts
import { defineConfig } from '@playwright/test'
import type { InboxWorkerOptions } from '@nid-inbox/client/playwright'

export default defineConfig<{}, InboxWorkerOptions>({
  use: {
    inboxOptions: { url: 'http://127.0.0.1:4500' },
  },
})
```

Or set the `NID_URL` environment variable.

## Use the client in any test runner

Create an inbox, call `start()` at the start of each test, then wait:

```ts
import { createInbox } from '@nid-inbox/client'

const inbox = createInbox({ url: 'http://127.0.0.1:4400' })

test('reset password', async () => {
  await inbox.start()
  const email = inbox.address('reset')

  await requestPasswordReset(email)

  const message = await inbox.waitFor(email)
  expect(message.link).toContain('/reset/')
})
```

## Give each test its own address

Call `inbox.address(prefix)` for every address a test needs. It returns a new address each time, such as `signup.6aaee5fd@inbox.test`. Because no two tests share an address, tests can run in parallel without reading each other's mail.

To use a different domain, pass it once or per call:

```ts
const inbox = createInbox({ domain: 'example.com' })
inbox.address('signup', { domain: 'acme.test' })
```

Some apps reject unknown domains. Use a domain your app accepts.

## Wait for the second email

`waitFor` remembers the last email it returned for each address. Calling it again on the same address returns the next email, never the same one twice:

```ts
const first = await inbox.waitFor(email, { hasCode: true })
await page.click('text=Resend code')
const second = await inbox.waitFor(email, { hasCode: true })
expect(second.code).not.toBe(first.code)
```

## Pick one email out of several

When your app sends two emails close together, filter by subject or by provider:

```ts
const welcome = await inbox.waitFor(email, { subject: 'Welcome' })
const receipt = await inbox.waitFor(email, { subject: 'Receipt', provider: 'resend' })
```

`subject` matches any part of the subject.

## Pull out a code nid does not find

nid guesses codes by looking for 4 to 8 digit numbers, or 6 to 8 letter-and-digit tokens, near words like "code", "verify" or "sign in". When your email uses a different shape, pass your own pattern. The first capture group becomes `code`:

```ts
const message = await inbox.waitFor(email, { codePattern: /key is (\w+)/ })
message.code
```

The pattern runs over the subject and the plain text of the email.

## Change how long to wait

`waitFor` waits 30 seconds by default. Pass `timeout` in seconds, up to 120:

```ts
await inbox.waitFor(email, { timeout: 60 })
```

## Find out why an email never came

When nothing matches in time, `waitFor` throws an `InboxTimeoutError`. Its message says what did arrive and which sends nid refused, for example:

```
Timed out waiting for mail to signup.6aaee5fd@inbox.test after 30s. 1 resend request was rejected 2s ago with 422: Missing `from` field.
```

The error also carries the details as data:

```ts
import { InboxTimeoutError } from '@nid-inbox/client'

try {
  await inbox.waitFor(email)
} catch (err) {
  if (err instanceof InboxTimeoutError) {
    console.log(err.messages)
    console.log(err.rejections)
  }
  throw err
}
```

- `messages` lists mail that reached the address but did not match your filters.
- `rejections` lists sends to the address that nid refused, with the error it returned.

## Read a message in full

`waitFor` and `list` return the message without the raw request. To see exactly what your app sent, fetch it by id:

```ts
const full = await inbox.get(message.id)
full.raw
```

## Clean up

You rarely need to, because each test uses fresh addresses. To remove mail anyway:

```ts
await inbox.clear(email)
await inbox.clear()
```

The first line clears one address. The second clears everything.

## Related

- [Client library reference](../reference/client.md)
- [How nid works](../explanation/how-nid-works.md), for how cursors and extraction work
