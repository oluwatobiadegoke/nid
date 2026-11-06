# nid-inbox

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
