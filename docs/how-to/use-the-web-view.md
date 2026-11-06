# See your mail in the web view

This guide shows how to read the emails your app sends, in a page that nid serves on your computer. Use it to check what your app sent and how each email looks.

The mail stays on your machine, and by default only your computer can open the page. See [Security](../explanation/security.md).

Before you start, [run nid](run-nid.md) and [point your app at it](connect-your-app.md).

## Open the web view

Open [http://127.0.0.1:4400](http://127.0.0.1:4400) in a browser. If you started nid on another port, use that port.

At the top of the page, `listening on 127.0.0.1:4400` means the page is connected. `reconnecting` or `not reachable` means nid has stopped. Start it again and the page reconnects.

## Find an email

The list shows the newest mail first. Each row has:

- the address the email was sent to;
- how long ago it arrived;
- the subject;
- the provider it came through, such as `resend`, `brevo` or `smtp`;
- the sign-in code, if nid found one.

New mail appears at the top without a refresh. The count above the list reads, for example, `3 messages, 1 rejected`.

The web view has no search box. To find mail for one address, use the [command line](use-the-cli.md) or the [read API](../reference/read-api.md#get-apimessages).

## Read an email

Choose a row. The email opens with:

- **The header:** subject, From, To, Cc, Bcc, Reply to, the provider and its message id, and when it arrived.
- **Code and link:** the sign-in code and the main link nid found, shown first. They appear only when nid found them.
- **Links:** every link in the email, except links that would run code, such as `javascript:`.
- **HTML:** the email as a reader would see it. It is shown in a sandboxed frame with scripts blocked, so an email cannot run code on the page.
- **Text:** the plain text version.
- **Attachments:** each file, with a download link.
- **Template:** the template variables, when the app sent the email from a provider template.

To see exactly what your app sent, choose **Show the request as received**. It shows the request body your app sent to nid.

Choose **All mail** to go back to the list.

## See why an email never arrived

When nid refuses a send, the refused send appears in the same list. Its row shows the status and the error, such as ``Rejected with 422: Missing `from` field.``, with the provider's name beside it.

Choose it to see the status, the error your app got back, and the request as received. The error tells you what to fix, such as a missing field or a missing key.

## Clear the list

Choose **Clear everything**. The button then asks `Sure? Click again to clear`. Choose it again within four seconds to delete every message. If you wait, it goes back to normal and nothing is deleted.

Clearing does not delete refused sends. They stay in the list.

## Turn the web view off

When you [embed nid](embed-nid.md), pass `ui: false` to `createServer`. The command line always serves the web view.

## Related

- [Read API reference](../reference/read-api.md), which the web view uses
- [How nid works](../explanation/how-nid-works.md)
