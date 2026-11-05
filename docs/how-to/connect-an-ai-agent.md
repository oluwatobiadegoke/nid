# Let an AI agent read your mail

An AI agent that tests your app, such as Claude Code, can sign up with a fresh address and read the code and link nid catches. It talks to nid over MCP, the Model Context Protocol.

You need nid running. See [Run nid](run-nid.md).

## Connect over HTTP

nid answers MCP at `/mcp` on its HTTP port. To add it to Claude Code, run:

```sh
claude mcp add --transport http nid http://127.0.0.1:4400/mcp
```

Check that it connects:

```sh
claude mcp list
```

```
nid: http://127.0.0.1:4400/mcp (HTTP) - √ Connected
```

Other agents take the same URL. Look for "Streamable HTTP" or "remote server" in their MCP settings.

## Connect over stdio

Some agents can only start a command. For those, `nid mcp` serves the same tools over stdio and reads from the running server:

```sh
claude mcp add nid -- npx nid-inbox mcp
```

In an agent that takes a JSON config, the entry looks like this:

```json
{
  "mcpServers": {
    "nid": { "command": "npx", "args": ["nid-inbox", "mcp"] }
  }
}
```

`nid mcp` talks to `http://127.0.0.1:4400` unless you pass `--url` or set `NID_URL`. Give it nid's address, not the `/mcp` URL. See [`nid mcp`](../reference/cli.md#nid-mcp).

## Ask the agent to test a sign-up

Once connected, ask in plain words, for example: "Sign up on http://127.0.0.1:3000 with a new nid address and finish the email check." The agent calls `new_address`, fills in the form, then calls `wait_for_email` and gets back:

```json
{
  "id": 1,
  "from": "Acme <hello@acme.com>",
  "to": [
    "signup.974487fb@inbox.test"
  ],
  "cc": [],
  "subject": "Your sign-in code",
  "receivedAt": "2026-11-05T23:08:57.436Z",
  "code": "482913",
  "link": "http://127.0.0.1:3000/verify?token=abc",
  "links": [
    {
      "href": "http://127.0.0.1:3000/verify?token=abc",
      "text": "Verify email"
    }
  ],
  "text": "Your code is 482913 .\n Verify email"
}
```

If no email comes, the tool says why, including any send nid refused and the error your app got.

Claude Code asks before it calls each tool. To let it call nid's tools without asking, add `mcp__nid` to `permissions.allow` in `.claude/settings.json`.

For every tool and its arguments, see the [MCP reference](../reference/mcp.md).
