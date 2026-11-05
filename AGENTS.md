# Notes for coding agents

Read [CONTRIBUTING.md](CONTRIBUTING.md) first. It has the setup, the layout and the rules for adding a provider.

## Rules

- **Update the docs in the same change.** If a user can see what you changed (a command, an option, an environment variable, a route, a field, a client method, a provider or a default), update the page that describes it. [docs/contributing-docs.md](docs/contributing-docs.md) says which page. Follow its style: plain words, short sentences, Google developer documentation style.
- **Check the docs against the code.** Run any command or example you change, and paste real output.
- **Keep the two READMEs the same.** `README.md` and `packages/server/README.md` must match. Use absolute GitHub links in them, because npm shows the second one.
- **No comments in code.** The names and the tests carry the meaning.
- **Every store query takes a `project_id`.**
- **Never commit screenshots** or other stray images.

## Before you finish

```sh
pnpm check
```

This runs the type check, the build, the package tests and the docs check. The docs check is `scripts/docs.test.mjs`.
