# Point your app at nid

This guide shows how to send your app's email to nid instead of to your email provider. You change one setting. The rest of your app's code stays the same.

Before you start, [run nid](run-nid.md). The examples assume it is on `http://127.0.0.1:4400` and SMTP port `1025`.

Make this change only in your local and test settings. In production, your app should keep talking to the real provider.

## Resend

### Node.js

The Resend Node SDK reads the `RESEND_BASE_URL` environment variable. Set it when you start your app:

```sh
RESEND_BASE_URL=http://127.0.0.1:4400 npm run dev
```

Or pass it in code:

```js
import { Resend } from 'resend'

const resend = new Resend(process.env.RESEND_API_KEY, { baseUrl: 'http://127.0.0.1:4400' })
```

### Python

The Resend Python SDK reads `RESEND_API_URL`:

```sh
RESEND_API_URL=http://127.0.0.1:4400 python app.py
```

### Any other language

Send to `http://127.0.0.1:4400` with the same paths and bodies as the Resend API. nid supports:

- `POST /emails`
- `POST /emails/batch`
- `GET /emails/{id}`

See [Providers](../reference/providers.md#resend) for details.

## Brevo

### Node.js, SDK version 6 and later

Pass `baseUrl` when you create the client. The `/v3` is part of the base URL:

```js
import { BrevoClient } from '@getbrevo/brevo'

const brevo = new BrevoClient({
  apiKey: process.env.BREVO_API_KEY,
  baseUrl: 'http://127.0.0.1:4400/v3',
})
```

### Older Brevo SDKs

Set `basePath` on the API object:

```js
api.basePath = 'http://127.0.0.1:4400/v3'
```

### Any other language

Send `POST /v3/smtp/email` to `http://127.0.0.1:4400` with the same body as the Brevo API. Put your key in the `api-key` header.

## SMTP

Use SMTP for any library or framework that sends mail over SMTP, such as Nodemailer, Django, Rails Action Mailer or Laravel.

| Setting | Value |
| --- | --- |
| Host | `127.0.0.1` (or `localhost`) |
| Port | `1025` |
| TLS | Off |
| Username and password | Anything, or none |

For example, with Nodemailer:

```js
import nodemailer from 'nodemailer'

const transport = nodemailer.createTransport({ host: '127.0.0.1', port: 1025, secure: false })
```

nid uses the SMTP envelope to decide who received the message. Bcc recipients are stored too.

## API keys

Locally, any API key value works. But nid checks that a key is there and that it is the right kind:

- Resend needs `Authorization: Bearer <key>`.
- Brevo needs an `api-key` header.

A request with no key, or with the key in the wrong place, fails with the same status and body the real provider returns. This means a missing key in your config shows up in tests, not in production.

## Check that it works

Trigger an email in your app, then list what arrived:

```sh
npx nid-inbox read you@example.com
```

Or open the web view at [http://127.0.0.1:4400](http://127.0.0.1:4400).

If nothing arrived, list the sends nid refused:

```sh
curl http://127.0.0.1:4400/api/rejections
```

Each entry shows the error nid returned to your app. If that list is empty too, your app is still sending to the real provider. Check that the base URL setting reaches the process that sends the mail.

## Related

- [Providers reference](../reference/providers.md)
- [Read mail in tests](read-mail-in-tests.md)
