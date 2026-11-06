# Command line reference

The `nid-inbox` package installs one command, `nid`.

```
nid <command> [options]
```

Run it with `npx nid-inbox <command>` when nid is not installed in your project, or `npx nid <command>` when it is.

| Command | What it does |
| --- | --- |
| [`serve`](#nid-serve) | Starts the server. |
| [`read`](#nid-read) | Lists or prints mail for an address. |
| [`clear`](#nid-clear) | Deletes mail. |
| [`mcp`](#nid-mcp) | Serves nid's MCP tools over stdio, for AI agents. |
| [`healthcheck`](#nid-healthcheck) | Checks that a server is answering. |
| `help`, `--help`, `-h`, or no command | Prints usage. |
| `--version`, `-v` | Prints the version. |

## nid serve

Starts the HTTP server (provider APIs, read API and web view) and the SMTP server. It runs until it gets Ctrl+C (`SIGINT`) or `SIGTERM`.

```
nid serve [--port 4400] [--smtp-port 1025] [--host 127.0.0.1] [--db mail.sqlite] [--cors origin] [--allow-host name] [--quiet]
```

| Option | Default | What it does |
| --- | --- | --- |
| `--port <n>` | `4400`, or `NID_PORT` | HTTP port. `0` picks a free port. |
| `--smtp-port <n>` | `1025`, or `NID_SMTP_PORT` | SMTP port. `0` picks a free port. |
| `--host <address>` | `127.0.0.1`, or `NID_HOST` | Address both servers listen on. Use `0.0.0.0` to accept connections from other machines. |
| `--db <path>` | none, or `NID_DB` | SQLite file to keep mail in. Without it, mail is kept in memory and lost when nid stops. |
| `--cors <origin>` | none | Lets web pages from this origin, such as `http://localhost:3000`, call nid. Repeat it for more origins. See [Security](../explanation/security.md). |
| `--allow-host <name>` | none | Accepts requests whose `Host` header is this name. Repeat it for more names. See [Security](../explanation/security.md). |
| `--quiet` | off | Prints nothing on start. |

An option on the command line wins over the environment variable.

## nid read

Reads mail for one address from a running server.

```
nid read <address> [--latest] [--code] [--links] [--wait <seconds>] [--json] [--url <url>]
```

| Option | What it does |
| --- | --- |
| none | Lists up to 50 messages for the address, newest first, one per line. |
| `--latest` | Prints the newest message in full. |
| `--code` | Prints only the code of the newest message. With `--wait`, waits for a message that has a code. |
| `--links` | Prints only the links of the newest message, one per line. |
| `--wait <seconds>` | Waits for the next message that arrives after the command starts, then prints it. The server allows up to 120 seconds. |
| `--json` | Prints JSON instead of text. |
| `--url <url>` | The server to read from. See [Choosing the server](#choosing-the-server). |

Without `--json`, `nid read` leaves out control characters other than newlines and tabs, so an email cannot change your terminal.

## nid clear

Deletes mail on a running server and prints how many messages it deleted.

```
nid clear [<address>] [--url <url>]
```

With an address, it deletes mail for that address only. Without one, it deletes every message.

## nid webhook

Sends a provider webhook for a message to your app, and prints your app's status, time and body. See [Test your webhook handler](../how-to/test-webhooks.md).

```
nid webhook <message-id> <delivered|deferred|bounced|complained|opened|clicked> [--url <url>]
```

It exits with code 1 when your app answers anything but a 2xx, or cannot be reached. `nid serve` needs `NID_<PROVIDER>_WEBHOOK_URL` set for the message's provider.

## nid mcp

Serves nid's MCP tools over standard input and output, for an AI agent that starts nid as a command. It reads mail from a running server, so start `nid serve` first. See [Let an AI agent read your mail](../how-to/connect-an-ai-agent.md).

```
nid mcp [--url <url>]
```

It runs until the agent closes its input. The tools are listed in the [MCP reference](mcp.md).

## nid healthcheck

Calls `GET /healthz` on a running server and prints `ok <version>`.

```
nid healthcheck [--url <url>]
```

The Docker image uses this command for its health check.

## Choosing the server

`read`, `clear`, `webhook`, `mcp` and `healthcheck` talk to the server at, in order:

1. The `--url` option.
2. The `NID_URL` environment variable.
3. `http://127.0.0.1:4400`.

When `NID_TOKEN` is set, they send it as `Authorization: Bearer <token>`.

## Exit codes

| Code | Meaning |
| --- | --- |
| `0` | Success. |
| `1` | The server answered, but there was nothing to show or the request failed. For example: no mail for the address, no code in the message, or a wait that timed out. Also used for an unknown command. |
| `2` | The server could not be reached. |

Errors are printed to standard error.
