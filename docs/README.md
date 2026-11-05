# nid documentation

Your own inbox for the emails your app sends.

nid runs on your computer. Your app sends its emails to nid instead of to your email provider, and you read them in a web page that only you can see. You do not need a public inbox site such as Yopmail, and you do not sign up for anything. Your tests can read the same emails.

You need Node.js 22.13 or later for the npm packages, or Docker for the container image.

These docs describe the code on the `main` branch. The examples show output from version 0.2.0, so version numbers and ids in your output will differ.

## New to nid

Start with the tutorial. In about ten minutes you send an email to nid, read it in the web view, and read it back from a script.

- [Get started: catch your first email](tutorials/get-started.md)

## Get a task done

- [See your mail in the web view](how-to/use-the-web-view.md) to read the emails your app sends in your browser.
- [Run nid](how-to/run-nid.md) with npm, Docker, Playwright or GitHub Actions.
- [Point your app at nid](how-to/connect-your-app.md) when it sends with Resend, Brevo or SMTP.
- [Read mail in tests](how-to/read-mail-in-tests.md), with Playwright or any other test runner.
- [Use the command line](how-to/use-the-cli.md) to read and clear mail from a terminal.
- [Embed nid in your own code](how-to/embed-nid.md) instead of running it as a command.

## Look something up

- [Command line](reference/cli.md): every `nid` command and option.
- [Configuration](reference/configuration.md): environment variables and `createServer` options.
- [Read API](reference/read-api.md): every HTTP route for reading mail.
- [Client library](reference/client.md): every method of `@nid-inbox/client`.
- [Providers](reference/providers.md): what nid supports for each email provider.

## Understand how it works

- [How nid works](explanation/how-nid-works.md): inboxes, cursors, waiting and how codes are found.
- [Security](explanation/security.md): what keeps your test mail on your machine.

## Words these docs use

| Word | Meaning |
| --- | --- |
| Provider | A service your app calls to send email, such as Resend or Brevo. |
| SDK | The library a provider publishes for calling its API, such as the `resend` npm package. |
| Base URL | The address an SDK sends its requests to. Pointing it at nid is the only change your app needs. |
| Web view | The page nid serves at its HTTP address, where you read your mail in a browser. |
| Read API | nid's own HTTP routes under `/api`, for reading the mail it holds. |
| Client library | `@nid-inbox/client`, nid's JavaScript wrapper over the read API. |
| Cursor | A message id. "After the cursor" means "newer than that message". |
| Rejection | A send that nid refused, kept with the error it returned. |

## Keeping these docs current

The docs live next to the code and change in the same pull request as the code. See [Writing docs](contributing-docs.md) for the rules and the style.
