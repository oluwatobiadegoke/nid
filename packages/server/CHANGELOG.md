# nid-inbox

## 0.4.1

### Patch Changes

- 1830768: Show a short demo of the web view at the top of the README.

## 0.4.0

### Minor Changes

- 9dae8af: `--cors` now takes an origin to allow, such as `--cors http://localhost:3000`. Repeat it for more. Before, `--cors` let every website read your mail. Plain `--cors` now stops nid with an error. In code, pass `cors: ['http://localhost:3000']` instead of `cors: true`, and leave `cors` out instead of passing `cors: false`.
- d32a39a: Send your app the webhook a provider would send when an email is delivered, deferred, bounced, complained about, opened or clicked. Set `NID_<PROVIDER>_WEBHOOK_URL` and `NID_<PROVIDER>_WEBHOOK_SECRET`, then call `POST /api/messages/{id}/events`, `nid webhook <id> <type>` or `inbox.triggerWebhook(id, type)`. Each payload is signed the provider's way and carries the ids the app got back when it sent, and nid returns the app's status and body.

### Patch Changes

- 2d07f54: Read codes and links from broken or hostile HTML quickly. A body with many unclosed tags, many codes, many links in template variables or a long run of dots inside a link no longer stalls the server. An entity such as `&#99999999;` no longer makes nid refuse the email. An unclosed `<script>` or `<style>` now hides the rest of the body, as a browser does, and a `<` that does not start a tag, as in "in <10 min", stays in the text.
- e4b872c: Both package pages on npm now link to the GitHub repo.
- e716017: Harden nid against hostile mail and web pages. nid stops keeping an SMTP message in memory once it passes the size limit. nid leaves out `javascript:`, `vbscript:` and `data:` links. Mail stored with `--db` before this version keeps the links nid found then. `POST /api/messages/{id}/events` refuses a body that is not `application/json` with `415`, so a web page cannot make nid send your app a webhook. Without `--json`, `nid read` leaves out control characters other than newlines and tabs, so an email cannot change your terminal. An attachment with a name such as `Łódź.pdf` or `請求書.pdf` now downloads under that name instead of failing.

## 0.3.0

### Minor Changes

- 57d86be: Add an MCP server for AI agents. nid answers MCP at `/mcp`, and `nid mcp` serves the same tools over stdio. The tools are `new_address`, `wait_for_email`, `get_code`, `get_links`, `list_messages` and `clear`.
- 42a5b6f: Answer the SendGrid, Postmark and Mailgun send APIs, so their official SDKs work against nid with only a base URL change.
  
  Fix Brevo sends with both `messageVersions` and an `Idempotency-Key` header, which stored only the first version.
  
  Fix a slow address check that a short, padded `from` or `to` value could use to stall the server, and record failed Resend and Brevo sends against their recipients' plain addresses, so `/api/rejections?to=` finds them.
  
  `/api/rejections?to=` and `/api/wait` now filter rejections by address in the database, so an old rejection is still found after many newer ones.

## 0.2.1

### Patch Changes

- ad8bc82: Lead the package description and README with the web inbox, in plainer words.

## 0.2.0

### Minor Changes

- 1aa206a: First release: Resend and Brevo provider APIs, SMTP, a read API with wait and extraction, a CLI, a web view, and a client with a Playwright fixture.
