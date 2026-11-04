# Contributing

Thank you. The project is small on purpose: one process, one file per provider, no framework in the tests.

## Set up

```
pnpm install
pnpm build
pnpm test
pnpm dev          # starts the server from source on 4400 and 1025
```

Node 22.13 or later. Tests use `node:test` and run against a server started in-process, so nothing else has to be running.

## Layout

```
packages/
  server/           the npm package `testinbox`: server and CLI
    src/
      providers/    one file per provider: resend.ts, brevo.ts, ...
      ingest/       the HTTP and SMTP listeners that call the providers and the store
      store/        the Store interface, the schema and the SQLite dialect
      extract/      codes and links
      api/          the read API: wait, messages, rejections, stream, openapi
      security/     the Host check
      ui/           serves the one-page web view in ../ui/index.html
      server.ts     createServer: wires it all together
      cli.ts        serve, read, clear, healthcheck
    test/
  client/           the npm package `@testinbox/client`: a tiny client and a Playwright fixture
```

## Adding a provider

A provider is one file in `packages/server/src/providers/` that exports a `Provider`:

```ts
export const postmark: Provider = {
  name: 'postmark',
  label: 'Postmark',
  credential: (req) => header(req, 'x-postmark-server-token'),
  unauthorized: () => ({ status: 401, body: { ErrorCode: 10, Message: 'No Account or Server API tokens were supplied.' } }),
  routes: [send, batch],
  setup: { env: "new ServerClient(token, { requestHost: 'localhost:4400', useHttps: false })", note: '' },
}
```

Rules every adapter follows:

1. **Same success shape.** Same status code and id format as the real API, so the official SDK treats the send as a success.
2. **Same errors.** Check required fields the way the provider does and throw a `SendError` with the provider's real error body and status, so the SDK raises its own typed error. The ingest layer records every `SendError` as a rejection.
3. **Right kind of credential.** Locally any key value works, but a request with no credential, or the wrong kind, must fail as it would in production.
4. **Keep the raw request** on every message (`raw`).
5. **Templates.** When a send has a template and no body, store the template id and variables in `meta.templateId` and `meta.variables`. Extraction runs over the variables.

Then add it to the list in `providers/index.ts`, add a test in `test/providers/<name>.test.ts` with real request bodies, and add the official SDK to `devDependencies` with a case in `test/sdk.test.ts`.

## Style

- TypeScript, strict. No comments in code: the names and the tests carry the meaning.
- Plain words in messages and docs. Short sentences.
- Every store query takes a `project_id`.
- Nothing is added to the server for the web view's sake. The view only uses the read API.

## Releasing

Add a changeset with `pnpm changeset`. Merging the version PR that Changesets opens publishes both packages to npm and the image to the GitHub container registry.
