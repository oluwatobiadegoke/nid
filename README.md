# nid

A local inbox that stands in for your email provider. Change one URL, and every email your app sends shows up in an inbox your tests can read.

Your app keeps its real code: the official Resend, Brevo, SendGrid, Postmark or Mailgun SDK, or any SMTP client. You point its base URL at nid, and every send lands here instead of at the provider. Tests, the CLI and AI agents then read the mail, with sign-in codes and links already pulled out.

```
npx nid-inbox serve
```

```
RESEND_BASE_URL=http://localhost:4400 npm run dev
```

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
  await page.fill('#code', second.code)
})
```

## What it does

- Answers the provider's own API on one port, so each SDK only needs a base URL. Resend, Brevo, SendGrid, Postmark and Mailgun today; SES is next.
- Takes SMTP on port 1025 for everything else.
- Stores every email keyed by recipient address. There is no "create inbox" step: a test makes up an address and reads it, so parallel tests never share mail.
- Pulls out one-time codes and links on arrival, and lets a test pass its own pattern when the guess is wrong.
- Holds a `wait` request open until the next matching email arrives, so tests have no polling loops or sleeps.
- Answers like the real provider on bad requests, so the SDK raises its own typed error, and keeps every refused send so a timed-out wait can explain itself.
- Shows the mail in a small web view at [http://localhost:4400](http://localhost:4400).
- Keeps nothing by default: mail lives in memory until the server stops. `--db mail.sqlite` keeps it across restarts.

## Run it

| Way | How |
| --- | --- |
| npx | `npx nid-inbox serve` |
| Docker | `docker run -p 127.0.0.1:4400:4400 -p 127.0.0.1:1025:1025 ghcr.io/oluwatobiadegoke/nid` |
| Playwright | Add it to `webServer` in `playwright.config.ts` (below) |
| GitHub Actions | Use the image as a job `services:` container |

```ts
// playwright.config.ts
webServer: [
  { command: 'npx nid-inbox serve', port: 4400, reuseExistingServer: true },
  { command: 'npm run dev', port: 3000, reuseExistingServer: true },
],
```

Options: `--port 4400`, `--smtp-port 1025`, `--host 127.0.0.1`, `--db mail.sqlite`, `--cors`, `--allow-host <name>`. The same settings read from `NID_PORT`, `NID_SMTP_PORT`, `NID_HOST` and `NID_DB`.

## Point your app at it

| Provider | Setting |
| --- | --- |
| Resend | `RESEND_BASE_URL=http://localhost:4400` (Node), `RESEND_API_URL` (Python) |
| Brevo | `new BrevoClient({ apiKey, baseUrl: 'http://localhost:4400/v3' })`, or `api.basePath = 'http://localhost:4400/v3'` on older SDKs |
| SendGrid | `sgMail.client.setDefaultRequest('baseUrl', 'http://localhost:4400')`, after `sgMail.setApiKey` |
| Postmark | `new postmark.ServerClient(token, { useHttps: false, requestHost: 'localhost:4400' })` |
| Mailgun | `mailgun.client({ username: 'api', key, url: 'http://localhost:4400' })` |
| SMTP | Host `localhost`, port `1025`, no TLS, any username and password |

Locally any API key works, but a request with no key, or the wrong kind of key, fails exactly as it would in production.

## Read the mail

Every client is a thin wrapper over the read API, so every language behaves the same.

### From tests

```ts
import { createInbox } from '@nid-inbox/client'

const inbox = createInbox({ url: 'http://localhost:4400' })
await inbox.start()

const email = inbox.address('signup')
const message = await inbox.waitFor(email, { hasCode: true, timeout: 30 })
message.code
message.link
message.links
message.subject
message.text
```

`waitFor` remembers the cursor per address, so a second call on the same address returns the next email, never the first one again. `start()` takes a cursor at the start of a test so leftovers from an earlier run never match. Pass `{ after }` to override it, `{ subject }` to pick one of two emails sent close together, or `{ codePattern: /key is (\w+)/ }` to pull out something the built-in extraction does not know.

### From the command line

```
nid read signup.8f3a@inbox.test               # list mail for an address
nid read signup.8f3a@inbox.test --latest      # the newest message in full
nid read signup.8f3a@inbox.test --latest --code    # just the code, for piping
nid read signup.8f3a@inbox.test --latest --links   # just the links
nid read signup.8f3a@inbox.test --wait 30     # wait for the next one
nid clear [address]
nid healthcheck
```

### From anything else

| Route | What it does |
| --- | --- |
| `GET /api/cursor` | Newest message id. Take it before triggering an email. |
| `GET /api/wait?to=&after=&subject=&has_code=&code_pattern=&timeout=` | Holds the request open until the first matching message after the cursor arrives. On timeout: 404 with what did arrive and recent rejections. |
| `GET /api/messages?to=&subject=&provider=&after=&limit=` | Lists messages, newest first. |
| `GET /api/messages/{id}` | One message in full, with the request as received. |
| `GET /api/messages/{id}/attachments/{n}` | Downloads an attachment. |
| `GET /api/rejections?to=` | Sends the server refused, with the exact error. |
| `DELETE /api/messages?to=` | Clears one address, or everything. |
| `GET /api/stream` | Server-sent events of new messages and rejections. |
| `GET /healthz` | 200 and the version once ready. |
| `GET /api/openapi.json` | The spec. |

A typo in a query parameter is a 400, not a silent match-everything.

## Safe by default

It listens on 127.0.0.1 only, sends no CORS headers unless you pass `--cors`, and answers only requests whose Host is an IP, `localhost` or a name without a dot (such as a Compose service name), so a web page cannot point its own domain at your inbox. Email HTML renders in a sandboxed iframe with scripts blocked. There is no telemetry.

## Use it as a library

```ts
import { createServer } from 'nid-inbox'

const server = await createServer({ store, auth, limits })
await server.listen({ port: 4400, smtpPort: 1025 })
```

`store` is where mail lives (SQLite by default; the same queries run on Postgres), `auth` maps a credential to a project, and `limits` sets body size and retention per project. Locally each has a one-line default. Every query carries a `project_id`, so one server can hold many projects.

## Contributing

Each provider is one file under `packages/server/src/providers/`. See [CONTRIBUTING.md](CONTRIBUTING.md).

Apache-2.0.
