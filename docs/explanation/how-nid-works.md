# How nid works

This page explains the ideas behind nid: why it has a web view you run yourself, why it copies provider APIs, why any address is an inbox, how waiting works, and how it finds codes and links. You do not need it to use nid, but it helps when something surprises you.

## One process, two ways in, one way out

nid is a single Node.js process. Mail comes in two ways:

- The **provider APIs**, such as Resend's `POST /emails`, on the HTTP port.
- **SMTP**, on its own port.

Nothing goes out to the internet. There is no relay to real inboxes.

Mail goes out one way: the **read API** under `/api`. The CLI, the client library and the web view all use it, so they all behave the same.

```
your app ──Resend/Brevo API──┐
your app ──SMTP──────────────┼──> nid store ──> read API ──> tests, CLI, web view
```

## Why there is a web view you run yourself

While you build an app that sends email, you need to see those emails: the wording, the layout, the sign-in code, the link. A common shortcut is a public inbox site such as Yopmail, where anyone who guesses the address can read the mail. That puts your test data on someone else's server.

nid gives you that place on your own machine. The web view shows each email as it arrives, with the same detail the provider would have sent, and the sends your app got wrong. Nothing leaves your computer, no one else can read it, and you decide when to clear it. See [See your mail in the web view](../how-to/use-the-web-view.md).

Tests read the same mail through the read API. The web view is for you, and the API is for code.

## Why it copies the provider's API

Most fake mail servers only speak SMTP. But many apps today send through a provider's HTTP API and SDK. To test those apps against an SMTP fake, you would have to change how the app sends mail, and then you are not testing the code that runs in production.

nid answers the provider's own routes with the provider's own success and error shapes. Your app keeps its real SDK, and you change only the base URL. Because errors match too, a bad request makes the SDK raise the same typed error it would raise in production, so your error handling gets tested as well.

## Any address is an inbox

There is no "create inbox" step. nid stores each message under every address it was sent to, and you read mail by asking for an address.

This is what makes parallel tests safe. Each test makes up its own address, such as `signup.6aaee5fd@inbox.test`, so it can only ever see its own mail. Nothing needs to be cleaned up between tests, and two test workers never race for the same message.

## Cursors: only new mail counts

Every stored message gets an id one higher than the last. A cursor is a message id, and "after the cursor" means "with a higher id".

A test takes the cursor before it makes the app send an email, then waits for mail after that cursor. That way a message left over from an earlier run, or from earlier in the same test, can never match by mistake.

The client library does this for you:

- `start()` takes the cursor at the start of the test.
- Each `waitFor` remembers the id of the message it returned for that address, so the next `waitFor` on that address returns the next email.

## Waiting without polling

`GET /api/wait` holds the HTTP request open until a matching message arrives or the timeout ends. Inside nid it checks the store about four times a second. To the test it is one request that returns the moment the mail is there.

So a test has no loops and no `sleep`. It also never waits longer than it must, and on a slow CI machine it waits a little more, up to its timeout.

## Rejections explain timeouts

The hardest test failure to debug is "the email never came". Usually the app did send, but the provider refused it: a missing field, a bad address, a missing key.

nid keeps every send it refuses, with the status and error it returned. When a wait times out, the answer lists the rejections to that address from around the time of the wait, and the messages that did arrive but did not match. The error message says it in one sentence, for example:

```
Timed out waiting for mail to signup.6aaee5fd@inbox.test after 30s. 1 resend request was rejected 2s ago with 422: Missing `from` field.
```

## Finding codes and links

When a message arrives, nid pulls out codes and links once and stores them with the message.

**Codes.** nid looks at the subject and the plain text (or the HTML turned into text). A token counts as a code when it is:

- 4 to 8 digits, or two groups of 3 digits such as `123 456` or `123-456`; or
- 6 to 8 capital letters and digits with at least one digit, such as `AB12CD`;

and it sits near a word such as code, OTP, PIN, verify, confirm, login, sign in, 2FA or security. nid skips years, phone numbers and anything inside a URL. The first code found is `code`. All of them are in `codes`.

**Links.** nid collects every `<a href>` in the HTML and every URL in the text. The first one that is not `mailto:`, `tel:`, an image or an unsubscribe link becomes `link`.

**Templates.** When a send uses a provider template and has no body, nid reads the template variables instead. See [Templates](../reference/providers.md#templates).

When the guess is wrong, a test passes its own `codePattern`. That pattern runs when the test reads the mail, not when the mail arrives, so it works on mail already stored.

## Memory by default

nid keeps mail in an in-memory SQLite database unless you pass `--db`. Each run starts empty, which is what most test runs want. With `--db` it uses a SQLite file, so mail survives a restart.

## Projects

Every stored message and every query carries a project id. On your machine there is one project, `default`, and every key maps to it. When nid is [embedded](../how-to/embed-nid.md) with a custom `auth` function, each key can map to its own project, and one server can hold mail for many teams without them seeing each other's mail.

## What nid does not do yet

Today:

- Only Resend, Brevo and SMTP are supported. SendGrid, Postmark, Mailgun and Amazon SES are planned.
- There is no MCP server for AI agents yet.
- There are no delivery webhooks, so nid never calls your app back with "delivered" or "bounced" events.
- `retentionHours` stamps an expiry time on messages, but nothing deletes expired messages yet.
- The only built-in store is SQLite.
