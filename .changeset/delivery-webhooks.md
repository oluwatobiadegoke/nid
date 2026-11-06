---
"nid-inbox": minor
"@nid-inbox/client": minor
---

Send your app the webhook a provider would send when an email is delivered, deferred, bounced, complained about, opened or clicked. Set `NID_<PROVIDER>_WEBHOOK_URL` and `NID_<PROVIDER>_WEBHOOK_SECRET`, then call `POST /api/messages/{id}/events`, `nid webhook <id> <type>` or `inbox.triggerWebhook(id, type)`. Each payload is signed the provider's way and carries the ids the app got back when it sent, and nid returns the app's status and body.
