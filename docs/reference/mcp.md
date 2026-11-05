# MCP reference

nid serves the same MCP tools in two ways:

| Way | Where | Use it when |
| --- | --- | --- |
| Streamable HTTP | `http://127.0.0.1:4400/mcp` | Your agent can connect to a URL. |
| stdio | [`nid mcp`](cli.md#nid-mcp) | Your agent can only start a command. |

Both read mail through the [read API](read-api.md), so they see the same mail and give the same answers. Over HTTP, nid passes the request's `Authorization` header on to the read API. `nid mcp` sends `NID_TOKEN` when it is set.

`/mcp` refuses a request whose `Origin` header names a host nid does not accept, so a web page on another site cannot call it. See [Security](../explanation/security.md).

## Tools

Every tool answers with JSON as text. When it cannot answer, such as when no email arrived, it returns an error result with a sentence that says why.

| Tool | Arguments | Returns |
| --- | --- | --- |
| `new_address` | `prefix` (optional) | `address`, a fresh address such as `signup.974487fb@inbox.test`, and `cursor`, the newest message id. |
| `wait_for_email` | `to`, and optional `after`, `subject`, `has_code`, `code_pattern`, `timeout` | The next email to `to` after the cursor: `id`, `from`, `to`, `cc`, `subject`, `receivedAt`, `code`, `link`, `links` and `text`. |
| `get_code` | `to` | `code`, `id` and `subject` of the newest email to `to` that has a code. |
| `get_links` | `to` | `link`, `links`, `id` and `subject` of the newest email to `to`. |
| `list_messages` | `to` (optional), `limit` (optional, 1 to 100, default 20) | Emails newest first, each with `id`, `from`, `to`, `subject`, `receivedAt`, `code` and `link`. |
| `clear` | `to` (optional) | `deleted`, how many emails it deleted. Without `to`, it deletes every email. |

`wait_for_email` takes the same filters as [`GET /api/wait`](read-api.md#get-apiwait):

| Argument | What it does |
| --- | --- |
| `to` | The address to wait for. |
| `after` | Only email newer than this message id. Pass the `cursor` from `new_address`, or the `id` of the last email you read. |
| `subject` | Only email whose subject contains this text. |
| `has_code` | `true` skips email with no code. |
| `code_pattern` | A regular expression for the code. Its first group becomes `code`. |
| `timeout` | Seconds to wait, from 0 to 120. The default is 30. |

`text` is the email's text part. When the email has only HTML, `text` is the HTML with its tags removed.

Every tool except `clear` is marked read-only, so an agent can run them without asking you first. `clear` is marked destructive.
