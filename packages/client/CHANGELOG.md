# @nid-inbox/client

## 0.3.0

### Minor Changes

- d32a39a: Send your app the webhook a provider would send when an email is delivered, deferred, bounced, complained about, opened or clicked. Set `NID_<PROVIDER>_WEBHOOK_URL` and `NID_<PROVIDER>_WEBHOOK_SECRET`, then call `POST /api/messages/{id}/events`, `nid webhook <id> <type>` or `inbox.triggerWebhook(id, type)`. Each payload is signed the provider's way and carries the ids the app got back when it sent, and nid returns the app's status and body.

### Patch Changes

- e4b872c: Both package pages on npm now link to the GitHub repo.

## 0.2.0

### Minor Changes

- 1aa206a: First release: Resend and Brevo provider APIs, SMTP, a read API with wait and extraction, a CLI, a web view, and a client with a Playwright fixture.
