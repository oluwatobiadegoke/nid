# Security

nid holds email your app sent, which can include sign-in codes and reset links. This page explains what nid does to keep that mail on your machine, and what you need to do when you change the defaults.

## Your mail stays with you

nid keeps every email on your machine. By default, only your own computer can open the web view or the read API.

## Defaults

- **It listens on 127.0.0.1 only.** Other machines on your network cannot reach it. Use `--host 0.0.0.0` only when you need to, such as inside a container.
- **It sends no CORS headers.** A web page on another origin cannot read nid's answers. Turn them on with `--cors` only if a page you trust needs them.
- **It checks the Host header.** See [Why nid checks the Host header](#why-nid-checks-the-host-header).
- **Its MCP endpoint checks the Origin header.** A browser sends `Origin` with the requests a page makes. `/mcp` refuses a request whose `Origin` names a host nid would refuse in `Host`, such as `https://evil.example`, even with `--cors`. With `--cors`, a page served from `localhost`, an IP address, a name with no dot or an `--allow-host` name can still call it, as any page can call the read API.
- **It renders email HTML in a sandboxed frame** with scripts blocked, so an email cannot run code in the web view.
- **It leaves out links that run code.** nid drops `javascript:`, `vbscript:` and `data:` links when it reads an email, so the web view, the CLI and your tests never get one to click.
- **It sends a webhook only when asked in JSON.** A web page you visit can post a plain form to nid, but `POST /api/messages/{id}/events` refuses any body that is not `application/json`, so the page cannot make nid call your app. `--cors` lifts this for every page.
- **It sends nothing out.** There is no relay to real inboxes and no telemetry.

## Why nid checks the Host header

A web page you visit could try a trick called DNS rebinding. It points a domain it controls at `127.0.0.1`, then sends requests to that domain. Your browser would send them to nid, and the page could read your test mail.

To stop this, nid only answers when the request's `Host` header is one of:

- `localhost`, or a name ending in `.localhost`.
- An IP address.
- A name with no dot in it, such as the Docker Compose service name `nid`.

Any other name gets `403`. If you need one, such as `nid.internal`, allow it by name:

```sh
npx nid-inbox serve --allow-host nid.internal
```

You can repeat `--allow-host` for more names.

## Keys and tokens

On your machine nid accepts any provider key, any SMTP login and no read API token. That is fine on 127.0.0.1, because only you can reach it.

If you run nid where other people can reach it, [embed it](../how-to/embed-nid.md) and pass an `auth` function that checks keys. Then every send and every read needs a key the function accepts.

nid speaks plain HTTP and SMTP, with no TLS. Where other people can reach it, put a TLS proxy in front of it. Send the read API token in the `Authorization` header, not in the URL, so it stays out of logs.

Give keys only to people you trust. `GET /api/wait` takes a `code_pattern`, a regular expression that nid runs as written, and a slow one holds up every other request.

