# Get started: catch your first email

In this tutorial you start nid, send it an email, and read that email in three ways: in the web view, from the command line and over HTTP. Then you write a short script that sends a sign-in code and reads it back. By the end you can see every email your app sends, and you know the loop that tests use to read them.

It takes about ten minutes.

## Before you begin

You need:

- Node.js 22.13 or later. Check with `node --version`.
- `curl`, or any tool that can send an HTTP request.
- Two terminal windows.

You do not need an account with any email provider. Nothing you send in this tutorial leaves your computer.

## Step 1: Start nid

In the first terminal, run:

```sh
npx nid-inbox serve
```

npm asks once to install the package. Say yes. nid then prints where it is listening:

```
nid 0.2.0
  web view    http://127.0.0.1:4400
  provider APIs and read API on http://127.0.0.1:4400
  SMTP        127.0.0.1:1025
  mail is kept in memory until you stop the server
```

Leave this terminal open. nid keeps running until you press Ctrl+C.

Open [http://127.0.0.1:4400](http://127.0.0.1:4400) in a browser. You see the web view, the page where you read your mail. It says `Nothing has arrived yet.`

## Step 2: Send an email

Resend is an email provider: a service that apps call over HTTP to send email. nid answers the same HTTP API as Resend, so anything that can talk to Resend can talk to nid.

In the second terminal, send an email the way the Resend API expects it:

```sh
curl -X POST http://127.0.0.1:4400/emails \
  -H 'authorization: Bearer re_test' \
  -H 'content-type: application/json' \
  -d '{
    "from": "Acme <hello@acme.com>",
    "to": "ada@inbox.test",
    "subject": "Your sign-in code",
    "text": "Your sign-in code is 482913. Or open https://acme.com/verify?t=abc"
  }'
```

nid answers like Resend does:

```json
{"id":"50afbb82-10d0-4dd9-ba1d-186c59bd737c"}
```

Your id is different. Any API key works locally, so `re_test` is fine.

Look at the web view again. The email is at the top of the list, with the subject, the recipient and the code `482913`. Choose it to read the whole email: the header, the code and link nid found, the text, and the request your app sent.

## Step 3: Read the email from the command line

The web view is for you. The `nid` command reads the same mail, for scripts and terminals. Run:

```sh
npx nid-inbox read ada@inbox.test --latest
```

You see the whole message:

```
#1  resend  2026-11-05T20:33:43.061Z
From:    Acme <hello@acme.com>
To:      ada@inbox.test
Subject: Your sign-in code
Code:    482913
Link:    https://acme.com/verify?t=abc

Your sign-in code is 482913. Or open https://acme.com/verify?t=abc
```

nid found the code and the link for you. To print only the code, add `--code`:

```sh
npx nid-inbox read ada@inbox.test --latest --code
```

```
482913
```

## Step 4: Read the email over HTTP

Everything the CLI does goes through the read API, which any language can call:

```sh
curl 'http://127.0.0.1:4400/api/messages?to=ada@inbox.test'
```

The answer is JSON with a `messages` list. It starts like this:

```json
{"messages":[{"id":1,"provider":"resend","from":"Acme <hello@acme.com>", ...
```

Each message has an `extracted` field with the `code` and `link` that nid found.

## Step 5: See what a mistake looks like

Send an email with no `from` field:

```sh
curl -X POST http://127.0.0.1:4400/emails \
  -H 'authorization: Bearer re_test' \
  -H 'content-type: application/json' \
  -d '{"to": "ada@inbox.test", "subject": "Hi", "text": "Hi"}'
```

nid refuses it with the same error the real Resend API returns:

```json
{"statusCode":422,"message":"Missing `from` field.","name":"validation_error"}
```

nid also keeps a record of the refused send. List it:

```sh
curl 'http://127.0.0.1:4400/api/rejections?to=ada@inbox.test'
```

You see the refused send, with the error nid returned and the body your request sent:

```json
{"rejections":[{"id":1,"provider":"resend","to":["ada@inbox.test"],"status":422,"error":"Missing `from` field.", ...
```

This is how nid explains a test that waited for an email that never came.

## Step 6: Send and read from code

Now do the same thing the way a real app and a real test would. Make a new folder and install two packages:

```sh
mkdir nid-tutorial && cd nid-tutorial
npm init -y
npm pkg set type=module
npm install resend @nid-inbox/client
```

- `resend` is the official Resend SDK (the library Resend publishes for calling its API). It plays the part of your app.
- `@nid-inbox/client` is the nid client library. It plays the part of your test.

Create a file called `signup.js`:

```js
import { Resend } from 'resend'
import { createInbox } from '@nid-inbox/client'

const inbox = createInbox({ url: 'http://127.0.0.1:4400' })
await inbox.start()

const email = inbox.address('signup')

const resend = new Resend('re_test_123')
await resend.emails.send({
  from: 'Acme <hello@acme.com>',
  to: email,
  subject: 'Confirm your email',
  html: '<p>Your verification code is <b>739104</b>.</p><p><a href="https://acme.com/confirm?t=xyz">Confirm</a></p>',
})

const message = await inbox.waitFor(email, { hasCode: true, timeout: 10 })
console.log(email)
console.log(message.code)
console.log(message.link)
```

Run it with `RESEND_BASE_URL` pointing at nid:

```sh
RESEND_BASE_URL=http://127.0.0.1:4400 node signup.js
```

You see something like:

```
signup.6aaee5fd@inbox.test
739104
https://acme.com/confirm?t=xyz
```

Here is what happened:

1. `inbox.start()` noted the newest message id, so older mail can never match.
2. `inbox.address('signup')` made up a fresh address. You do not create inboxes in nid. Any address works, and a random one means no other test shares it.
3. The Resend SDK read `RESEND_BASE_URL` and sent to nid instead of to Resend. The app code did not change.
4. `inbox.waitFor()` held one request open until the email arrived, then returned it with the code and link already pulled out. There is no polling loop and no sleep.

## Step 7: Stop nid

Go back to the first terminal and press Ctrl+C. nid stops, and because it kept mail in memory, the mail is gone. That is the default, so each run starts clean.

## What you learned

- `npx nid-inbox serve` starts nid on port 4400 for HTTP and 1025 for SMTP.
- Your app sends to nid by changing only its provider base URL.
- Any address is an inbox. Make up a new one per test.
- `waitFor` returns the next matching email, with `code` and `link` ready to use.
- Refused sends are kept, so you can see why an email never arrived.

## Next steps

- [Point your app at nid](../how-to/connect-your-app.md) for Brevo, SMTP and Python.
- [Read mail in tests](../how-to/read-mail-in-tests.md) for Playwright and other test runners.
- [Run nid](../how-to/run-nid.md) for Docker, CI and keeping mail across restarts.
