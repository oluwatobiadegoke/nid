# Security

nid holds email your app sent, which can include sign-in codes and reset links. This page explains what nid does to keep that mail on your machine, and what you need to do when you change the defaults.

## Why a local inbox is safer than a public one

Public inbox sites let anyone read mail sent to an address they can guess. nid keeps the mail on your machine, where only you can open the web view by default.

## Defaults

- **It listens on 127.0.0.1 only.** Other machines on your network cannot reach it. Use `--host 0.0.0.0` only when you need to, such as inside a container.
- **It sends no CORS headers.** A web page on another origin cannot read nid's answers. Turn them on with `--cors` only if a page you trust needs them.
- **It checks the Host header.** See [Why nid checks the Host header](#why-nid-checks-the-host-header).
- **It renders email HTML in a sandboxed frame** with scripts blocked, so an email cannot run code in the web view.
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

