# Client library reference

`@nid-inbox/client` reads mail from a nid server. It has no dependencies and needs Node.js 22.13 or later.

```sh
npm install --save-dev @nid-inbox/client
```

It has two entry points:

| Import from | What you get |
| --- | --- |
| `@nid-inbox/client` | `createInbox`, `Inbox`, `InboxError`, `InboxTimeoutError` and the types. |
| `@nid-inbox/client/playwright` | A Playwright `test` with an `inbox` fixture, plus `expect` and everything above. Needs `@playwright/test` 1.40 or later. |

## createInbox(options)

Returns a new `Inbox`. Same as `new Inbox(options)`.

| Option | Default | What it does |
| --- | --- | --- |
| `url` | `NID_URL`, then `http://127.0.0.1:4400` | Server to read from. |
| `token` | `NID_TOKEN` | Sent as `Authorization: Bearer <token>`. Only needed when the server uses a custom `auth` function. |
| `domain` | `NID_DOMAIN`, then `inbox.test` | Domain for `address()`. |
| `fetch` | The global `fetch` | A `fetch` to use instead, for example in tests of the client itself. |

## Inbox

### Properties

| Property | What it is |
| --- | --- |
| `url` | The server URL, without a trailing slash. |
| `domain` | The domain used by `address()`. |

### address(prefix?, options?)

Returns a new random address. It does not call the server.

```ts
inbox.address('Sign Up')
```

```
sign-up.6aaee5fd@inbox.test
```

The prefix is lower-cased and anything other than letters, digits, `.`, `_` and `-` becomes `-`. The default prefix is `test`. Pass `{ domain }` to use another domain for this address.

### start()

Takes the current cursor and forgets every per-address cursor. After `start()`, `waitFor` only returns mail that arrives later. Call it at the start of each test. The Playwright fixture calls it for you.

Returns the cursor as a number.

### cursor()

Returns the newest message id on the server, or `0`.

### waitFor(address, options?)

Waits for the next message to `address` that matches, and returns it as an `Email`.

| Option | What it does |
| --- | --- |
| `after` | Only messages with an id greater than this. Overrides the remembered cursor. |
| `subject` | Part of the subject, in any case. |
| `provider` | `resend`, `brevo`, `sendgrid`, `postmark`, `mailgun` or `smtp`. |
| `hasCode` | Skip messages with no code. |
| `codePattern` | A `RegExp` or string. Skips messages it does not match. Its first group, or the whole match, becomes `code`. Flags on a `RegExp` are dropped; matching ignores case. |
| `timeout` | Seconds to wait, from 0 to 120. Default 30. |

Which messages count, in order:

1. Messages after `options.after`, when you pass it.
2. Otherwise, messages after the last one `waitFor` returned for this address.
3. Otherwise, messages after the cursor from `start()`.
4. Otherwise, any message.

Throws `InboxTimeoutError` when nothing matches in time, and `InboxError` for other failures.

### list(options?)

Returns up to `limit` messages, newest first, as `Email[]`. Options: `to`, `subject`, `provider`, `after`, `hasCode`, `limit` (1 to 500, default 50).

### get(id)

Returns one message as a `FullEmail`, which adds `raw`: the request body as received, or the SMTP source.

### rejections(to?)

Returns refused sends as `Rejection[]`, newest first. With `to`, only those addressed to that address.

### clear(address?)

Deletes mail for `address`, or every message when you leave it out. Also forgets the matching cursors. Returns how many messages it deleted.

### triggerWebhook(id, type)

Sends the provider's webhook for message `id` to your app and returns your app's answer as `{ url, delivered, appStatus, appBody, durationMs, error? }`. `type` is `'delivered'`, `'deferred'`, `'bounced'`, `'complained'`, `'opened'` or `'clicked'`. A 4xx or 5xx from your app is not an error: check `delivered` or `appStatus`. It throws `InboxError` when nid cannot send it, for example when no webhook URL is set. See [Test your webhook handler](../how-to/test-webhooks.md).

## Email

An `Email` is a [Message](read-api.md#message) with three shortcuts copied from `extracted`:

| Field | Type |
| --- | --- |
| `code` | `string \| null` |
| `link` | `string \| null` |
| `links` | `{ href: string, text: string }[]` |

## Errors

### InboxError

Thrown when the server answers with an error or cannot be reached.

| Property | What it is |
| --- | --- |
| `message` | What went wrong. |
| `status` | The HTTP status, or `0` when the server could not be reached. |
| `details` | Extra lines from the server, such as `Unknown parameter: too`. |

### InboxTimeoutError

Extends `InboxError` with `status` 404. Thrown by `waitFor` when nothing matched in time.

| Property | What it is |
| --- | --- |
| `message` | A sentence that says what arrived and which sends were refused. |
| `address` | The address it waited on. |
| `messages` | Mail to the address that did not match the filters. |
| `rejections` | Recent refused sends to the address. |

## Playwright fixture

```ts
import { test, expect } from '@nid-inbox/client/playwright'
```

| Name | Scope | What it is |
| --- | --- | --- |
| `inbox` | Test | A new `Inbox` for each test, with `start()` already called. |
| `inboxOptions` | Worker option | Options passed to the `Inbox`. Default `{}`. Set it in `use` in `playwright.config.ts` or with `test.use()`. |

The types `InboxFixtures` and `InboxWorkerOptions` are exported for use with `defineConfig` and `test.extend`.
