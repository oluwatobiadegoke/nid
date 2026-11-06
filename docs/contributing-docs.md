# Writing docs

The docs change in the same pull request as the code they describe. A change that adds, removes or renames something a user can see is not finished until the docs say so.

## Which page to change

| If your change touches | Update |
| --- | --- |
| A `nid` command or option | [reference/cli.md](reference/cli.md), and [how-to/use-the-cli.md](how-to/use-the-cli.md) or [how-to/run-nid.md](how-to/run-nid.md) if the task changes |
| An environment variable | [reference/configuration.md](reference/configuration.md) |
| A `createServer` option | [reference/configuration.md](reference/configuration.md), and [how-to/embed-nid.md](how-to/embed-nid.md) if it needs an example |
| A read API route, parameter or field | [reference/read-api.md](reference/read-api.md) and `packages/server/src/api/openapi.ts` |
| The client library | [reference/client.md](reference/client.md), and [how-to/read-mail-in-tests.md](how-to/read-mail-in-tests.md) if it needs an example |
| A provider, or a provider route | [reference/providers.md](reference/providers.md), [how-to/connect-your-app.md](how-to/connect-your-app.md), the provider list in the root README, and "What nid does not do yet" in [explanation/how-nid-works.md](explanation/how-nid-works.md) |
| A webhook event or payload | [reference/providers.md](reference/providers.md#webhooks), and [how-to/test-webhooks.md](how-to/test-webhooks.md) if setup changes |
| An MCP tool, or `/mcp` | [reference/mcp.md](reference/mcp.md), and [how-to/connect-an-ai-agent.md](how-to/connect-an-ai-agent.md) if setup changes |
| Code or link extraction | "Finding codes and links" in [explanation/how-nid-works.md](explanation/how-nid-works.md) |
| The web view (`packages/server/ui/index.html`) | [how-to/use-the-web-view.md](how-to/use-the-web-view.md), and the tutorial if its steps mention the view |
| Host checks, CORS or anything about who can reach nid | [explanation/security.md](explanation/security.md) |
| The Docker image | [how-to/run-nid.md](how-to/run-nid.md) and [reference/configuration.md](reference/configuration.md) |
| Something the tutorial uses | [tutorials/get-started.md](tutorials/get-started.md). Run the tutorial again from a clean folder. |

The root `README.md` and `packages/server/README.md` are the same file, because npm shows the second one on the package page. Change both, or copy one over the other.

## The docs check

`pnpm test` runs `scripts/docs.test.mjs`. It fails when:

- a read API route in `openapi.ts` is missing from the read API reference;
- a `nid` option in `cli.ts` is missing from the CLI reference;
- an `NID_*` variable in the code is missing from the configuration reference;
- a `createServer` option is missing from the configuration reference;
- a public `Inbox` method is missing from the client reference;
- a provider or provider route is missing from the providers reference;
- a relative link points at a file that does not exist;
- a page in `docs/` is not linked from `docs/README.md`.

The check only proves a name is mentioned. You still need to describe it correctly.

## Where a new page goes

The docs follow [Diátaxis](https://diataxis.fr). Put a new page in the folder for its job:

| Folder | A page here | Example |
| --- | --- | --- |
| `tutorials/` | Teaches a beginner by doing, step by step, with one path and no choices. | Get started |
| `how-to/` | Gets one task done for someone who knows the basics. Starts with what they need, then numbered steps or short sections. | Run nid in GitHub Actions |
| `reference/` | Lists every option, route or field, with exact names, types and defaults. No teaching. | Read API reference |
| `explanation/` | Explains why and how. No steps. | How nid works |

Link the new page from `docs/README.md`.

## Style

The docs follow the [Google developer documentation style guide](https://developers.google.com/style). The rules that matter most here:

- **Plain words, short sentences.** Write for someone whose first language is not English. One idea per sentence.
- **Talk to the reader** as "you". Use the present tense: "nid stores", not "nid will store".
- **Active voice.** "nid refuses the send", not "the send is refused".
- **Put the goal before the steps.** "To keep mail across restarts, pass `--db`."
- **Sentence case for headings.** "Run it with Docker", not "Run It With Docker".
- **Number the steps** when order matters. Use one action per step.
- **Code font** for anything a user types or sees: commands, options, paths, field names, values.
- **Show real output.** Copy it from a real run, not from memory.
- **Every command must work** when pasted as is. Test it before you commit.
- **Use `127.0.0.1:4400`** in examples, and `inbox.test` or `acme.com` for addresses.
- **No marketing.** Say what it does. Avoid "simply", "just", "easy" and "powerful".
- **Use the same word for the same thing.** The words in "Words these docs use" in `docs/README.md` are the agreed ones: "SDK" is the provider's library, "client library" is nid's. Add a new term there before you use it.
- **Write examples that run as pasted.** Use `npx nid-inbox` in how-to guides and the tutorial, since a reader may not have nid installed.
- **Show the result after each step** in the tutorial and how-to guides, so a reader knows it worked.
- **Say where a link goes.** Write "see Security" as a link to that page, never "see below" or "click here".
- **Link instead of repeating.** If two pages need the same detail, keep it in the reference and link to it.
