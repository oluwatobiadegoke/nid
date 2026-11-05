# nid

Your own inbox for the emails your app sends.

nid runs on your computer. Your app sends its emails to nid instead of to your email provider, and you read them in a web page that only you can see. You do not need a public inbox site such as Yopmail, and you do not sign up for anything. Your tests can read the same emails.

**[Read the documentation](https://github.com/oluwatobiadegoke/nid/blob/main/docs/README.md)**, or start with the [ten-minute tutorial](https://github.com/oluwatobiadegoke/nid/blob/main/docs/tutorials/get-started.md).

## Quick start

You need Node.js 22.13 or later.

1. Start nid:

   ```sh
   npx nid-inbox serve
   ```

2. Start your app with its email provider pointed at nid. For Resend:

   ```sh
   RESEND_BASE_URL=http://127.0.0.1:4400 npm run dev
   ```

3. Open [http://127.0.0.1:4400](http://127.0.0.1:4400) in your browser. Every email your app sends appears there as it arrives.

## Read mail in tests

The same emails are available to your tests. In Playwright:

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

## What it does

- Shows every email your app sends in a web page, as it arrives. You see the sender, the recipients, the HTML, the text, the attachments, and the sign-in code and link nid found.
- Keeps your mail on your machine. It listens on 127.0.0.1 only and sends nothing out, so no one else can read it.
- Answers the provider's own API, so each SDK only needs a base URL. Resend and Brevo today. SendGrid, Postmark, Mailgun and SES are next.
- Takes SMTP on port 1025 for everything else.
- Shows the sends it refused, with the error your app got, so you can see why an email never arrived.
- Lets tests and scripts read the same mail, with a `wait` request that returns as soon as the next email arrives.
- Treats every address as an inbox. There is no "create inbox" step.
- Keeps mail in memory by default. `--db mail.sqlite` keeps it across restarts.

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
| How-to guides | [See your mail in the web view](https://github.com/oluwatobiadegoke/nid/blob/main/docs/how-to/use-the-web-view.md), [Run nid](https://github.com/oluwatobiadegoke/nid/blob/main/docs/how-to/run-nid.md) (npm, Docker, Playwright, GitHub Actions), [Point your app at nid](https://github.com/oluwatobiadegoke/nid/blob/main/docs/how-to/connect-your-app.md), [Read mail in tests](https://github.com/oluwatobiadegoke/nid/blob/main/docs/how-to/read-mail-in-tests.md), [Use the command line](https://github.com/oluwatobiadegoke/nid/blob/main/docs/how-to/use-the-cli.md), [Embed nid in your own code](https://github.com/oluwatobiadegoke/nid/blob/main/docs/how-to/embed-nid.md) |
| Reference | [Command line](https://github.com/oluwatobiadegoke/nid/blob/main/docs/reference/cli.md), [Configuration](https://github.com/oluwatobiadegoke/nid/blob/main/docs/reference/configuration.md), [Read API](https://github.com/oluwatobiadegoke/nid/blob/main/docs/reference/read-api.md), [Client library](https://github.com/oluwatobiadegoke/nid/blob/main/docs/reference/client.md), [Providers](https://github.com/oluwatobiadegoke/nid/blob/main/docs/reference/providers.md) |
| Explanation | [How nid works](https://github.com/oluwatobiadegoke/nid/blob/main/docs/explanation/how-nid-works.md), [Security](https://github.com/oluwatobiadegoke/nid/blob/main/docs/explanation/security.md) |

## Contributing

Each provider is one file under `packages/server/src/providers/`, and docs change in the same pull request as the code. See [CONTRIBUTING.md](https://github.com/oluwatobiadegoke/nid/blob/main/CONTRIBUTING.md).

## License

Apache-2.0.
