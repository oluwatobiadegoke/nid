# Providers reference

nid answers the HTTP APIs of these email providers, plus SMTP. Each one stores mail in the same inbox, so a test reads it the same way whichever path your app used.

| Provider | Name in the API | Routes |
| --- | --- | --- |
| [Resend](#resend) | `resend` | `POST /emails`, `POST /emails/batch`, `GET /emails/{id}` |
| [Brevo](#brevo) | `brevo` | `POST /v3/smtp/email` |
| [SendGrid](#sendgrid) | `sendgrid` | `POST /v3/mail/send` |
| [Postmark](#postmark) | `postmark` | `POST /email`, `POST /email/batch`, `POST /email/withTemplate`, `POST /email/batchWithTemplates` |
| [Mailgun](#mailgun) | `mailgun` | `POST /v3/{domain}/messages`, `POST /v3/{domain}/messages.mime` |
| [SMTP](#smtp) | `smtp` | Port 1025 |

All routes are on the HTTP port, 4400 by default. Any key value works, but it must be present and in the right place. A send that nid refuses gets the provider's own error status and body, and nid keeps it as a [rejection](read-api.md#get-apirejections). The rejection lists every `to`, `cc` and `bcc` address nid can read from the request, so a test waiting on any of them sees why its mail never came.

## Resend

Point the SDK at nid with `RESEND_BASE_URL=http://127.0.0.1:4400` (Node.js) or `RESEND_API_URL=http://127.0.0.1:4400` (Python).

**Key:** `Authorization: Bearer <any key>`. Without it: `401 {"statusCode": 401, "name": "missing_api_key", ...}`.

### POST /emails

Sends one email. Returns `200 {"id": "<uuid>"}`.

nid checks, in the same way Resend does:

| Check | Error |
| --- | --- |
| `to` is present, with at most 50 addresses | `422 validation_error` |
| `from` is present, unless `template` is set | `422 Missing \`from\` field.` |
| `subject` is present, unless `template` is set | `422 Missing \`subject\` field.` |
| `html` or `text` is present, unless `template` or `react` is set | `422 Missing \`html\` or \`text\` field.` |
| Every address is `email@example.com` or `Name <email@example.com>` | `422 Invalid \`to\` field. ...` |

Also stored: `cc`, `bcc`, `reply_to`, `headers`, `attachments` (base64 `content`, or a `path` used for the file name), `tags`, `scheduled_at`, `template` (its `id` and `variables` go into `meta`) and `topic_id`.

An `Idempotency-Key` header works like Resend's: a repeat send with the same key returns the first email instead of storing a new one.

### POST /emails/batch

Sends up to 100 emails in one request. The body is a JSON array of `POST /emails` bodies. Returns `200 {"data": [{"id": "..."}, ...]}`. If any email fails a check, the whole batch is refused.

### GET /emails/{id}

Returns an email sent through nid, in Resend's shape, with `last_event` set to `delivered`. Returns `404 not_found` for an unknown id.

## Brevo

Point the SDK at nid with `baseUrl: 'http://127.0.0.1:4400/v3'` (SDK version 6 and later) or `api.basePath = 'http://127.0.0.1:4400/v3'` (older SDKs). The `/v3` is part of the base URL.

**Key:** `api-key: <any key>` header. Without it: `401 {"code": "unauthorized", "message": "Key not found"}`.

### POST /v3/smtp/email

Sends a transactional email. Returns `201 {"messageId": "<...@smtp-relay.mailin.fr>"}`, or `201 {"messageIds": [...]}` when the body has more than one `messageVersions` entry.

nid checks, in the same way Brevo does:

| Check | Error |
| --- | --- |
| `to` has at least one contact | `400 missing_parameter: to is missing` |
| `sender.email` is present, unless `templateId` is set | `400 missing_parameter: sender is missing` |
| `subject` is present, unless `templateId` is set | `400 missing_parameter: subject is missing` |
| `htmlContent` or `textContent` is present, unless `templateId` is set | `400 missing_parameter` |
| Every contact email looks like an address | `400 invalid_parameter` |

Also stored: `cc`, `bcc`, `replyTo`, `headers`, `attachment`, `tags`, `scheduledAt`, `batchId`, `params`, and `templateId` (with `params` as `meta.variables`). Each `messageVersions` entry becomes its own message.

A send with the `X-Sib-Sandbox` header is stored with `meta.sandbox` set to `true`.

## SendGrid

Point the SDK at nid with `sgMail.client.setDefaultRequest('baseUrl', 'http://127.0.0.1:4400')`. Call it after `sgMail.setApiKey`, because `setApiKey` resets the base URL.

**Key:** `Authorization: Bearer <any key>`. Without it: `401 {"errors": [{"message": "The provided authorization grant is invalid, expired, or revoked", ...}]}`.

### POST /v3/mail/send

Sends one email per entry in `personalizations`. Returns `202` with an empty body and an `X-Message-Id` header. Each stored message has the provider id `<X-Message-Id>.<n>`, where `n` is the index of its personalization.

nid checks, in the same way SendGrid does:

| Check | Error |
| --- | --- |
| `personalizations` has at least one entry | `400`, field `personalizations` |
| Every personalization has at least one `to` | `400`, field `personalizations.{n}.to` |
| `from.email` is present | `400`, field `from.email` |
| `subject` is present, at the top or in the personalization, unless `template_id` is set | `400`, field `subject` |
| `content` has a value, unless `template_id` is set | `400`, field `content` |
| Every `email` is a bare address, without a display name | `400 Does not contain a valid address.` |
| No address appears twice across `to`, `cc` and `bcc` of one personalization | `400`, field `personalizations.{n}.to`, `.cc` or `.bcc` |
| `reply_to` and `reply_to_list` are not both set | `400`, field `reply_to` |
| A `text/plain` block, if any, comes first in `content` | `400`, field `content.0.type` |
| No `content` block has an empty `value` | `400`, field `content.{n}.value` |

Errors have SendGrid's shape: `{"errors": [{"message", "field", "help"}]}`.

Also stored: `cc`, `bcc`, `reply_to` or `reply_to_list`, `headers` (personalization headers win), `attachments` (with `content_id` when `disposition` is `inline`), `categories` as `meta.tags`, `custom_args`, `send_at`, `batch_id`, and `template_id`. A personalization's `dynamic_template_data` becomes `meta.variables`. Its `substitutions` are replaced in the subject and body, as SendGrid does. Without `dynamic_template_data`, the substitutions also become `meta.variables`, with wrappers such as `{{ }}` taken off the keys, so a legacy template send with no body still yields its code. A send with `mail_settings.sandbox_mode.enable` is stored with `meta.sandbox` set to `true`.

## Postmark

Point the SDK at nid with `new postmark.ServerClient(token, { useHttps: false, requestHost: '127.0.0.1:4400' })`. `requestHost` is a host and port, not a URL.

**Key:** `X-Postmark-Server-Token: <any key>` header. Without it: `401 {"ErrorCode": 10, "Message": "No Account or Server API tokens were supplied ..."}`.

### POST /email

Sends one email. Returns `200 {"To", "SubmittedAt", "MessageID", "ErrorCode": 0, "Message": "OK"}`.

`To`, `Cc`, `Bcc` and `ReplyTo` are comma-separated strings, as in Postmark. A field set to `null` counts as not set. nid checks:

| Check | Error |
| --- | --- |
| The body is a JSON object | `422 {"ErrorCode": 402}` |
| `To`, `Cc` or `Bcc` has at least one address | `422 {"ErrorCode": 300, "Message": "Zero recipients specified"}` |
| `From` is an address | `422 {"ErrorCode": 300}` |
| `HtmlBody` or `TextBody` is present | `422 {"ErrorCode": 300}` |
| Every address in `To`, `Cc`, `Bcc` and `ReplyTo` looks like an address | `422 {"ErrorCode": 300}` |

Also stored: `Headers`, `Attachments` (a `cid:` prefix on `ContentID` is dropped), `Tag` as `meta.tags`, `Metadata` and `MessageStream`.

### POST /email/withTemplate

Like `POST /email`, but needs `TemplateId` or `TemplateAlias` instead of a body (`422 {"ErrorCode": 1101}` without one). `TemplateModel` becomes `meta.variables`.

### POST /email/batch

Sends up to 500 emails. The body is a JSON array of `POST /email` bodies. Returns `200` with one result per email, in order. An email that fails a check gets its `ErrorCode` and `Message` in its slot and is kept as a rejection. The others are still sent, as in Postmark.

### POST /email/batchWithTemplates

Like `POST /email/batch`, with `{"Messages": [...]}` of `POST /email/withTemplate` bodies.

The Postmark routes also answer with a trailing slash, such as `/email/withTemplate/`, which some clients send. The bulk API (`POST /email/bulk`) is not supported yet.

## Mailgun

Point the SDK at nid with `mailgun.client({ username: 'api', key, url: 'http://127.0.0.1:4400' })`. Leave out `/v3`.

**Key:** HTTP Basic auth with user `api` and any key as the password. Without it, or with another user name: `401 Forbidden` (plain text).

### POST /v3/{domain}/messages

Sends an email from a `multipart/form-data` or `application/x-www-form-urlencoded` form. Returns `200 {"id": "<...@{domain}>", "message": "Queued. Thank you."}`.

`to`, `cc` and `bcc` can repeat, and each value can hold comma-separated addresses. nid checks:

| Check | Error |
| --- | --- |
| `from` is present | `400 {"message": "'from' parameter is missing"}` |
| `from` is an address | `400 {"message": "from parameter is not a valid address. please check documentation"}` |
| `to` has at least one address | `400 {"message": "'to' parameter is missing"}` |
| `text`, `html` or `template` is present | `400 {"message": "Need at least one of 'text', 'html' or 'template' parameters specified"}` |
| Every address looks like an address | `400 {"message": "... is not a valid address ..."}` |
| `t:variables`, `h:X-Mailgun-Variables` and `recipient-variables` are JSON objects | `400` |
| `to` has at most 1,000 addresses | `400` |

Also stored: `h:` fields as headers (`h:Reply-To` sets the reply-to), `v:` fields as `meta.customVariables`, `o:tag` as `meta.tags`, `o:deliverytime`, `attachment` and `inline` files, and the domain as `meta.domain`. `template` is stored as `meta.templateId`. For a template send, the `v:` fields, `h:X-Mailgun-Variables` and `t:variables` are merged into `meta.variables`, with `t:variables` winning. A send with `o:testmode` set to `yes` is stored with `meta.sandbox` set to `true`.

### POST /v3/{domain}/messages.mime

Sends a message you built yourself, for example with Nodemailer. The form needs `to` and a `message` field that holds the MIME message, as a file or a string. nid reads the subject, body, headers and attachments from the MIME message, and the `o:`, `v:` and `h:` fields as for `POST /v3/{domain}/messages`.

### Batch sends

With `recipient-variables` on `POST /v3/{domain}/messages`, each `to` address gets its own message, and `%recipient.<key>%` in the subject, body, `h:` headers and `v:` fields is replaced with that address's value, as in a Mailgun batch send.

## SMTP

| Setting | Value |
| --- | --- |
| Port | `1025` by default |
| TLS | None. `STARTTLS` is turned off. |
| Login | Optional. Any username and password work by default. |
| Size limit | 50 MB by default. Larger messages get SMTP error 552. |

Recipients come from the SMTP envelope (`RCPT TO`). A recipient in the `To` header is stored as `to`, one in `Cc` as `cc`, and any other as `bcc`. The envelope is kept in `meta.envelope`.

## Templates

When a send uses a template and has no body, nid has nothing to show but the template id and variables. It stores them in `meta.templateId` and `meta.variables`, and looks for a code and a link in the variables. Variables named `code`, `otp`, `token`, `passcode`, `pin` or `verification_code` are read as the code. Variables named `url`, `link`, `magic_link`, `verify_url` or `action_url` are read as the link.

## Webhooks

[`POST /api/messages/{id}/events`](read-api.md#post-apimessagesidevents) sends the provider's webhook for a message to your app. See [Test your webhook handler](../how-to/test-webhooks.md). Each event becomes the provider's own:

| nid event | Resend | Brevo | SendGrid | Postmark | Mailgun |
| --- | --- | --- | --- | --- | --- |
| `delivered` | `email.delivered` | `delivered` | `delivered` | `Delivery` | `delivered` |
| `deferred` | `email.delivery_delayed` | `deferred` | `deferred` | `Bounce`, type `Transient` | `failed`, severity `temporary` |
| `bounced` | `email.bounced`, type `Permanent` | `hard_bounce` | `bounce` | `Bounce`, type `HardBounce` | `failed`, severity `permanent` |
| `complained` | `email.complained` | `spam` | `spamreport` | `SpamComplaint` | `complained` |
| `opened` | `email.opened` | `opened` | `open` | `Open` | `opened` |
| `clicked` | `email.clicked` | `click` | `click` | `Click` | `clicked` |

The payload carries the ids your app got back when it sent, so it can find the email:

| Provider | Id in the payload | Also copied from the send | Signed with |
| --- | --- | --- | --- |
| Resend | `data.email_id` | `tags` | Svix headers (`svix-id`, `svix-timestamp`, `svix-signature`) made with your `whsec_` secret. |
| Brevo | `message-id` | `X-Mailin-custom` header, `tags` | Not signed. With a secret, `Authorization: Bearer <secret>`. |
| SendGrid | `sg_message_id`, which starts with the `X-Message-Id` | `custom_args`, categories as `category` | nid's test key. See below. |
| Postmark | `MessageID` | `Tag`, `Metadata`, `MessageStream` | Not signed. A user and password in the URL become basic auth. |
| Mailgun | `message.headers.message-id`, without `<` and `>` | `v:` variables as `user-variables`, `tags` | `signature.signature`, an HMAC-SHA256 of `timestamp` and `token` with your signing key. |

### SendGrid webhooks

SendGrid signs with a private key only SendGrid has, so nid signs with its own fixed test key instead. In your app's test settings, use nid's public key as SendGrid's verification key:

```
MFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAEiu0d91rTdUCRS7HAXf1YGhnOMjooYTGohQqZPwtGLgqjnlxvzX4vUEWKixV3RiaKqlWDo25D126LGigNAxvnvQ==
```

The `nid-inbox` package exports it as `sendgridWebhookPublicKey`. The key is public on purpose, so never trust it outside tests.

## Adding a provider

Each provider is one file in `packages/server/src/providers/`. See [CONTRIBUTING.md](../../CONTRIBUTING.md#adding-a-provider).
