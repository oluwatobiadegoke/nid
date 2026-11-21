---
"nid-inbox": minor
"@nid-inbox/client": minor
---

Add zero-code SDK interception (`nid run` and `nid-inbox/intercept`), switch the default server store to in-memory (`MemoryStore`) with lazy SQLite (`nid-inbox/sqlite`), replace polling with an event-driven `EventBus`, add Amazon SES v2/v1, fault injection and magic addresses, add `--token` authentication, upgrade the web UI and MCP toolset, and expand `@nid-inbox/client`.

Breaking changes: `KyselyStore` and SQLite helpers moved from the `nid-inbox` root export to `nid-inbox/sqlite`, and custom `Store` implementations must implement `deleteMessage`, `deleteRejections`, `insertWebhookDelivery`, `listWebhookDeliveries`, and `latestWebhookEvent` (along with optional `order` on `RejectionQuery`).
