# @nid-inbox/client

A tiny client for reading mail from nid in tests, with a Playwright fixture. No dependencies.

```ts
import { createInbox } from '@nid-inbox/client'

const inbox = createInbox({ url: 'http://localhost:4400' })
await inbox.start()
const email = inbox.address('signup')
const message = await inbox.waitFor(email, { hasCode: true })
message.code
```

```ts
import { test, expect } from '@nid-inbox/client/playwright'

test('sign up', async ({ page, inbox }) => {
  const email = inbox.address('signup')
  await page.fill('#email', email)
  await page.click('text=Send code')
  const { code } = await inbox.waitFor(email, { hasCode: true })
  await page.fill('#code', code)
})
```

`waitFor` remembers the cursor per address, so a second call returns the next email. `start()` (which the fixture calls for you) takes a cursor at the start of a test so mail from an earlier test never matches. Options: `after`, `subject`, `provider`, `hasCode`, `codePattern`, `timeout`.

Reads `NID_URL`, `NID_TOKEN` and `NID_DOMAIN` from the environment when no options are passed.
