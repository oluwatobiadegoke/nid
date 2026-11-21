# See your mail in the web view

This guide shows how to read the emails your app sends, in a page that nid serves on your computer. Use it to check what your app sent, inspect headers and trigger webhooks.

The mail stays on your machine, and by default only your computer can open the page. See [Security](../explanation/security.md).

Before you start, [run nid](run-nid.md) and [point your app at it](connect-your-app.md).

## Open the web view

Open [http://127.0.0.1:4400](http://127.0.0.1:4400) in a browser. If you started nid on another port, use that port.

At the top of the page, `listening on 127.0.0.1:4400` means the page is connected. `reconnecting` or `not reachable` means nid has stopped. Start it again and the page reconnects.

If nid was started with `--token` or an `auth` hook, the page asks for your token and saves it in your browser session.

## Find an email

The list shows the newest mail first. Each row has:

- the address the email was sent to;
- how long ago it arrived;
- the subject;
- the provider it came through, such as `resend`, `ses`, `brevo` or `smtp`;
- the sign-in code, if nid found one.

New mail appears at the top without a refresh. Use the search box to filter by address, sender, subject, provider or error, and use **All**, **Messages** or **Rejections** to narrow the list.

## Read an email

Choose a row. The email opens with:

- **The header:** subject, From, To, Cc, Bcc, Reply to, the provider and its message id, and when it arrived.
- **Code and link:** the sign-in code and the main link nid found, shown first with **Copy** buttons. They appear only when nid found them.
- **Links and attachments:** every link in the email, except links that would run code, such as `javascript:`, and each attached file with a download link.
- **Tabs:** **Preview** renders the HTML in a sandboxed frame with remote and inline images enabled, scripts blocked, and a **Desktop** / **Mobile** width toggle. **Text** shows plain text. **Headers & Meta** shows email headers, tags and template variables. **Raw** shows the request as received.

Choose **All mail** on narrow screens to go back to the list.

## Simulate webhooks

When a webhook URL is set for the email's provider, the **Simulate webhook** section shows buttons for `delivered`, `deferred`, `bounced`, `complained`, `opened` and `clicked`. Choose one to send a signed event to your app and inspect its response status, timing and body.

## See why an email never arrived

When nid refuses a send, the refused send appears in the same list. Its row shows the status and the error, such as ``Rejected with 422: Missing `from` field.``, with the provider's name beside it.

Choose it to see the status, the error your app got back, and the request as received.

## Delete and clear

Choose **Delete** next to the subject to remove a single message.

Choose **Clear everything** in the top bar. The button then asks `Sure? Click again to clear`. Choose it again within four seconds to delete every message and every refused send.

## Turn the web view off

When you [embed nid](embed-nid.md), pass `ui: false` to `createServer`. The command line always serves the web view.

## Related

- [Read API reference](../reference/read-api.md), which the web view uses
- [How nid works](../explanation/how-nid-works.md)
