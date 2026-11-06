---
"nid-inbox": patch
---

Harden nid against hostile mail and web pages. nid stops keeping an SMTP message in memory once it passes the size limit. nid leaves out `javascript:`, `vbscript:` and `data:` links. Mail stored with `--db` before this version keeps the links nid found then. `POST /api/messages/{id}/events` refuses a body that is not `application/json` with `415`, so a web page cannot make nid send your app a webhook. Without `--json`, `nid read` leaves out control characters other than newlines and tabs, so an email cannot change your terminal. An attachment with a name such as `Łódź.pdf` or `請求書.pdf` now downloads under that name instead of failing.
