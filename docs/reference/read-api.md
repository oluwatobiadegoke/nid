# Read API reference

The read API is how tests, the CLI, the client library and the web view read mail. It is plain HTTP and JSON, so any language can use it.

Base URL: `http://127.0.0.1:4400` by default. All routes below are relative to it.

The server also describes these routes as an OpenAPI 3 document at `GET /api/openapi.json`.

## Common rules

- **Authentication.** By default no token is needed. When the server uses a custom `auth` function, send `Authorization: Bearer <token>`. A missing or wrong token gets `401 {"error": "Invalid or missing token"}`.
- **Addresses.** `to` matches one recipient address exactly, in any case. It matches To, Cc and Bcc recipients.
- **Strict query parameters.** An unknown parameter, such as a typo, gets a `400`, never a silent match-everything:

  ```json
  {"error": "Invalid query", "details": ["Unknown parameter: too"]}
  ```

- **Booleans** take `true`, `false`, `1` or `0`.
- **Message ids** go up by one for each stored message. A cursor is a message id: "after 41" means "messages with an id greater than 41".

## Routes

| Method and path | What it does |
| --- | --- |
| [`GET /api/cursor`](#get-apicursor) | Newest message id. |
| [`GET /api/wait`](#get-apiwait) | Waits for the next matching message. |
| [`GET /api/messages`](#get-apimessages) | Lists messages. |
| [`DELETE /api/messages`](#delete-apimessages) | Deletes messages. |
| [`GET /api/messages/{id}`](#get-apimessagesid) | One message in full. |
| [`GET /api/messages/{id}/attachments/{n}`](#get-apimessagesidattachmentsn) | Downloads an attachment. |
| [`GET /api/rejections`](#get-apirejections) | Sends nid refused. |
| [`GET /api/stream`](#get-apistream) | Live events. |
| [`GET /api/providers`](#get-apiproviders) | Providers this server answers. |
| [`GET /api/openapi.json`](#get-apiopenapijson) | The OpenAPI document. |
| [`GET /healthz`](#get-healthz) | Health check. |

### GET /api/cursor

Returns the id of the newest message, or `0` when there is none. Take it before your app sends an email, then pass it as `after` so only newer mail matches.

```json
{"cursor": 41}
```

### GET /api/wait

Holds the request open until a message that matches arrives, then returns the oldest match. If a match is already there, it returns at once.

| Parameter | Required | What it does |
| --- | --- | --- |
| `to` | Yes | Recipient address. |
| `after` | No | Only messages with an id greater than this. Without it, any message matches, including old ones. |
| `subject` | No | Part of the subject, in any case. |
| `provider` | No | `resend`, `brevo` or `smtp`. |
| `has_code` | No | Skip messages with no extracted code. |
| `code_pattern` | No | A regular expression, run without case, over the subject and plain text. Messages it does not match are skipped. Its first group, or the whole match, becomes `extracted.code` in the answer. |
| `timeout` | No | Seconds to wait, from 0 to 120. Default 30. |

On success: `200 {"message": Message}`.

On timeout: `404` with:

```json
{
  "timedOut": true,
  "error": "Timed out waiting for mail to ada@inbox.test after 30s. 1 resend request was rejected 2s ago with 422: Missing `from` field.",
  "messages": [],
  "recent_rejections": []
}
```

- `messages` holds up to 10 messages to the address after the cursor that did not match the other filters.
- `recent_rejections` holds up to 10 refused sends to the address from the minute before the wait started onward.

An invalid `code_pattern` gets a `400`.

### GET /api/messages

Lists messages, newest first.

| Parameter | What it does |
| --- | --- |
| `to` | Recipient address. |
| `subject` | Part of the subject, in any case. |
| `provider` | `resend`, `brevo` or `smtp`. |
| `after` | Only messages with an id greater than this. |
| `has_code` | Only messages with an extracted code. |
| `limit` | How many, from 1 to 500. Default 50. |

Returns `200 {"messages": [Message, ...]}`.

### DELETE /api/messages

Deletes messages. With `to`, only mail for that address. Without it, every message.

Returns `200 {"deleted": 3}`.

### GET /api/messages/{id}

Returns one message with its raw request: `200 {"message": Message}`, where the message also has `raw`. For HTTP sends, `raw` is the request body as received. For SMTP, it is the whole message source.

Returns `404` when there is no such message.

### GET /api/messages/{id}/attachments/{n}

Downloads attachment number `n` (counting from 0, as in `attachments[].n`) with its own content type. Returns `404` when there is no such attachment.

### GET /api/rejections

Lists sends nid refused, newest first.

| Parameter | What it does |
| --- | --- |
| `to` | Only refused sends addressed to this address. |
| `after` | Only rejections with an id greater than this. |
| `limit` | How many, from 1 to 500. Default 50. |

Returns `200 {"rejections": [Rejection, ...]}`, each with `raw`.

### GET /api/stream

A [server-sent events](https://developer.mozilla.org/docs/Web/API/Server-sent_events) stream. It sends:

| Event | Data |
| --- | --- |
| `ready` | `{"cursor": 41}`, once, when the stream opens. |
| `message` | A Message, for each new message. The event id is the message id. |
| `rejection` | A Rejection, for each new refused send. |
| `ping` | Empty, about every 20 seconds, to keep the connection open. |

| Parameter | What it does |
| --- | --- |
| `after` | Start after this message id instead of now. |

### GET /api/providers

Lists the provider APIs this server answers, with the setting that points each SDK at nid.

```json
{"providers": [{"name": "resend", "label": "Resend", "setup": {"env": "RESEND_BASE_URL=http://localhost:4400", "note": "..."}}]}
```

### GET /api/openapi.json

The OpenAPI 3 document for the read API.

### GET /healthz

Returns `200 {"ok": true, "version": "0.2.0"}` once the server is ready. It needs no token.

## Objects

### Message

| Field | Type | What it is |
| --- | --- | --- |
| `id` | integer | nid's id. Use it as a cursor. |
| `provider` | string | `resend`, `brevo` or `smtp`. |
| `providerId` | string | The id nid returned to your app, in the provider's format. |
| `from` | string | Sender, such as `Acme <hello@acme.com>`. |
| `replyTo` | string[] | Reply-to addresses. |
| `to`, `cc`, `bcc` | string[] | Recipient addresses, in lower case. |
| `recipients` | object[] | Each recipient as `{address, name, kind}`. |
| `subject` | string | Subject. |
| `text` | string or null | Plain text body. |
| `html` | string or null | HTML body. |
| `headers` | object | Headers from the send. For SMTP, every header of the message. |
| `attachments` | object[] | Each as `{n, filename, contentType, contentId, size, url}`. |
| `extracted` | object | `{code, codes, link, links}`. See the next table. |
| `meta` | object | Extra details, such as `templateId`, `variables`, `tags`, `scheduledAt`, or the SMTP `envelope`. |
| `createdAt` | string | ISO 8601 time nid stored it. |
| `expiresAt` | string or null | Set only when a retention limit applies. |
| `raw` | string | Only from `GET /api/messages/{id}`. |

`extracted` holds:

| Field | What it is |
| --- | --- |
| `code` | The most likely one-time code, or `null`. |
| `codes` | Every code-like token found, in order. |
| `link` | The most likely action link, skipping `mailto:`, `tel:`, images and unsubscribe links, or `null`. |
| `links` | Every link, as `{href, text}`. |

### Rejection

| Field | Type | What it is |
| --- | --- | --- |
| `id` | integer | nid's id for the rejection. |
| `provider` | string | Which API refused it. |
| `to` | string[] | Recipients in the refused send, when nid could read them. |
| `status` | integer | HTTP status nid returned. |
| `error` | string | The error message nid returned. |
| `createdAt` | string | ISO 8601 time. |
| `raw` | string | The request body. Only from `GET /api/rejections`. |
