# @nid-inbox/client

A small client for reading mail from [nid](https://github.com/oluwatobiadegoke/nid) in tests, with a Playwright fixture. No dependencies. Needs Node.js 22.13 or later.

```sh
npm install --save-dev @nid-inbox/client
```

## Use it in any test runner

```ts
import { createInbox } from '@nid-inbox/client'

const inbox = createInbox({ url: 'http://127.0.0.1:4400' })
await inbox.start()

const email = inbox.address('signup')
const message = await inbox.waitFor(email, { hasCode: true })
message.code
message.link
```

## Use it with Playwright

```ts
import { test, expect } from '@nid-inbox/client/playwright'

test('sign up', async ({ page, inbox }) => {
  const email = inbox.address('signup')
  await page.fill('#email', email)
  await page.click('text=Send code')
  const { code } = await inbox.waitFor(email, { hasCode: true })
  await page.fill('#code', code!)
})
```

`waitFor` remembers the last email it returned for each address, so a second call returns the next email. `start()`, which the fixture calls for you, takes a cursor at the start of a test so mail from an earlier test never matches.

When no options are passed, the client reads `NID_URL`, `NID_TOKEN` and `NID_DOMAIN` from the environment.

## Documentation

- [Read mail in tests](https://github.com/oluwatobiadegoke/nid/blob/main/docs/how-to/read-mail-in-tests.md)
- [Client library reference](https://github.com/oluwatobiadegoke/nid/blob/main/docs/reference/client.md)
