# Providers reference

nid answers the HTTP APIs of these email providers, plus SMTP. Each one stores mail in the same inbox, so a test reads it the same way whichever path your app used.

| Provider | Name in the API | Routes |
| --- | --- | --- |
| [Resend](#resend) | `resend` | `POST /emails`, `POST /emails/batch`, `GET /emails/{id}` |
| [Brevo](#brevo) | `brevo` | `POST /v3/smtp/email` |
| [SMTP](#smtp) | `smtp` | Port 1025 |

SendGrid, Postmark, Mailgun and Amazon SES are planned. They are not supported yet.

All routes are on the HTTP port, 4400 by default. Any key value works, but it must be present and in the right place. A send that nid refuses gets the provider's own error status and body, and nid keeps it as a [rejection](read-api.md#get-apirejections).

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

## SMTP

| Setting | Value |
| --- | --- |
| Port | `1025` by default |
| TLS | None. `STARTTLS` is turned off. |
| Login | Optional. Any username and password work by default. |
| Size limit | 50 MB by default. Larger messages get SMTP error 552. |

Recipients come from the SMTP envelope (`RCPT TO`). A recipient in the `To` header is stored as `to`, one in `Cc` as `cc`, and any other as `bcc`. The envelope is kept in `meta.envelope`.

## Templates

When a Resend or Brevo send uses a template and has no body, nid has nothing to show but the template id and variables. It stores them in `meta.templateId` and `meta.variables`, and looks for a code and a link in the variables. Variables named `code`, `otp`, `token`, `passcode`, `pin` or `verification_code` are read as the code. Variables named `url`, `link`, `magic_link`, `verify_url` or `action_url` are read as the link.

## Adding a provider

Each provider is one file in `packages/server/src/providers/`. See [CONTRIBUTING.md](../../CONTRIBUTING.md#adding-a-provider).
