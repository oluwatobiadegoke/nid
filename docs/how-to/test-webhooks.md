# Test your webhook handler

Your app may have a route that your email provider calls when an email bounces or arrives, such as `/api/webhooks/brevo`. nid can call that route with the same payload and signature the provider would send, so you can test what your app does with a bounce before a real one happens.

You need nid running and your app running. See [Run nid](run-nid.md).

## Tell nid where your webhook route is

Set the route's URL for the provider your app sends with. Set the secret too, the same one your app uses to check that a webhook is real:

```sh
NID_BREVO_WEBHOOK_URL=http://127.0.0.1:3000/api/communications/webhooks/brevo \
NID_BREVO_WEBHOOK_SECRET=webhook-token \
npx nid-inbox serve
```

nid lists the route when it starts:

```
  webhooks    brevo to http://127.0.0.1:3000/api/communications/webhooks/brevo
```

Each provider has its own pair, such as `NID_RESEND_WEBHOOK_URL` and `NID_RESEND_WEBHOOK_SECRET`. What the secret is for depends on the provider:

| Provider | `NID_<PROVIDER>_WEBHOOK_SECRET` |
| --- | --- |
| Resend | Required. Your app's signing secret, which starts with `whsec_`. |
| Brevo | Optional. Sent as `Authorization: Bearer <secret>`. |
| SendGrid | Not used. nid signs with its own test key, so give your app nid's public key. See [SendGrid webhooks](../reference/providers.md#sendgrid-webhooks). |
| Postmark | Not used. Put a user and password in the URL, such as `http://user:pass@127.0.0.1:3000/hooks`, and nid sends them as basic auth. |
| Mailgun | Required. Your app's HTTP webhook signing key. |

When you [embed nid](embed-nid.md), pass `webhooks: { brevo: { url, secret } }` to `createServer` instead.

## Send an event

Send an email from your app first, then send an event for it. The event goes to the route set for the provider that email came through.

From a test, with the [client library](../reference/client.md#triggerwebhookid-type):

```ts
const email = await inbox.waitFor(address)
const result = await inbox.triggerWebhook(email.id, 'bounced')
expect(result.appStatus).toBe(201)
```

From a terminal, with the message id from `nid read`:

```sh
npx nid-inbox webhook 1 bounced
```

```
Your app answered 201 in 4 ms
{"received":true}
```

The events are `delivered`, `deferred`, `bounced`, `complained`, `opened` and `clicked`. nid turns each one into the provider's own event, such as `hard_bounce` for Brevo. See [Webhooks](../reference/providers.md#webhooks) for the full list.

## Read your app's answer

nid waits up to 10 seconds for your app and returns what it answered:

```json
{
  "url": "http://127.0.0.1:3000/api/communications/webhooks/brevo",
  "delivered": true,
  "appStatus": 201,
  "appBody": "{\"received\":true}",
  "durationMs": 4
}
```

`delivered` is `true` when your app answered with a 2xx status. When your handler throws, you see its status and body here, in the test, not only in your app's log. When nid cannot reach your app, `appStatus` is `null` and `error` says why:

```
Could not reach your app at http://127.0.0.1:3000/api/communications/webhooks/brevo: connect ECONNREFUSED 127.0.0.1:3000
```

`nid webhook` prints that sentence and exits with code 1 when your app answers anything but a 2xx.

## Limits

- nid sends an event only when you ask for one. It never sends one by itself after a send.
- The event names the email's first `to` address.
- Mail sent over SMTP has no provider, so it has no webhooks.
- nid sends each event once and does not retry.
