# Run nid

This guide shows the ways to start nid: with npm, with Docker, inside Playwright, and in GitHub Actions. Pick the one that matches where your tests run.

All of them start the same server. It listens on port 4400 for HTTP (the provider APIs, the read API and the web view) and on port 1025 for SMTP.

## Run it with npx

Use this to try nid, or to run it next to your app while you work.

```sh
npx nid-inbox serve
```

Stop it with Ctrl+C.

## Add it to a project

Use this when your tests start nid, so everyone on the team gets the same version.

1. Install the server as a dev dependency:

   ```sh
   npm install --save-dev nid-inbox
   ```

2. Add a script to `package.json`:

   ```json
   {
     "scripts": {
       "inbox": "nid serve"
     }
   }
   ```

3. Start it:

   ```sh
   npm run inbox
   ```

The package installs a command called `nid`. Inside npm scripts you can call `nid` directly. Outside them, use `npx nid` or `npx nid-inbox`.

## Run it with Docker

Use this when you do not want Node.js on the machine, or when your other services already run in containers.

```sh
docker run --rm \
  -p 127.0.0.1:4400:4400 \
  -p 127.0.0.1:1025:1025 \
  ghcr.io/oluwatobiadegoke/nid
```

The image is `ghcr.io/oluwatobiadegoke/nid`. The `latest` tag follows the newest release. Pin a version, such as `ghcr.io/oluwatobiadegoke/nid:0.2.0`, for repeatable builds.

Keep the `127.0.0.1:` part of each `-p` flag. It means only your own machine can reach nid. Inside the container nid listens on all interfaces so that Docker can forward the ports.

The image has a health check built in, so `docker ps` shows `healthy` once nid is ready.

### Keep mail across container restarts

Mount a folder and point `--db` at a file inside it:

```sh
docker run --rm \
  -p 127.0.0.1:4400:4400 \
  -p 127.0.0.1:1025:1025 \
  -v "$PWD/nid-data:/data" \
  ghcr.io/oluwatobiadegoke/nid serve --db /data/mail.sqlite
```

The container runs as the `node` user, so the folder must be writable by that user.

### Run it with Docker Compose

```yaml
services:
  nid:
    image: ghcr.io/oluwatobiadegoke/nid:0.2.0
    ports:
      - "127.0.0.1:4400:4400"
      - "127.0.0.1:1025:1025"

  app:
    build: .
    environment:
      RESEND_BASE_URL: http://nid:4400
    depends_on:
      nid:
        condition: service_healthy
```

Your app reaches nid at `http://nid:4400`. nid accepts the host name `nid` because it has no dot in it. If you use a name with a dot, add `--allow-host <name>` to the command. See [Security](../explanation/security.md).

## Start it from Playwright

Playwright can start nid and your app before the tests and stop them after. Add both to `webServer` in `playwright.config.ts`:

```ts
import { defineConfig } from '@playwright/test'

export default defineConfig({
  webServer: [
    { command: 'npx nid-inbox serve', port: 4400, reuseExistingServer: true },
    {
      command: 'npm run dev',
      port: 3000,
      reuseExistingServer: true,
      env: { RESEND_BASE_URL: 'http://127.0.0.1:4400' },
    },
  ],
})
```

`reuseExistingServer: true` lets you keep nid running in another terminal while you work, and Playwright uses it instead of starting a second one.

Then use the `inbox` fixture in your tests. See [Read mail in tests](read-mail-in-tests.md#use-the-playwright-fixture).

## Run it in GitHub Actions

Run nid as a service container. GitHub starts it before your steps and stops it after.

```yaml
jobs:
  e2e:
    runs-on: ubuntu-latest
    services:
      nid:
        image: ghcr.io/oluwatobiadegoke/nid:0.2.0
        ports:
          - 4400:4400
          - 1025:1025
    env:
      RESEND_BASE_URL: http://localhost:4400
      NID_URL: http://localhost:4400
    steps:
      - uses: actions/checkout@v4
      - run: npm ci
      - run: npx playwright install --with-deps
      - run: npx playwright test
```

If your job itself runs in a container (`container:` at the job level), reach nid at `http://nid:4400` instead of `localhost`.

If you start nid from Playwright's `webServer` instead, you do not need the service.

## Change the ports

Use `--port` and `--smtp-port`:

```sh
npx nid-inbox serve --port 4500 --smtp-port 2525
```

Then point your app and your tests at the new port, for example with `NID_URL=http://127.0.0.1:4500`.

Port `0` asks the system for any free port. This is useful when you [embed nid in your own code](embed-nid.md).

## Keep mail across restarts

By default nid keeps mail in memory, so it is gone when nid stops. To keep it, give nid a SQLite file:

```sh
npx nid-inbox serve --db mail.sqlite
```

nid creates the file if it does not exist.

## Check that nid is running

```sh
npx nid-inbox healthcheck
```

This prints `ok 0.2.0` and exits with code 0 when nid answers. It exits with code 2 when nothing is listening. You can also call `GET /healthz` directly.

## Related

- [Command line reference](../reference/cli.md)
- [Configuration reference](../reference/configuration.md)
