# @nid-inbox/client

## 0.4.0

### Minor Changes

- ede6e98: Add zero-code SDK interception (`nid run` and `nid-inbox/intercept`), switch the default server store to in-memory (`MemoryStore`) with lazy SQLite (`nid-inbox/sqlite`), replace polling with an event-driven `EventBus`, add Amazon SES v2/v1, fault injection and magic addresses, add `--token` authentication, upgrade the web UI and MCP toolset, and expand `@nid-inbox/client`.
  
  Breaking changes: `KyselyStore` and SQLite helpers moved from the `nid-inbox` root export to `nid-inbox/sqlite`, and custom `Store` implementations must implement `deleteMessage`, `deleteRejections`, `insertWebhookDelivery`, `listWebhookDeliveries`, and `latestWebhookEvent` (along with optional `order` on `RejectionQuery`). The read API no longer takes the token from a `?token=` query parameter. Send it as `Authorization: Bearer <token>`. The read API now checks the `Origin` header, as `/mcp` does. A web page on a host that is not local needs both `--cors <origin>` and `--allow-host <name>` to call it.

## 0.3.0

### Minor Changes

- d32a39a: Send your app the webhook a provider would send when an email is delivered, deferred, bounced, complained about, opened or clicked. Set `NID_<PROVIDER>_WEBHOOK_URL` and `NID_<PROVIDER>_WEBHOOK_SECRET`, then call `POST /api/messages/{id}/events`, `nid webhook <id> <type>` or `inbox.triggerWebhook(id, type)`. Each payload is signed the provider's way and carries the ids the app got back when it sent, and nid returns the app's status and body.

### Patch Changes

- e4b872c: Both package pages on npm now link to the GitHub repo.

## 0.2.0

### Minor Changes

- 1aa206a: First release: Resend and Brevo provider APIs, SMTP, a read API with wait and extraction, a CLI, a web view, and a client with a Playwright fixture.
