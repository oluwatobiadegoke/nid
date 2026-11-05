# Use the command line

This guide shows how to read and clear mail from a terminal or a shell script with the `nid` command.

Before you start, [run nid](run-nid.md).

If `nid-inbox` is installed in your project, run the command as `npx nid`. Otherwise run it as `npx nid-inbox`. The examples below use `nid`.

## List mail for an address

```sh
nid read ada@inbox.test
```

Each line shows the message id, the time, the provider, the subject and the code if there is one:

```
#1  2026-11-05T20:33:43.061Z  resend  Your sign-in code  code 482913
```

nid lists up to 50 messages, newest first.

## Show the newest message

```sh
nid read ada@inbox.test --latest
```

## Get only the code or the links

```sh
nid read ada@inbox.test --latest --code
nid read ada@inbox.test --latest --links
```

`--code` prints only the code. `--links` prints one link per line. Both exit with code 1 when there is nothing to print, so a script can tell.

For example, to use the code in a shell script:

```sh
code=$(nid read ada@inbox.test --latest --code)
```

## Wait for the next email

```sh
nid read ada@inbox.test --wait 30
```

This waits up to 30 seconds for an email that arrives after you run the command, then prints it. Mail that was already there does not count. Add `--code` to wait for an email that has a code and print only the code.

## Get JSON

Add `--json` to any `read` command to get the full message as JSON, for use with tools such as `jq`:

```sh
nid read ada@inbox.test --latest --json | jq .extracted
```

## Clear mail

```sh
nid clear ada@inbox.test
nid clear
```

The first line clears one address. The second clears every message.

## Talk to a server on another port or machine

Pass `--url`, or set `NID_URL`:

```sh
nid read ada@inbox.test --url http://127.0.0.1:4500
NID_URL=http://127.0.0.1:4500 nid read ada@inbox.test
```

## Related

- [Command line reference](../reference/cli.md)
