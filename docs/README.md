# nid documentation

nid is a local inbox that stands in for your email provider. Your app sends email the way it always does, and nid keeps every message where your tests, the command line and other tools can read it.

These docs describe the code on the `main` branch. The examples show output from version 0.2.0, so version numbers and ids in your output will differ.

## Where to start

If you have never used nid, start with the tutorial. It takes about ten minutes.

- [Get started: catch your first email](tutorials/get-started.md)

## The four kinds of page

The docs follow the [Diátaxis](https://diataxis.fr) model. Each page does one job.

| Kind | Use it when you want to | Pages |
| --- | --- | --- |
| Tutorial | Learn nid by doing, from nothing to a working test | [Get started](tutorials/get-started.md) |
| How-to guide | Get one task done | [Run nid](how-to/run-nid.md), [Point your app at nid](how-to/connect-your-app.md), [Read mail in tests](how-to/read-mail-in-tests.md), [Use the command line](how-to/use-the-cli.md), [Embed nid in your own code](how-to/embed-nid.md) |
| Reference | Look up an exact option, route or method | [Command line](reference/cli.md), [Configuration](reference/configuration.md), [Read API](reference/read-api.md), [Client library](reference/client.md), [Providers](reference/providers.md) |
| Explanation | Understand how nid works and why | [How nid works](explanation/how-nid-works.md), [Security](explanation/security.md) |

## What you need

- Node.js 22.13 or later, for the npm packages.
- Or Docker, for the container image.

## Keeping these docs current

The docs live next to the code and change in the same pull request as the code. See [Writing docs](contributing-docs.md) for the rules and the style.
