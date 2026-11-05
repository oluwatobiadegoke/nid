---
"nid-inbox": minor
---

Answer the SendGrid, Postmark and Mailgun send APIs, so their official SDKs work against nid with only a base URL change.

Fix Brevo sends with both `messageVersions` and an `Idempotency-Key` header, which stored only the first version.
