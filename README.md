# nid

A local inbox that stands in for your email provider. Change one URL, and every email your app sends shows up in an inbox your tests can read.

Your app keeps its real code: the official Resend or Brevo SDK, or any SMTP client. You point its base URL at nid, and every send lands here instead of at the provider. Tests, the CLI and other tools then read the mail, with sign-in codes and links already pulled out.

**[Read the documentation](https://github.com/oluwatobiadegoke/nid/blob/main/docs/README.md)**, or start with the [ten-minute tutorial](https://github.com/oluwatobiadegoke/nid/blob/main/docs/tutorials/get-started.md).

## Quick start

You need Node.js 22.13 or later.

1. Start nid:

   ```sh
   npx nid-inbox serve
   ```

2. Start your app with its provider pointed at nid. For Resend:

   ```sh
   RESEND_BASE_URL=http://127.0.0.1:4400 npm run dev
   ```

3. Read the mail in a test:

   ```ts
   import { test, expect } from '@nid-inbox/client/playwright'

   test('sign up, then resend the code', async ({ page, inbox }) => {
     const email = inbox.address('signup')
     await page.fill('#email', email)
     await page.click('text=Send code')
     const first = await inbox.waitFor(email, { hasCode: true })
     await page.click('text=Resend code')
     const second = await inbox.waitFor(email, { hasCode: true })
     expect(second.code).not.toBe(first.code)
     await page.fill('#code', second.code!)
   })
   ```

Or open the web view at [http://127.0.0.1:4400](http://127.0.0.1:4400) to see the mail.

## What it does

- Answers the provider's own API, so each SDK only needs a base URL. Resend and Brevo today. SendGrid, Postmark, Mailgun and SES are next.
- Takes SMTP on port 1025 for everything else.
- Treats every address as an inbox. There is no "create inbox" step, so parallel tests never share mail.
- Pulls out one-time codes and links when mail arrives, and lets a test pass its own pattern.
- Holds a `wait` request open until the next matching email arrives, so tests have no polling loops or sleeps.
- Answers bad requests the way the real provider does, and keeps every refused send so a timed-out wait can explain itself.
- Keeps mail in memory by default. `--db mail.sqlite` keeps it across restarts.
- Listens on 127.0.0.1 only, and sends nothing out.

## Packages

| Package | What it is |
| --- | --- |
| [`nid-inbox`](https://www.npmjs.com/package/nid-inbox) | The server and the `nid` command. |
| [`@nid-inbox/client`](https://www.npmjs.com/package/@nid-inbox/client) | A small client for tests, with a Playwright fixture. |
| [`ghcr.io/oluwatobiadegoke/nid`](https://github.com/users/oluwatobiadegoke/packages/container/package/nid) | The Docker image. |

## Documentation

| Kind | Pages |
| --- | --- |
| Tutorial | [Get started](https://github.com/oluwatobiadegoke/nid/blob/main/docs/tutorials/get-started.md) |
| How-to guides | [Run nid](https://github.com/oluwatobiadegoke/nid/blob/main/docs/how-to/run-nid.md) (npm, Docker, Playwright, GitHub Actions), [Point your app at nid](https://github.com/oluwatobiadegoke/nid/blob/main/docs/how-to/connect-your-app.md), [Read mail in tests](https://github.com/oluwatobiadegoke/nid/blob/main/docs/how-to/read-mail-in-tests.md), [Use the command line](https://github.com/oluwatobiadegoke/nid/blob/main/docs/how-to/use-the-cli.md), [Embed nid in your own code](https://github.com/oluwatobiadegoke/nid/blob/main/docs/how-to/embed-nid.md) |
| Reference | [Command line](https://github.com/oluwatobiadegoke/nid/blob/main/docs/reference/cli.md), [Configuration](https://github.com/oluwatobiadegoke/nid/blob/main/docs/reference/configuration.md), [Read API](https://github.com/oluwatobiadegoke/nid/blob/main/docs/reference/read-api.md), [Client library](https://github.com/oluwatobiadegoke/nid/blob/main/docs/reference/client.md), [Providers](https://github.com/oluwatobiadegoke/nid/blob/main/docs/reference/providers.md) |
| Explanation | [How nid works](https://github.com/oluwatobiadegoke/nid/blob/main/docs/explanation/how-nid-works.md), [Security](https://github.com/oluwatobiadegoke/nid/blob/main/docs/explanation/security.md) |

## Contributing

Each provider is one file under `packages/server/src/providers/`, and docs change in the same pull request as the code. See [CONTRIBUTING.md](https://github.com/oluwatobiadegoke/nid/blob/main/CONTRIBUTING.md).

## License

Apache-2.0.
