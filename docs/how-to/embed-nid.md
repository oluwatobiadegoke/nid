# Embed nid in your own code

This guide shows how to start nid from your own Node.js code, for example in a test setup file, instead of running it as a separate command.

## Install the package

```sh
npm install --save-dev nid-inbox
```

## Start a server

```js
import { createServer } from 'nid-inbox'

const server = await createServer()
const listening = await server.listen({ port: 0, smtpPort: 0 })

console.log(listening.url)
console.log(listening.smtpPort)

await server.close()
```

- `createServer()` builds the server with an in-memory store.
- `listen()` starts the HTTP and SMTP listeners. Port `0` picks any free port, which lets several test files each run their own nid.
- `listening.url` is the HTTP address, such as `http://127.0.0.1:53123`. Pass it to your app as the provider base URL and to the client as `url`.
- `server.close()` stops both listeners and closes the store.

## Keep mail in a file

```js
import { createServer, createSqliteStore } from 'nid-inbox'

const store = await createSqliteStore({ path: 'mail.sqlite' })
const server = await createServer({ store })
```

## Run something on every new email

```js
const server = await createServer({
  onMessage: (message) => console.log('new mail for', message.recipients.map((r) => r.address)),
})
```

## Send requests without opening a port

`server.app` is a [Hono](https://hono.dev) app. You can call it directly, which is fast and needs no network:

```js
const response = await server.app.request('/emails', {
  method: 'POST',
  headers: { authorization: 'Bearer re_test', 'content-type': 'application/json' },
  body: JSON.stringify({ from: 'a@acme.com', to: 'b@inbox.test', subject: 'Hi', text: 'Hi' }),
})
```

## Map keys to projects

By default every key belongs to one project called `default`. To split mail by key, pass an `auth` function. It gets the credential and returns a project, or `null` to refuse the request:

```js
const server = await createServer({
  auth: ({ kind, provider, value }) => {
    if (value === 'team-a-key') return { projectId: 'team-a', plan: 'local' }
    if (value === 'team-b-key') return { projectId: 'team-b', plan: 'local' }
    return null
  },
})
```

The same function checks the read API token (`provider` is `api`) and the SMTP username (`kind` is `smtp`). Each project only sees its own mail.

Once you pass `auth`, every caller needs a key that it accepts:

- Your tests pass the token to the client with `createInbox({ token: 'team-a-key' })` or the `NID_TOKEN` environment variable.
- The read API takes it as `Authorization: Bearer <token>`.
- SMTP senders log in with the key as the username.

The web view cannot send a token, so it shows no mail once you pass `auth`. To turn it off, pass `ui: false`.

## All options

See [`createServer` options](../reference/configuration.md#createserver-options) in the configuration reference.
