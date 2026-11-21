# Configuration reference

nid has no config file. You set it with command line options, environment variables, or options to `createServer` when you [embed it](../how-to/embed-nid.md).

## Environment variables

| Variable | Read by | Default | What it sets |
| --- | --- | --- | --- |
| `NID_PORT` | `nid serve` | `4400` | HTTP port. |
| `NID_SMTP_PORT` | `nid serve` | `1025` | SMTP port. |
| `NID_HOST` | `nid serve` | `127.0.0.1` | Address both servers listen on. |
| `NID_DB` | `nid serve` | none (memory) | SQLite file to keep mail in. |
| `NID_URL` | `nid read`, `nid clear`, `nid webhook`, `nid mcp`, `nid healthcheck`, `@nid-inbox/client` | `http://127.0.0.1:4400` | Server to talk to. |
| `NID_TOKEN` | `nid read`, `nid clear`, `nid webhook`, `nid mcp`, `nid healthcheck`, `@nid-inbox/client` | none | Token sent as `Authorization: Bearer <token>`. Only needed when the server uses a custom `auth` function. |
| `NID_DOMAIN` | `@nid-inbox/client` | `inbox.test` | Domain for addresses made by `inbox.address()`. |
| `NID_INTERCEPT` | `nid-inbox/intercept` | enabled when `NID_URL` is set | Set to `0` to turn off automatic Node.js HTTP interception when preloading `nid-inbox/intercept`. |
| `NID_<PROVIDER>_WEBHOOK_URL` | `nid serve` | none | Your app's webhook route for that provider, such as `NID_BREVO_WEBHOOK_URL`. It must start with `http://` or `https://`, or nid stops at startup. `<PROVIDER>` is `RESEND`, `BREVO`, `SENDGRID`, `POSTMARK`, `MAILGUN` or `SES`. See [Test your webhook handler](../how-to/test-webhooks.md). |
| `NID_<PROVIDER>_WEBHOOK_SECRET` | `nid serve` | none | The secret your app checks webhooks with, such as `NID_RESEND_WEBHOOK_SECRET`. What it is depends on the provider. |
| `NID_AUTO_WEBHOOK` | `nid serve`, `nid run` | none | Webhook event (`delivered`, `deferred`, `bounced`, `complained`, `opened` or `clicked`) to fire automatically after each send when a webhook URL is set. |

A command line option wins over its environment variable. An option passed in code wins over the environment variable for the client.

## Docker image defaults

The image `ghcr.io/oluwatobiadegoke/nid` sets:

| Variable | Value |
| --- | --- |
| `NID_HOST` | `0.0.0.0` |
| `NID_PORT` | `4400` |
| `NID_SMTP_PORT` | `1025` |

It runs `nid serve` by default. Anything after the image name replaces `serve`, so `docker run ghcr.io/oluwatobiadegoke/nid serve --db /data/mail.sqlite` passes extra options.

## createServer options

`createServer(options)` from the `nid-inbox` package takes:

| Option | Type | Default | What it does |
| --- | --- | --- | --- |
| `store` | `Store` | In-memory store (5,000 messages and 1,000 rejections per project, 100 webhook deliveries per message) | Where mail lives. Oldest entries are evicted past the cap. Make a SQLite store with `createSqliteStore({ path })`. |
| `events` | `EventBus` | In-memory event bus | Publishes and listens for message, rejection and webhook events. |
| `faults` | `FaultStore` | In-memory fault store | Stores active fault and latency rules for `/api/faults`. |
| `auth` | `(credential) => Project \| null` | Every credential maps to the `default` project | Maps a provider key, read API token or SMTP username to a project. Return `null` to refuse. Can return a promise. |
| `limits` | `(project) => Limits` | `{ maxBodyBytes: 52428800, retentionHours: null }` | Per-project limits. Can return a promise. See the note below. |
| `providers` | `Provider[]` | All six: Resend, Brevo, SendGrid, Postmark, Mailgun and Amazon SES | Which provider APIs to answer. |
| `allowHosts` | `string[]` | `[]` | Extra `Host` names to accept. Same as `--allow-host`. |
| `cors` | `string[]` | `[]` | Origins whose web pages may call nid, such as `['http://localhost:3000']`. Same as `--cors`. `createServer` throws on a value that is not an `http://` or `https://` URL. |
| `ui` | `boolean` | `true` | Serves the web view at `/`. |
| `maxBodyBytes` | `number` | `52428800` (50 MB) | Largest HTTP body or SMTP message accepted. Larger HTTP bodies get a 413. |
| `webhooks` | `Record<string, { url, secret? }>` | `{}` | Your app's webhook route and secret per provider name, such as `{ brevo: { url, secret } }`. Same as the `NID_<PROVIDER>_WEBHOOK_*` variables. `createServer` throws on a name that is not a provider or a URL that is not `http://` or `https://`. |
| `magicAddresses` | `boolean` | `true` locally (`false` when `auth` is set) | Enables the special addresses at `inbox.test`, such as `bounce@inbox.test` and `ratelimit@inbox.test`. |
| `autoWebhook` | `WebhookEvent` | none | Automatically fires this webhook event after each stored send when a webhook target is configured. |
| `onMessage` | `(message) => void` | none | Called after each message is stored. |
| `onError` | `(error) => void` | none | Called on unexpected server errors. |

A `credential` has `kind` (`http` or `smtp`), `provider` (`resend`, `brevo`, `sendgrid`, `postmark`, `mailgun`, `ses`, `smtp` or `api` for the read API) and `value` (the key, token or username; for Mailgun, the Basic auth password; for SES, the SigV4 access key id). A `Project` has `projectId` and `plan`.

Note on `limits.retentionHours`: when set, nid stamps each new message with an `expiresAt` time. Expired messages are hidden on read and deleted every minute.

### server.listen(options)

| Option | Default |
| --- | --- |
| `port` | `4400` |
| `smtpPort` | `1025` (or `false` to skip SMTP) |
| `host` | `127.0.0.1` |

It returns `{ url, host, port, smtpPort, close() }`. `port` and `smtpPort` are the real ports, which matters when you pass `0`.

### Other server properties

| Property | What it is |
| --- | --- |
| `server.app` | The Hono app. Call `server.app.request(path, init)` to send a request without a network. |
| `server.store` | The store passed in or created. |
| `server.events` | The event bus passed in or created. |
| `server.version` | The package version. |
| `server.close()` | Stops the listeners and closes the store. |
